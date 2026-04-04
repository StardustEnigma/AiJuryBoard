/**
 * Devil's Advocate Worker
 * Polls for DEFENSE_DONE status
 * Calls LLM as pragmatist/skeptic
 * Writes message via postArgument reducer
 */

import { JURY_ROLE, SESSION_PHASE, SESSION_TURN, toCanonicalRole } from '../constants.js';
import { getConnection, DebateSession, Message } from '../spacetime.js';
import { callLlamaLarge, clampToWords } from '../utils/apis.js';
import { gateGeneratedArgument } from '../utils/policy.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

const DEVILS_ADVOCATE_PROMPT = `You are the Devil's Advocate.
Do not take sides. Use simple language.

Rules:
- Connect each gap to something both sides already said.
- Use concise but complete sentences.
- List exactly 3 weak points.
- Ask 1 practical "what if" question.

Format:
Gap 1:
Gap 2:
Gap 3:
Question:

Limit: 90 to 120 words total.`;

export async function runDevilsAdvocateWorker(intervalMs = 20000) {
  log('😈', "Devil's Advocate Worker started");

  while (true) {
    try {
      const conn = getConnection();
      
      // Poll for sessions where defense just finished
      const sessions = await conn.db.jurySession.currentTurn.filter(SESSION_TURN.DEVILS_ADVOCATE);
      
      if (sessions.length > 0) {
        for (const session of sessions) {
          const s = session as DebateSession;
          const roundNum = typeof s.roundNumber === 'string' ? BigInt(s.roundNumber) : s.roundNumber;
          if (s.status === SESSION_PHASE.DEFENSE_DONE && roundNum > 0n) {
            await processDevilsAdvocateSession(conn, s);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      logError("DEVIL'S_ADVOCATE", `${error}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function processDevilsAdvocateSession(conn: any, session: DebateSession) {
  const sessionId = session.id;
  const roundNumber = session.roundNumber;
  const idempotencyKey = generateIdempotencyKey(`devils_advocate-${sessionId}`);

  try {
    log('😈', `Processing devil's advocate for session ${sessionId}, round ${roundNumber}`);

    // Fetch both prosecution and defense messages
    const messages = await conn.db.message.sessionId.filter(sessionId);
    const prosecutionMsg = messages.find(
      (m: Message) => toCanonicalRole(m.role) === JURY_ROLE.PROSECUTION
    );
    const defenseMsg = messages.find(
      (m: Message) => toCanonicalRole(m.role) === JURY_ROLE.DEFENSE
    );

    const prosecutionContext = prosecutionMsg ? `PROSECUTION:\n${prosecutionMsg.content}\n\n` : '';
    const defenseContext = defenseMsg ? `DEFENSE:\n${defenseMsg.content}\n\n` : '';

    const systemPrompt = `${DEVILS_ADVOCATE_PROMPT}\n\n${prosecutionContext}${defenseContext}Generate your critique now.`;
    const critiqueRaw = await callLlamaLarge(systemPrompt);
    const policyCheck = gateGeneratedArgument(JURY_ROLE.DEVILS_ADVOCATE, critiqueRaw, 120);
    if (policyCheck.warnings.length > 0) {
      log('🛡️', `Devil's advocate output sanitized for session ${sessionId}: ${policyCheck.warnings.join(', ')}`);
    }

    const critique = clampToWords(policyCheck.sanitizedText, 120);

    // Write via reducer
    await conn.reducers.postArgument({
      sessionId,
      idempotencyKey,
      role: JURY_ROLE.DEVILS_ADVOCATE,
      content: critique,
    });

    await conn.reducers.markAnalyzing({ sessionId });

    logSuccess('😈', `Devil's advocate critique posted for session ${sessionId}`);

    await writeAuditLog({
      worker: 'devils_advocate',
      sessionId: sessionId.toString(),
      action: 'devils_advocate_critique_generated',
      policyWarnings: policyCheck.warnings,
      policyReason: policyCheck.reason,
      idempotencyKey,
      success: true,
    });
  } catch (error) {
    logError('DEVILS_ADVOCATE', `Failed to process session ${sessionId}: ${error}`);
  }
}
