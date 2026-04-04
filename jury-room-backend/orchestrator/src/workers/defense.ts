/**
 * Defense Worker
 * Polls for PROSECUTION_DONE status
 * Calls LLM with defense prompt + prosecution message
 * Writes message via postArgument reducer
 */

import { JURY_ROLE, SESSION_PHASE, SESSION_TURN, toCanonicalRole } from '../constants.js';
import { getConnection, DebateSession, Message } from '../spacetime.js';
import { callMixtral } from '../utils/apis.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

const DEFENSE_PROMPT = `You are the Defense in a formal debate. Your role is to argue AGAINST the motion and defend the status quo or propose an alternative.
Rules:
- Be empathetic but rigorous
- Highlight weaknesses, unintended consequences, and risks in the prosecution's position
- Use evidence and logic to build counterarguments
- Acknowledge valid points from prosecution but explain why they don't override your position
- Focus on fairness, safety, and evidence-based reasoning
Generate your defense argument in 2-3 paragraphs.`;

export async function runDefenseWorker(intervalMs = 15000) {
  log('🛡️', 'Defense Worker started');

  while (true) {
    try {
      const conn = getConnection();
      
      // Poll for sessions where prosecution just finished
      const sessions = await conn.db.jurySession.currentTurn.filter(SESSION_TURN.DEFENSE);
      
      if (sessions.length > 0) {
        for (const session of sessions) {
          const s = session as DebateSession;
          if (s.status === SESSION_PHASE.PROSECUTION_DONE) {
            await processDefenseSession(conn, s);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      logError('DEFENSE', `${error}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function processDefenseSession(conn: any, session: DebateSession) {
  const sessionId = session.id;
  const roundNumber = session.roundNumber;
  const idempotencyKey = generateIdempotencyKey(`defense-${sessionId}`);

  try {
    log('🛡️', `Processing defense for session ${sessionId}, round ${roundNumber}`);

    // Fetch prosecution message for context
    const messages = await conn.db.message.sessionId.filter(sessionId);
    const prosecutionMsg = messages.find(
      (m: Message) => toCanonicalRole(m.role) === JURY_ROLE.PROSECUTION
    );
    const prosecutionContext = prosecutionMsg ? `Prosecution said:\n${prosecutionMsg.content}\n\n` : '';

    const systemPrompt = `${DEFENSE_PROMPT}\n\n${prosecutionContext}Generate your response now.`;
    const defenseArg = await callMixtral(systemPrompt);

    // Write via reducer
    await conn.reducers.postArgument({
      sessionId,
      idempotencyKey,
      role: JURY_ROLE.DEFENSE,
      content: defenseArg,
    });

    logSuccess('🛡️', `Defense argument posted for session ${sessionId}`);

    await writeAuditLog({
      worker: 'defense',
      sessionId: sessionId.toString(),
      round: roundNumber.toString(),
      argumentLength: defenseArg.length,
      status: 'completed',
      idempotencyKey,
    });
  } catch (error) {
    logError('DEFENSE', `Failed to process session ${sessionId}: ${error}`);
    
    await writeAuditLog({
      worker: 'defense',
      sessionId: sessionId.toString(),
      status: 'failed',
      error: String(error),
      idempotencyKey,
    });
  }
}
