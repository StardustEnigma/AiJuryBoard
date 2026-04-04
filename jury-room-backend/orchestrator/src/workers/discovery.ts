/**
 * Discovery Worker
 * Polls for DISCOVERY_PENDING sessions
 * Calls Tavily search
 * Writes evidence via ingestEvidence reducer
 */

import { SESSION_PHASE } from '../constants.js';
import { getConnection, DebateSession } from '../spacetime.js';
import { searchTavily } from '../utils/apis.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

export async function runDiscoveryWorker(intervalMs = 10000) {
  log('🔍', 'Discovery Worker started');
  let pollCount = 0;
  const inFlightSessions = new Set<string>();

  while (true) {
    try {
      const conn = getConnection();
      
      // Poll for sessions in DISCOVERY_PENDING status
      const sessions = await conn.db.jurySession.status.filter(SESSION_PHASE.DISCOVERY_PENDING);
      
      pollCount++;
      if (pollCount % 3 === 0) {
        log('🔍', `Poll #${pollCount}: Found ${sessions.length} sessions in DISCOVERY_PENDING`);
      }
      
      if (sessions.length === 0) {
        // No sessions to process
      } else {
        log('🔍', `Found ${sessions.length} session(s) to process`);
        for (const session of sessions) {
          const typedSession = session as DebateSession;
          const sessionKey = typedSession.id.toString();

          if (inFlightSessions.has(sessionKey)) {
            continue;
          }

          inFlightSessions.add(sessionKey);
          try {
            await processDiscoverySession(conn, typedSession);
          } finally {
            inFlightSessions.delete(sessionKey);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      logError('DISCOVERY', `Poll error: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function processDiscoverySession(conn: any, session: DebateSession) {
  const sessionId = session.id;
  const topic = session.topic;
  const idempotencyKey = generateIdempotencyKey(`discovery-${sessionId}`);

  try {
    log('🔍', `Processing session ${sessionId}: "${topic}"`);

    // Search for evidence on the topic
    const searchResults = await searchTavily(topic);

    const bestResult = searchResults.results[0];
    if (!bestResult) {
      throw new Error('Tavily returned no evidence results');
    }

    // ingestEvidence transitions DISCOVERY_PENDING -> DISCOVERY_DONE.
    await conn.reducers.ingestEvidence({
      sessionId,
      idempotencyKey,
      source: bestResult.url || 'Unknown',
      title: bestResult.title || 'Evidence Snapshot',
      content: bestResult.content || 'No content provided',
      url: bestResult.url,
    });

    logSuccess('🔍', `Ingested evidence and advanced session ${sessionId} to DISCOVERY_DONE`);

    await writeAuditLog({
      worker: 'discovery',
      sessionId: sessionId.toString(),
      topic,
      evidenceCount: searchResults.results.length,
      selectedEvidenceTitle: bestResult.title,
      status: 'completed',
      idempotencyKey,
    });
  } catch (error) {
    logError('DISCOVERY', `Failed to process session ${sessionId}: ${error}`);
    
    await writeAuditLog({
      worker: 'discovery',
      sessionId: sessionId.toString(),
      status: 'failed',
      error: String(error),
      idempotencyKey,
    });
  }
}
