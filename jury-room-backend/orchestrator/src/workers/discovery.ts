/**
 * Discovery Worker
 * Polls for DISCOVERY_PENDING sessions
 * Calls Tavily search
 * Writes evidence via ingestEvidence reducer
 */

import { SESSION_PHASE } from '../constants.js';
import { getConnection, DebateSession } from '../spacetime.js';
import { searchTavily } from '../utils/apis.js';
import { curateEvidenceSnapshot } from '../utils/evidence.js';
import { gateSearchTopic } from '../utils/policy.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

export async function runDiscoveryWorker(intervalMs = 10000) {
  log('🔍', 'Discovery Worker started');
  let pollCount = 0;
  const inFlightSessions = new Set<string>();
  const completedSessions = new Set<string>();

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

          if (completedSessions.has(sessionKey)) {
            continue;
          }

          inFlightSessions.add(sessionKey);
          try {
            const completed = await processDiscoverySession(conn, typedSession);
            if (completed) {
              completedSessions.add(sessionKey);
            }
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
  const idempotencyKey = generateIdempotencyKey(`discovery-${sessionId}-snapshot`);

  try {
    log('🔍', `Processing session ${sessionId}: "${topic}"`);

    const status = String(session.status || '').toUpperCase();
    if (status !== SESSION_PHASE.DISCOVERY_PENDING) {
      log('🔍', `Skipping session ${sessionId}; status moved to ${status}`);
      return true;
    }

    const existingEvidence = await conn.db.evidence.sessionId.filter(sessionId);
    if (existingEvidence.length > 0) {
      log('🔍', `Skipping session ${sessionId}; evidence already ingested`);
      return true;
    }

    const topicCheck = gateSearchTopic(topic);
    if (!topicCheck.allowed) {
      logError('DISCOVERY', `Policy blocked topic for session ${sessionId}: ${topicCheck.reason}`);
      await writeAuditLog({
        worker: 'discovery',
        sessionId: sessionId.toString(),
        topic,
        status: 'blocked',
        policyReason: topicCheck.reason,
        policyWarnings: topicCheck.warnings,
        idempotencyKey,
      });
      return true;
    }

    const safeTopic = topicCheck.sanitizedText;
    if (topicCheck.warnings.length > 0) {
      log('🛡️', `Discovery topic sanitized for session ${sessionId}: ${topicCheck.warnings.join(', ')}`);
    }

    // Search for evidence on the topic
    const primarySearch = await searchTavily(safeTopic);

    let combinedResults = [...primarySearch.results];
    try {
      const counterSearch = await searchTavily(`${safeTopic} opposing viewpoints criticism counter evidence`);
      combinedResults = [...combinedResults, ...counterSearch.results];
    } catch (error) {
      log('🔍', `Counter-view query unavailable, using primary evidence only: ${error}`);
    }

    const curated = curateEvidenceSnapshot(safeTopic, combinedResults, 3);
    if (curated.selected.length === 0) {
      throw new Error('Tavily returned no evidence results');
    }

    // ingestEvidence transitions DISCOVERY_PENDING -> DISCOVERY_DONE.
    await conn.reducers.ingestEvidence({
      sessionId,
      idempotencyKey,
      source: curated.source,
      title: curated.title,
      content: curated.content,
      url: curated.url,
    });

    logSuccess(
      '🔍',
      `Ingested curated evidence snapshot (${curated.selected.length} sources) and advanced session ${sessionId} to DISCOVERY_DONE`
    );

    await writeAuditLog({
      worker: 'discovery',
      sessionId: sessionId.toString(),
      topic,
      evidenceCount: combinedResults.length,
      selectedEvidenceTitle: curated.title,
      selectedEvidenceSources: curated.selected.map((result) => result.url),
      diversityReport: curated.diversityReport,
      policyWarnings: topicCheck.warnings,
      status: 'completed',
      idempotencyKey,
    });
    return true;
  } catch (error) {
    logError('DISCOVERY', `Failed to process session ${sessionId}: ${error}`);
    
    await writeAuditLog({
      worker: 'discovery',
      sessionId: sessionId.toString(),
      status: 'failed',
      error: String(error),
      idempotencyKey,
    });
    return false;
  }
}
