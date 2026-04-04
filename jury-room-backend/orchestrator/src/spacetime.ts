/**
 * SpacetimeDB WebSocket Client with Polling Fallback
 * Uses SDK subscriptions when available, falls back to reducer-based queries
 */

import { createRequire } from 'node:module';
import { toCanonicalRole } from './constants.js';

const require = createRequire(import.meta.url);

export interface DebateSession {
  id: bigint | string;
  topic: string;
  status: string;
  currentTurn: string;
  roundNumber: bigint | string;
  maxRounds?: bigint | string;
  evidenceSnapshotId?: bigint | string;
  verdictId?: bigint | string;
  createdAt?: bigint | string;
  updatedAt?: bigint | string;
}

export interface Message {
  id: bigint | string;
  sessionId: bigint | string;
  idempotencyKey?: string;
  evidenceSnapshotId?: bigint | string;
  role: string;
  messageStatus?: string;
  content: string;
  roundNumber?: bigint | string;
  createdAt?: bigint | string;
}

export interface Evidence {
  id: bigint | string;
  sessionId: bigint | string;
  idempotencyKey?: string;
  title: string;
  content: string;
  source: string;
  url?: string;
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
  FAILED = 'FAILED',
}

export let jurySessionCache: DebateSession[] = [];
export let messageCache: Message[] = [];
export let evidenceCache: Evidence[] = [];

let connection: any = null;
let reducerConnection: any = null;
let reducerConnectionReady: Promise<any> | null = null;
let moduleDbConnectionCtor: any = null;

function getModuleDbConnectionCtor(): any {
  if (moduleDbConnectionCtor) {
    return moduleDbConnectionCtor;
  }

  const moduleBindings = require('../../../ai-jury-frontend/src/module_bindings/index.js');
  if (!moduleBindings?.DbConnection) {
    throw new Error('Unable to load frontend SpacetimeDB module bindings DbConnection');
  }

  moduleDbConnectionCtor = moduleBindings.DbConnection;
  return moduleDbConnectionCtor;
}

function toReducerAccessor(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

async function ensureReducerConnection(uri: string, dbName: string): Promise<any> {
  if (reducerConnection) {
    return reducerConnection;
  }

  if (reducerConnectionReady) {
    return reducerConnectionReady;
  }

  reducerConnectionReady = new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Timed out connecting reducer SDK client to SpacetimeDB'));
    }, 15000);

    const ModuleDbConnection = getModuleDbConnectionCtor();
    const builder = ModuleDbConnection.builder()
      .withUri(uri)
      .withDatabaseName(dbName)
      .onConnect((conn: any, identity: any, token: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        reducerConnection = conn;
        if (!process.env.SPACETIME_AUTH_TOKEN) {
          process.env.SPACETIME_AUTH_TOKEN = token;
        }

        console.log(`✅ Reducer SDK connected as ${identity.toHexString().slice(0, 8)}...`);
        resolve(conn);
      })
      .onConnectError((_ctx: any, error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      })
      .onDisconnect((_ctx: any, error?: Error) => {
        reducerConnection = null;
        reducerConnectionReady = null;
        console.warn(`⚠️ Reducer SDK disconnected${error ? `: ${error.message}` : ''}`);
      });

    const existingToken = process.env.SPACETIME_AUTH_TOKEN;
    if (existingToken) {
      builder.withToken(existingToken);
    }

    builder.build();
  });

  try {
    return await reducerConnectionReady;
  } catch (error) {
    reducerConnectionReady = null;
    throw error;
  }
}

function toBigInt(value: unknown, fallback = 0n): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function parseRows(payload: any): any[] {
  if (Array.isArray(payload?.rows)) {
    return payload.rows;
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

function mapSessionRow(row: any): DebateSession {
  return {
    id: toBigInt(row.id),
    topic: String(row.topic ?? ''),
    status: String(row.status ?? ''),
    currentTurn: String(row.current_turn ?? row.currentTurn ?? ''),
    roundNumber: toBigInt(row.round_number ?? row.roundNumber),
    maxRounds: toBigInt(row.max_rounds ?? row.maxRounds),
    evidenceSnapshotId: row.evidence_snapshot_id ?? row.evidenceSnapshotId,
    verdictId: row.verdict_id ?? row.verdictId,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function mapMessageRow(row: any): Message {
  return {
    id: toBigInt(row.id),
    sessionId: toBigInt(row.session_id ?? row.sessionId),
    idempotencyKey: row.idempotency_key ?? row.idempotencyKey,
    evidenceSnapshotId: row.evidence_snapshot_id ?? row.evidenceSnapshotId,
    role: toCanonicalRole(String(row.role ?? '')),
    messageStatus: row.message_status ?? row.messageStatus,
    content: String(row.content ?? ''),
    roundNumber: toBigInt(row.round_number ?? row.roundNumber),
    createdAt: row.created_at ?? row.createdAt,
  };
}

function mapEvidenceRow(row: any): Evidence {
  return {
    id: toBigInt(row.id),
    sessionId: toBigInt(row.session_id ?? row.sessionId),
    idempotencyKey: row.idempotency_key ?? row.idempotencyKey,
    source: String(row.source ?? ''),
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    url: row.url,
    createdAt: row.created_at ?? row.createdAt,
  };
}

async function queryRows(endpoint: string, query: string): Promise<any[] | null> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json() as any;
  return parseRows(payload);
}

function readTableRows(tableView: any): any[] {
  try {
    if (!tableView || typeof tableView.iter !== 'function') {
      return [];
    }

    return Array.from(tableView.iter());
  } catch {
    return [];
  }
}

function syncCachesFromSdkConnection(sdkConn: any): void {
  const sessionRows = readTableRows(sdkConn?.db?.jurySession);
  const messageRows = readTableRows(sdkConn?.db?.message);
  const evidenceRows = readTableRows(sdkConn?.db?.evidence);

  jurySessionCache = sessionRows.map(mapSessionRow);
  messageCache = messageRows.map(mapMessageRow);
  evidenceCache = evidenceRows.map(mapEvidenceRow);
}

function startSdkSync(sdkConn: any): boolean {
  try {
    sdkConn
      .subscriptionBuilder()
      .onApplied(() => {
        syncCachesFromSdkConnection(sdkConn);
        console.log(
          `✅ SDK sync applied: ${jurySessionCache.length} sessions, ${messageCache.length} messages, ${evidenceCache.length} evidence rows`
        );
      })
      .onError((_ctx: any) => {
        console.warn('⚠️ SDK subscription error, continuing with periodic cache pulls');
      })
      .subscribeToAllTables();

    setInterval(() => {
      syncCachesFromSdkConnection(sdkConn);
    }, 3000);

    return true;
  } catch (error: any) {
    console.warn(`⚠️ Failed to start SDK sync: ${error?.message || error}`);
    return false;
  }
}

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

  const sdkConn = await ensureReducerConnection(uri, dbName);

  connection = {
    uri,
    dbName,
    async callReducer(name: string, args: any) {
      try {
        const sdkConn = await ensureReducerConnection(uri, dbName);
        const accessor = toReducerAccessor(name);
        const reducerFn = sdkConn?.reducers?.[accessor];

        if (typeof reducerFn !== 'function') {
          throw new Error(`Reducer accessor not found: ${accessor}`);
        }

        await reducerFn(args);

        console.log(`✅ Called reducer: ${name}`);
        return true;
      } catch (e: any) {
        console.error(`❌ Reducer error:`, e.message);
        throw e;
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
            const idVal = toBigInt(id, -1n);
            return messageCache.filter(m => {
              const mId = toBigInt(m.sessionId, -1n);
              return mId === idVal;
            });
          }
        },
        iter: () => messageCache
      },
      evidence: {
        sessionId: {
          filter: async (id: bigint | string) => {
            const idVal = toBigInt(id, -1n);
            return evidenceCache.filter(e => {
              const eId = toBigInt(e.sessionId, -1n);
              return eId === idVal;
            });
          }
        }
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

  // Sync data (SDK first, SQL fallback)
  const sdkSyncStarted = startSdkSync(sdkConn);
  if (!sdkSyncStarted) {
    startSync(uri, dbName);
  }

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
  const endpoints = [
    `${uri}/db/${dbName}/sql`,
    `${uri}/api/db/${dbName}/sql`,
    `${uri}/db/${dbName}/query`,
  ];

  const pollData = async () => {
    for (const endpoint of endpoints) {
      try {
        const sessionRows = await queryRows(endpoint, 'SELECT * FROM jury_session');
        if (!sessionRows) {
          continue;
        }

        const messageRows = await queryRows(endpoint, 'SELECT * FROM message');
        const evidenceRows = await queryRows(endpoint, 'SELECT * FROM evidence');

        jurySessionCache = sessionRows.map(mapSessionRow);
        if (messageRows) {
          messageCache = messageRows.map(mapMessageRow);
        }
        if (evidenceRows) {
          evidenceCache = evidenceRows.map(mapEvidenceRow);
        }

        console.log(
          `✅ Synced ${jurySessionCache.length} sessions, ${messageCache.length} messages, ${evidenceCache.length} evidence rows from ${endpoint}`
        );

        return true;
      } catch {
        // Try next endpoint
      }
    }

    return false;
  };

  // Initial poll
  void pollData();

  // Periodic polling
  setInterval(() => {
    void pollData();
  }, 3000);
}
