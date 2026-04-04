/**
 * SpacetimeDB Client Utilities - Simplified Polling Approach
 */

export interface Evidence {
  id: bigint | string;
  sessionId: bigint | string;
  title: string;
  content: string;
  source: string;
  createdAt?: bigint | string;
}

export interface Verdict {
  id: bigint | string;
  sessionId: bigint | string;
  decision: string;
  summary: string;
  createdAt?: bigint | string;
}

export interface DebateSession {
  id: bigint | string;
  topic: string;
  status: string;
  currentTurn: string;
  roundNumber: bigint | string;
  createdAt?: bigint | string;
  updatedAt?: bigint | string;
}

export interface Message {
  id: bigint | string;
  sessionId: bigint | string;
  role: string;
  content: string;
  roundNumber?: bigint | string;
  createdAt?: bigint | string;
}

export enum SessionPhase {
  DISCOVERY_PENDING = 'DISCOVERY_PENDING',
  DISCOVERY_DONE = 'DISCOVERY_DONE',
  PROSECUTION_DONE = 'PROSECUTION_DONE',
  DEFENSE_DONE = 'DEFENSE_DONE',
  DEVILS_ADVOCATE_DONE = 'DEVILS_ADVOCATE_DONE',
  SYNTHESIS_PENDING = 'SYNTHESIS_PENDING',
  COMPLETED = 'COMPLETED',
}

let connection: any = null;
let jurySessionCache: DebateSession[] = [];
let messageCache: Message[] = [];

export async function initSpacetimeDB(): Promise<any> {
  if (connection) return connection;

  const uri = process.env.SPACETIME_URI || 'https://maincloud.spacetimedb.com';
  const dbName = process.env.SPACETIME_DB || 'ai-jury-board';

  console.log(`🔌 Connecting to SpacetimeDB at ${uri}/${dbName}...`);

  connection = {
    uri,
    dbName,
    async callReducer(name: string, args: any) {
      try {
        const response = await fetch(`${uri}/db/${dbName}/reducers/${name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        if (!response.ok) {
          console.error(`❌ Reducer ${name} returned ${response.status}`);
          return false;
        }
        console.log(`✅ Reducer ${name} succeeded`);
        return true;
      } catch (e: any) {
        console.error(`❌ Reducer ${name} error:`, e.message);
        return false;
      }
    },
    db: {
      jurySession: {
        status: {
          filter: async (status: string) => {
            const result = jurySessionCache.filter(s => s.status === status);
            console.log(`🔍 Filtering sessions by status="${status}": found ${result.length}`);
            return result;
          }
        },
        currentTurn: {
          filter: async (turn: string) => {
            const result = jurySessionCache.filter(s => s.currentTurn === turn);
            console.log(`🔍 Filtering sessions by turn="${turn}": found ${result.length}`);
            return result;
          }
        }
      },
      message: {
        sessionId: {
          filter: async (id: bigint | string) => {
            const idVal = typeof id === 'bigint' ? id : BigInt(id);
            return messageCache.filter(m => {
              const mId = typeof m.sessionId === 'bigint' ? m.sessionId : BigInt(m.sessionId);
              return mId === idVal;
            });
          }
        },
        iter: () => messageCache
      }
    },
    reducers: {
      startDebate: async (args: any) => connection.callReducer('start_debate', args),
      ingestEvidence: async (args: any) => connection.callReducer('ingest_evidence', args),
      postArgument: async (args: any) => connection.callReducer('post_argument', args),
      recordFallacyAlert: async (args: any) => connection.callReducer('record_fallacy_alert', args),
      finalizeVerdict: async (args: any) => connection.callReducer('finalize_verdict', args),
      markAnalyzing: async (args: any) => connection.callReducer('mark_analyzing', args),
    }
  };

  // Start syncing
  syncFromSpacetimeDB(uri, dbName);

  console.log('✅ Connected to SpacetimeDB');
  return connection;
}

export function getConnection(): any {
  if (!connection) throw new Error('SpacetimeDB not initialized');
  return connection;
}

async function syncFromSpacetimeDB(uri: string, dbName: string) {
  const doSync = async () => {
    try {
      // Try POST with JSON body
      const sqlUrl = `${uri}/db/${dbName}/sql`;
      console.log(`🔄 Attempting sync from ${sqlUrl}`);
      
      const response = await fetch(sqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT * FROM jury_session' }),
      });

      console.log(`📡 SQL endpoint returned status ${response.status}`);
      
      if (response.ok) {
        const data = await response.json() as any;
        jurySessionCache = (data.rows || []).map((row: any) => ({
          id: typeof row.id === 'string' ? BigInt(row.id) : row.id,
          topic: row.topic,
          status: row.status,
          currentTurn: row.current_turn || row.currentTurn,
          roundNumber: typeof row.round_number === 'string' ? BigInt(row.round_number) : row.round_number,
        }));
        console.log(`✅ Synced ${jurySessionCache.length} jury sessions`);
        return;
      } else {
        const errorText = await response.text();
        console.log(`❌ SQL endpoint error: ${response.status} - ${errorText.substring(0, 100)}`);
      }
    } catch (e: any) {
      console.log(`❌ Sync error: ${e.message}`);
    }
  };

  // Try initial sync
  await doSync();

  // Periodic resync every 2 seconds
  setInterval(doSync, 2000);
}
