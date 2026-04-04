/**
 * Prosecution Worker
 * Polls for DISCOVERY_DONE sessions
 * Calls LLM with prosecution prompt
 * Writes message via postArgument reducer
 */

import { JURY_ROLE, SESSION_PHASE, SESSION_TURN } from '../constants.js';
import { getConnection, DebateSession, Evidence } from '../spacetime.js';
import { callMixtral } from '../utils/apis.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

const PROSECUTION_PROMPT = `You are the Prosecutor in a formal debate. Your role is to argue STRONGLY in favor of the motion/thesis. 
Rules:
- Be aggressive and maximalist in your arguments
- Use logic, evidence, and precedent to support your position
- Do not concede any ground without rigorous counter-argument
- Focus on the strongest arguments that support your side
- Quote evidence when relevant
Generate your opening prosecution argument in 2-3 paragraphs.`;

export async function runProsecutionWorker(intervalMs = 15000) {
  log('⚖️', 'Prosecution Worker started');

  while (true) {
    try {
      const conn = getConnection();
      
      // Poll for sessions that just finished discovery
      const sessions = await conn.db.jurySession.currentTurn.filter(SESSION_TURN.PROSECUTION);
      
      if (sessions.length > 0) {
        for (const session of sessions) {
          const s = session as DebateSession;
          const roundNumber = typeof s.roundNumber === 'string' ? BigInt(s.roundNumber) : s.roundNumber;

          // Only process if status is DISCOVERY_DONE (after evidence ingestion)
          if (s.status === SESSION_PHASE.DISCOVERY_DONE && roundNumber === 1n) {
            await processProsecutionSession(conn, s);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      logError('PROSECUTION', `${error}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function processProsecutionSession(conn: any, session: DebateSession) {
  const sessionId = session.id;
  const idempotencyKey = generateIdempotencyKey(`prosecution-${sessionId}`);

  try {
    log('⚖️', `Processing prosecution for session ${sessionId}`);

    // Fetch evidence for context
    const evidence = await conn.db.evidence.sessionId.filter(sessionId);
    const evidenceText = evidence
      .map((e: Evidence) => `[${e.source}] ${e.title}: ${e.content.substring(0, 200)}...`)
      .join('\n');

    const systemPrompt = `${PROSECUTION_PROMPT}\n\nEvidence available:\n${evidenceText}`;
    const prosecutionArg = await callMixtral(systemPrompt);

    // Write via reducer
    await conn.reducers.postArgument({
      sessionId,
      idempotencyKey,
      role: JURY_ROLE.PROSECUTION,
      content: prosecutionArg,
    });

    logSuccess('⚖️', `Prosecution argument posted for session ${sessionId}`);

    await writeAuditLog({
      worker: 'prosecution',
      sessionId: sessionId.toString(),
      argumentLength: prosecutionArg.length,
      status: 'completed',
      idempotencyKey,
    });
  } catch (error) {
    logError('PROSECUTION', `Failed to process session ${sessionId}: ${error}`);
    
    await writeAuditLog({
      worker: 'prosecution',
      sessionId: sessionId.toString(),
      status: 'failed',
      error: String(error),
      idempotencyKey,
    });
  }
}
