/**
 * Prosecution Worker
 * Polls for DISCOVERY_DONE sessions
 * Calls LLM with prosecution prompt
 * Writes message via postArgument reducer
 */

import { JURY_ROLE, SESSION_PHASE, SESSION_TURN, toCanonicalRole } from '../constants.js';
import { getConnection, DebateSession, Evidence, Message } from '../spacetime.js';
import { callMixtral, clampToWords } from '../utils/apis.js';
import { gateGeneratedArgument } from '../utils/policy.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

function asBigInt(value: bigint | string | number | undefined): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) return BigInt(value);
  return 0n;
}

const PROSECUTION_PROMPT = `You are the Prosecutor in a debate.
Use plain English only.

Rules:
- Keep arguments connected across points.
- Explicitly reference at least one evidence item.
- Give exactly 3 points with 1-2 sentences each.
- Add one short closing line.

Format:
Point 1:
Point 2:
Point 3:
Closing:

Limit: 110 to 140 words total.`;

export async function runProsecutionWorker(intervalMs = 15000) {
  log('⚖️', 'Prosecution Worker started');
  const completedStages = new Set<string>();

  while (true) {
    try {
      const conn = getConnection();
      
      // Poll for sessions that just finished discovery
      const sessions = await conn.db.jurySession.currentTurn.filter(SESSION_TURN.PROSECUTION);
      
      if (sessions.length > 0) {
        for (const session of sessions) {
          const s = session as DebateSession;
          const roundNumber = typeof s.roundNumber === 'string' ? BigInt(s.roundNumber) : s.roundNumber;
          const maxRounds = typeof s.maxRounds === 'string' ? BigInt(s.maxRounds) : (s.maxRounds ?? 1n);
          const stageKey = `${s.id.toString()}:PROSECUTION:${roundNumber.toString()}`;

          if (completedStages.has(stageKey)) {
            continue;
          }

          // Process each prosecution turn while the session is in DISCOVERY_DONE.
          if (s.status === SESSION_PHASE.DISCOVERY_DONE && roundNumber > 0n && roundNumber <= maxRounds) {
            const completed = await processProsecutionSession(conn, s);
            if (completed) {
              completedStages.add(stageKey);
            }
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
  const roundNumber = typeof session.roundNumber === 'string' ? BigInt(session.roundNumber) : session.roundNumber;
  const idempotencyKey = generateIdempotencyKey(`prosecution-${sessionId}-${roundNumber.toString()}`);
  const topic = session.topic?.trim() || 'the current topic';

  try {
    log('⚖️', `Processing prosecution for session ${sessionId}, round ${roundNumber}`);

    const existingMessages = await conn.db.message.sessionId.filter(sessionId);
    const existingProsecution = existingMessages.find(
      (message: Message) =>
        toCanonicalRole(message.role) === JURY_ROLE.PROSECUTION &&
        asBigInt(message.roundNumber) === roundNumber
    );
    if (existingProsecution) {
      log('⚖️', `Skipping session ${sessionId}; prosecution round ${roundNumber} already exists`);
      return true;
    }

    const previousDefense = existingMessages
      .filter(
        (message: Message) =>
          toCanonicalRole(message.role) === JURY_ROLE.DEFENSE &&
            asBigInt(message.roundNumber) === roundNumber - 1n
      )
          .sort((a: Message, b: Message) => (asBigInt(a.id) < asBigInt(b.id) ? -1 : 1))
      .at(-1);

    // Fetch evidence for context
    const evidence = await conn.db.evidence.sessionId.filter(sessionId);
    const evidenceText = evidence
      .map((e: Evidence) => `[${e.source}] ${e.title}: ${e.content.substring(0, 200)}...`)
      .join('\n');

    const priorRoundContext = previousDefense
      ? `Prior defense response (round ${roundNumber - 1n}):\n${previousDefense.content}\n\n`
      : '';

    const systemPrompt = `${PROSECUTION_PROMPT}\n\nTopic: ${topic}\nDebate round: ${roundNumber.toString()} of ${asBigInt(session.maxRounds).toString()}\n\n${priorRoundContext}Evidence available:\n${evidenceText || 'No evidence snapshot available.'}`;
    const prosecutionArgRaw = await callMixtral(systemPrompt);
    const policyCheck = gateGeneratedArgument(JURY_ROLE.PROSECUTION, prosecutionArgRaw, 140);
    if (policyCheck.warnings.length > 0) {
      log('🛡️', `Prosecution output sanitized for session ${sessionId}: ${policyCheck.warnings.join(', ')}`);
    }

    const prosecutionArg = clampToWords(policyCheck.sanitizedText, 140);

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
      round: roundNumber.toString(),
      argumentLength: prosecutionArg.length,
      policyWarnings: policyCheck.warnings,
      policyReason: policyCheck.reason,
      status: 'completed',
      idempotencyKey,
    });
    return true;
  } catch (error) {
    logError('PROSECUTION', `Failed to process session ${sessionId}: ${error}`);
    
    await writeAuditLog({
      worker: 'prosecution',
      sessionId: sessionId.toString(),
      status: 'failed',
      error: String(error),
      idempotencyKey,
    });
    return false;
  }
}
