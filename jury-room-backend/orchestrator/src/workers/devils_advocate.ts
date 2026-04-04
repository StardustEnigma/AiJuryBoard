/**
 * Devil's Advocate Worker
 * Polls for DEFENSE_DONE status
 * Calls Claude as pragmatist/skeptic
 * Writes message via postArgument reducer
 */

import { getConnection, DebateSession, Message } from '../spacetime.js';
import { callLlamaLarge } from '../utils/apis.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

const DEVILS_ADVOCATE_PROMPT = `You are the Devil's Advocate in a formal debate. Your role is NOT to take sides, but to act as a pragmatist/skeptic.
Rules:
- Identify logical gaps and unstated assumptions in both prosecution and defense
- Ask "what if?" questions that probe edge cases
- Point out missing evidence or alternative interpretations
- Focus on empirical reality over ideology
- Suggest ways both sides could be wrong or incomplete
- Do NOT advocate for either side - instead surface the hidden complexities
Generate your devil's advocate critique in 2-3 paragraphs.`;

export async function runDevilsAdvocateWorker(intervalMs = 20000) {
  log('😈', "Devil's Advocate Worker started");

  while (true) {
    try {
      const conn = getConnection();
      
      // Poll for sessions where defense just finished
      const sessions = await conn.db.jurySession.currentTurn.filter('DEVILS_ADVOCATE');
      
      if (sessions.length > 0) {
        for (const session of sessions) {
          const s = session as DebateSession;
          const roundNum = typeof s.roundNumber === 'string' ? BigInt(s.roundNumber) : s.roundNumber;
          if (s.status === 'DEFENSE_DONE' && roundNum > 0n) {
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
    const prosecutionMsg = messages.find((m: Message) => m.role === 'prosecution');
    const defenseMsg = messages.find((m: Message) => m.role === 'defense');

    const prosecutionContext = prosecutionMsg ? `PROSECUTION:\n${prosecutionMsg.content}\n\n` : '';
    const defenseContext = defenseMsg ? `DEFENSE:\n${defenseMsg.content}\n\n` : '';

    const systemPrompt = `${DEVILS_ADVOCATE_PROMPT}\n\n${prosecutionContext}${defenseContext}Generate your critique now.`;
    const critiqe = await callLlamaLarge(systemPrompt);

    // Write via reducer
    await conn.reducers.postArgument({
      sessionId,
      role: 'devil_advocate',
      content: critiqe,
    });

    logSuccess('😈', `Devil's advocate critique posted for session ${sessionId}`);

    await writeAuditLog({
      worker: 'devils_advocate',
      sessionId: sessionId.toString(),
      action: 'devils_advocate_critique_generated',
      idempotencyKey,
      success: true,
    });
  } catch (error) {
    logError('DEVILS_ADVOCATE', `Failed to process session ${sessionId}: ${error}`);
  }
}
