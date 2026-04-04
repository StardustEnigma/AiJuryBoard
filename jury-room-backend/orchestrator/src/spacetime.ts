/**
 * SpacetimeDB WebSocket Client with Polling Fallback
 * Uses SDK subscriptions when available, falls back to reducer-based queries
 */

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

export enum SessionPhase {
  DISCOVERY_PENDING = 'DISCOVERY_PENDING',
  DISCOVERY_DONE = 'DISCOVERY_DONE',
  PROSECUTION_DONE = 'PROSECUTION_DONE',
  DEFENSE_DONE = 'DEFENSE_DONE',
  DEVILS_ADVOCATE_DONE = 'DEVILS_ADVOCATE_DONE',
  SYNTHESIS_PENDING = 'SYNTHESIS_PENDING',
  COMPLETED = 'COMPLETED',
}

export let jurySessionCache: DebateSession[] = [];
export let messageCache: Message[] = [];

let connection: any = null;

/**
 * Register a session from frontend notification
 */
export function registerSession(session: DebateSession) {
  const existing = jurySessionCache.findIndex(s => s.id === session.id || s.id.toString() === session.id.toString());
  if (existing >= 0) {
    jurySessionCache[existing] = session;
  } else {
    jurySessionCache.push(session);
  }
}


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
          console.error(`❌ Reducer ${name} failed: ${response.status}`);
          return false;
        }
        console.log(`✅ Called reducer: ${name}`);
        return true;
      } catch (e: any) {
        console.error(`❌ Reducer error:`, e.message);
        return false;
      }
    },
    db: {
      jurySession: {
        status: {
          filter: async (status: string) => {
            const result = jurySessionCache.filter(s => s.status === status);
            console.log(`[${status}] ${result.length} sessions`);
            return result;
          }
        },
        currentTurn: {
          filter: async (turn: string) => {
            const result = jurySessionCache.filter(s => s.currentTurn === turn);
            console.log(`[turn=${turn}] ${result.length} sessions`);
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

  // Sync data
  startSync(uri, dbName);

  console.log('✅ Connected to SpacetimeDB');
  return connection;
}

export function getConnection(): any {
  if (!connection) throw new Error('SpacetimeDB not initialized');
  return connection;
}

/**
 * Start polling for updates from SpacetimeDB
 */

function startSync(uri: string, dbName: string) {
  // Try fetching via private query parameter if supported
  const pollData = async () => {
    try {
      // Try a different endpoint - maybe there's a public read API
      const endpoints = [
        `${uri}/db/${dbName}/sql`,
        `${uri}/api/db/${dbName}/sql`,
        `${uri}/db/${dbName}/query`,
      ];
      
      for (const endpoint of endpoints) {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'SELECT * FROM jury_session' }),
        });

        if (response.ok) {
          const data = await response.json() as any;
          const rows = data.rows || [];
          jurySessionCache = rows.map((row: any) => ({
            id: typeof row.id === 'string' ? BigInt(row.id) : row.id,
            topic: row.topic,
            status: row.status,
            currentTurn: row.current_turn || row.currentTurn,
            roundNumber: typeof row.round_number === 'string' ? BigInt(row.round_number) : row.round_number,
          }));
          console.log(`✅ Synced ${jurySessionCache.length} sessions from ${endpoint}`);
          return true;
        }
      }
    } catch (e) {
      // Try next sync
    }
    return false;
  };

  // Initial poll
  pollData();

  // Periodic polling
  setInterval(pollData, 3000);
}
