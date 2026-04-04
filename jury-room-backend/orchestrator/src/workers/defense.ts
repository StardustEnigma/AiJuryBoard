/**
 * Defense Worker
 * Polls for PROSECUTION_DONE status
 * Calls LLM with defense prompt + prosecution message
 * Writes message via postArgument reducer
 */

import { JURY_ROLE, SESSION_PHASE, SESSION_TURN, toCanonicalRole } from '../constants.js';
import { getConnection, DebateSession, Message } from '../spacetime.js';
import { callMixtral, clampToWords } from '../utils/apis.js';
import { gateGeneratedArgument } from '../utils/policy.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

const DEFENSE_PROMPT = `You are the Defense in a debate.
Use plain English only.

Rules:
- Keep the flow connected and directly reply to prosecution claims.
- Give exactly 3 counterpoints with 1-2 sentences each.
- Include one practical risk or tradeoff example.
- Add one short closing line.

Format:
Counterpoint 1:
Counterpoint 2:
Counterpoint 3:
Closing:

Limit: 110 to 140 words total.`;

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
    const defenseArgRaw = await callMixtral(systemPrompt);
    const policyCheck = gateGeneratedArgument(JURY_ROLE.DEFENSE, defenseArgRaw, 140);
    if (policyCheck.warnings.length > 0) {
      log('🛡️', `Defense output sanitized for session ${sessionId}: ${policyCheck.warnings.join(', ')}`);
    }

    const defenseArg = clampToWords(policyCheck.sanitizedText, 140);

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
      policyWarnings: policyCheck.warnings,
      policyReason: policyCheck.reason,
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
