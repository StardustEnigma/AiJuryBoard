/**
 * SpacetimeDB Client Utilities
 * Handles connection and phase polling
 */

export interface Evidence {
  id: bigint;
  sessionId: bigint;
  title: string;
  content: string;
  source: string;
  createdAt: bigint;
}

export interface Message {
  id: bigint;
  sessionId: bigint;
  role: string;
  content: string;
  roundNumber: bigint;
  createdAt: bigint;
}

export interface Verdict {
  id: bigint;
  sessionId: bigint;
  decision: string;
  summary: string;
  createdAt: bigint;
}

export interface Alert {
  id: bigint;
  messageId: bigint;
  fallacyType: string;
  severity: string;
  explanation: string;
  createdAt: bigint;
}

export interface DebateSession {
  id: bigint;
  topic: string;
  status: string;
  currentTurn: string;
  roundNumber: bigint;
  createdAt: bigint;
  updatedAt: bigint;
}

export enum SessionPhase {
  DISCOVERY_PENDING = 'DISCOVERY_PENDING',
  DISCOVERY_DONE = 'DISCOVERY_DONE',
  PROSECUTION_PENDING = 'PROSECUTION_PENDING',
  PROSECUTION_DONE = 'PROSECUTION_DONE',
  DEFENSE_PENDING = 'DEFENSE_PENDING',
  DEFENSE_DONE = 'DEFENSE_DONE',
  DEVILS_ADVOCATE_PENDING = 'DEVILS_ADVOCATE_PENDING',
  DEVILS_ADVOCATE_DONE = 'DEVILS_ADVOCATE_DONE',
  ANALYZING = 'ANALYZING',
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

  try {
    // Create a polling-based connection using REST API for reducers
    connection = {
      uri,
      dbName,
      async callReducer(name: string, args: any) {
        try {
          const response = await fetch(`${uri}/db/${dbName}/reducers/${name}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(args),
          });
          if (!response.ok) {
            console.error(`❌ Reducer ${name} failed: ${response.status}`);
            return false;
          }
          return true;
        } catch (e) {
          console.error(`❌ Error calling reducer ${name}:`, e);
          return false;
        }
      },
      db: {
        jurySession: { 
          currentTurn: { 
            filter: async (turn: string) => {
              return jurySessionCache.filter(s => s.currentTurn === turn);
            } 
          }, 
          status: { 
            filter: async (status: string) => {
              return jurySessionCache.filter(s => s.status === status);
            } 
          } 
        },
        message: { 
          sessionId: { 
            filter: async (id: bigint) => {
              return messageCache.filter(m => m.sessionId === id);
            } 
          },
          iter: () => messageCache
        },
        evidence: { 
          sessionId: { 
            filter: async (id: bigint) => [] 
          } 
        },
        alert: { 
          sessionId: { 
            filter: async (id: bigint) => [] 
          } 
        },
      },
      reducers: {
        postArgument: async (args: any) => {
          return connection.callReducer('post_argument', args);
        },
        ingestEvidence: async (args: any) => {
          return connection.callReducer('ingest_evidence', args);
        },
        recordFallacyAlert: async (args: any) => {
          return connection.callReducer('record_fallacy_alert', args);
        },
        startDebate: async (args: any) => {
          return connection.callReducer('start_debate', args);
        },
        finalizeVerdict: async (args: any) => {
          return connection.callReducer('finalize_verdict', args);
        },
        markAnalyzing: async (args: any) => {
          return connection.callReducer('mark_analyzing', args);
        },
      },
    };

    // Start syncing session data from SpacetimeDB
    await syncFromSpacetimeDB();

    console.log('✅ Connected to SpacetimeDB');
    return connection;
  } catch (error) {
    console.error('❌ Failed to connect to SpacetimeDB:', error);
    throw error;
  }
}

export function getConnection(): any {
  if (!connection) throw new Error('SpacetimeDB not initialized. Call initSpacetimeDB() first.');
  return connection;
}

async function syncFromSpacetimeDB() {
  const uri = process.env.SPACETIME_URI || 'https://maincloud.spacetimedb.com';
  const dbName = process.env.SPACETIME_DB || 'ai-jury-board';

  try {
    // Try to fetch all JurySessions via direct endpoint
    const endpoint = `${uri}/tables/jury_session`;
    const response = await fetch(endpoint);
    
    if (response.ok) {
      const data = await response.json() as any;
      jurySessionCache = data || [];
      // Convert string IDs to bigint if needed
      jurySessionCache = jurySessionCache.map((s: any) => ({
        ...s,
        id: typeof s.id === 'string' ? BigInt(s.id) : s.id,
        roundNumber: typeof s.roundNumber === 'string' ? BigInt(s.roundNumber) : s.roundNumber,
      }));
      console.log(`✅ Synced ${jurySessionCache.length} sessions from SpacetimeDB`);
    }
  } catch (e) {
    // Endpoint not available, will retry on next sync cycle
    console.log('ℹ️  SpacetimeDB sync endpoint not available yet, will retry...');
  }

  // Set up periodic resync
  setInterval(async () => {
    try {
      const endpoint = `${uri}/tables/jury_session`;
      const response = await fetch(endpoint);
      
      if (response.ok) {
        const data = await response.json() as any;
        const newData = (data || []).map((s: any) => ({
          ...s,
          id: typeof s.id === 'string' ? BigInt(s.id) : s.id,
          roundNumber: typeof s.roundNumber === 'string' ? BigInt(s.roundNumber) : s.roundNumber,
        }));
        
        // Only update if changed
        if (JSON.stringify(newData) !== JSON.stringify(jurySessionCache)) {
          jurySessionCache = newData;
          console.log(`🔄 Synced ${jurySessionCache.length} sessions`);
        }
      }
    } catch (e) {
      // Silent fail, continue polling
    }
  }, 5000); // Sync every 5 seconds
}
