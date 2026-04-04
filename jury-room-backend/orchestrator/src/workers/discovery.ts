/**
 * Discovery Worker
 * Polls for DISCOVERY_PENDING sessions
 * Calls Tavily search
 * Writes evidence via ingestEvidence reducer
 */

import { getConnection, SessionPhase, DebateSession } from '../spacetime.js';
import { searchTavily } from '../utils/apis.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

export async function runDiscoveryWorker(intervalMs = 10000) {
  log('🔍', 'Discovery Worker started');
  let pollCount = 0;

  while (true) {
    try {
      const conn = getConnection();
      
      // Poll for sessions in DISCOVERY_PENDING status
      const sessions = await conn.db.jurySession.status.filter('DISCOVERY_PENDING');
      
      pollCount++;
      if (pollCount % 3 === 0) {
        log('🔍', `Poll #${pollCount}: Found ${sessions.length} sessions in DISCOVERY_PENDING`);
      }
      
      if (sessions.length === 0) {
        // No sessions to process
      } else {
        log('🔍', `Found ${sessions.length} session(s) to process`);
        for (const session of sessions) {
          await processDiscoverySession(conn, session as DebateSession);
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

    // Write evidence entries via reducer
    for (const result of searchResults.results.slice(0, 5)) {
      try {
        await conn.reducers.ingestEvidence({
          sessionId,
          source: result.url || 'Unknown',
          title: result.title,
          content: result.content,
          url: result.url,
        });

        logSuccess('🔍', `Ingested evidence: "${result.title}"`);
      } catch (error) {
        logError('DISCOVERY', `Failed to ingest evidence: ${error}`);
      }
    }

    // Transition to discovery_done
    await conn.reducers.startDebate({ sessionId });
    logSuccess('🔍', `Session ${sessionId} transitioned to DISCOVERY_DONE`);

    await writeAuditLog({
      worker: 'discovery',
      sessionId: sessionId.toString(),
      topic,
      evidenceCount: searchResults.results.length,
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
