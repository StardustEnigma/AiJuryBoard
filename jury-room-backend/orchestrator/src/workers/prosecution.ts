/**
 * Prosecution Worker
 * Polls for DISCOVERY_DONE sessions
 * Calls LLM with prosecution prompt
 * Writes message via postArgument reducer
 */

import { JURY_ROLE, SESSION_PHASE, SESSION_TURN } from '../constants.js';
import { getConnection, DebateSession, Evidence } from '../spacetime.js';
import { callMixtral, clampToWords } from '../utils/apis.js';
import { gateGeneratedArgument } from '../utils/policy.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

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
      argumentLength: prosecutionArg.length,
      policyWarnings: policyCheck.warnings,
      policyReason: policyCheck.reason,
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
