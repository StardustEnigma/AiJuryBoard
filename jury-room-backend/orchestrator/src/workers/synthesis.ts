/**
 * Synthesis Worker
 * Polls for SYNTHESIS_PENDING status
 * Calls Gemini to synthesize "Shared Reality"
 * Writes verdict via finalizeVerdict reducer
 * Stores in MongoDB for public record
 */

import { MongoClient, Db } from 'mongodb';
import { SESSION_PHASE } from '../constants.js';
import { getConnection, DebateSession, Message, Evidence } from '../spacetime.js';
import { callLlamaLarge } from '../utils/apis.js';
import { log, logSuccess, logError, generateIdempotencyKey, writeAuditLog } from '../utils/logger.js';

let mongoDb: Db | null = null;

async function getMongoDb(): Promise<Db> {
  if (mongoDb) return mongoDb;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  log('📊', 'Connecting to MongoDB...');
  const client = new MongoClient(uri);
  await client.connect();
  mongoDb = client.db('ai-jury');
  logSuccess('📊', 'Connected to MongoDB');
  return mongoDb;
}

const SYNTHESIS_PROMPT = `You are the Neutral Analyst in a formal debate. Your task is to synthesize the arguments and identify the "Shared Reality" - the points where both sides acknowledge truth, even if they disagree on implications.

Analyze the debate and provide:
1. PROSECUTION_SUMMARY: The core argument from the prosecution side
2. DEFENSE_SUMMARY: The core argument from the defense side
3. DEVIL_ADVOCATE_ANALYSIS: Key questions or gaps identified
4. SHARED_REALITY: Points where both sides would agree, or universal principles that apply
5. REMAINING_DISAGREEMENT: Where the true disagreement lies (values, priorities, empirical facts)
6. VERDICT: Your assessment of the stronger position based on evidence and logic

Be objective, neutral, and grounded in the evidence presented.`;

export async function runSynthesisWorker(intervalMs = 30000) {
  log('✨', 'Synthesis Worker started');

  while (true) {
    try {
      const conn = getConnection();
      
      // Poll for sessions ready for synthesis after markAnalyzing.
      const sessions = await conn.db.jurySession.status.filter(SESSION_PHASE.SYNTHESIS_PENDING);
      
      if (sessions.length > 0) {
        for (const session of sessions) {
          await processSynthesisSession(conn, session as DebateSession);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      logError('SYNTHESIS', `${error}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function processSynthesisSession(conn: any, session: DebateSession) {
  const sessionId = session.id;
  const idempotencyKey = generateIdempotencyKey(`synthesis-${sessionId}`);

  try {
    log('✨', `Processing synthesis for session ${sessionId}`);

    // Fetch all messages and evidence
    const messages = await conn.db.message.sessionId.filter(sessionId);
    const evidence = await conn.db.evidence.sessionId.filter(sessionId);

    if (messages.length === 0) {
      logError('SYNTHESIS', `No messages found for session ${sessionId}`);
      return;
    }

    // Build debate summary
    const debateSummary = messages
      .map(
        (m: Message) =>
          `[${m.role.toUpperCase()}]: ${m.content}`
      )
      .join('\n\n');

    const evidenceSummary = evidence
      .map((e: Evidence) => `[${e.source}] ${e.title}: ${e.content.substring(0, 200)}...`)
      .join('\n');

    const synthesisPrompt = `${SYNTHESIS_PROMPT}

DEBATE SUMMARY:
${debateSummary}

EVIDENCE AVAILABLE:
${evidenceSummary}`;

    // Call Llama 70B to synthesize
    const synthesis = await callLlamaLarge(synthesisPrompt);

    // Parse synthesis (simple extraction)
    const verdict = synthesis.split('VERDICT:')[1]?.trim() || synthesis.substring(0, 500);

    // Write verdict via reducer
    await conn.reducers.finalizeVerdict({
      sessionId,
      idempotencyKey,
      decision: verdict,
      summary: synthesis,
    });

    logSuccess('✨', `Verdict finalized for session ${sessionId}`);

    // Store in MongoDB for public record
    const db = await getMongoDb();
    await db.collection('verdicts').insertOne({
      sessionId: sessionId.toString(),
      topic: session.topic,
      synthesis,
      verdict,
      messageCount: messages.length,
      evidenceCount: evidence.length,
      createdAt: new Date(),
    });

    logSuccess('📊', `Verdict stored in MongoDB for session ${sessionId}`);

    await writeAuditLog({
      worker: 'synthesis',
      sessionId: sessionId.toString(),
      synthesisLength: synthesis.length,
      messageCount: messages.length,
      evidenceCount: evidence.length,
      status: 'completed',
      idempotencyKey,
    });
  } catch (error) {
    logError('SYNTHESIS', `Failed to process session ${sessionId}: ${error}`);
    
    await writeAuditLog({
      worker: 'synthesis',
      sessionId: sessionId.toString(),
      status: 'failed',
      error: String(error),
      idempotencyKey,
    });
  }
}
