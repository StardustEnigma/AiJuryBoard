import { SenderError, t } from 'spacetimedb/server';

import {
  DEFAULT_MAX_ROUNDS,
  EXPECTED_ROLE_BY_PHASE,
  JURY_ROLE,
  MESSAGE_STATUS,
  OPENING_ROLE,
  SESSION_PHASE,
  canAdvanceMessageStatus,
  isTerminalPhase,
  isValidMessageStatus,
  normalizeText,
  toCanonicalRole,
} from './lib';
import spacetimedb from './schema';

type JuryReducerCtx = {
  timestamp: unknown;
  sender: unknown;
  db: any;
};

function firstOrUndefined<T>(iterable: Iterable<T>): T | undefined {
  for (const row of iterable) {
    return row;
  }
  return undefined;
}

function requireSession(ctx: JuryReducerCtx, sessionId: bigint) {
  const session = ctx.db.jurySession.id.find(sessionId);
  if (!session) {
    throw new SenderError('Session not found');
  }
  return session as any;
}

function requireIdempotencyKey(value: string): string {
  const key = normalizeText(value);
  if (!key) {
    throw new SenderError('idempotencyKey is required');
  }
  return key;
}

function toCanonicalMessageStatus(value: string) {
  const normalized = normalizeText(value).toUpperCase().replace(/[\s-]+/g, '_');
  return isValidMessageStatus(normalized) ? normalized : undefined;
}

function findEvidenceByIdempotencyKey(ctx: JuryReducerCtx, idempotencyKey: string) {
  return firstOrUndefined(ctx.db.evidence.evidence_idempotency_key.filter(idempotencyKey));
}

function findMessageByIdempotencyKey(ctx: JuryReducerCtx, idempotencyKey: string) {
  return firstOrUndefined(ctx.db.message.message_idempotency_key.filter(idempotencyKey));
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string' && value.trim()) {
    return BigInt(value);
  }

  throw new SenderError('Invalid numeric value in session state');
}

function findMessageBySessionRoleAndRound(
  ctx: JuryReducerCtx,
  sessionId: bigint,
  role: (typeof JURY_ROLE)[keyof typeof JURY_ROLE],
  roundNumber: bigint
) {
  for (const row of ctx.db.message.message_session_id.filter(sessionId)) {
    const typed = row as any;
    if (toCanonicalRole(typed.role) === role && toBigInt(typed.roundNumber) === roundNumber) {
      return row;
    }
  }

  return undefined;
}

function findVerdictByIdempotencyKey(ctx: JuryReducerCtx, idempotencyKey: string) {
  return firstOrUndefined(ctx.db.verdict.verdict_idempotency_key.filter(idempotencyKey));
}

export default spacetimedb;

export const init = spacetimedb.init(() => {
  // No bootstrap data yet.
});

export const onConnect = spacetimedb.clientConnected(() => {
  // Reserved for future online presence tracking.
});

export const onDisconnect = spacetimedb.clientDisconnected(() => {
  // Reserved for future cleanup hooks.
});

export const createSession = spacetimedb.reducer(
  { topic: t.string(), maxRounds: t.u64().optional() },
  (ctx, { topic, maxRounds }) => {
    const normalizedTopic = normalizeText(topic);
    if (!normalizedTopic) {
      throw new SenderError('Topic is required');
    }

    const rounds = maxRounds ?? DEFAULT_MAX_ROUNDS;
    if (rounds < 1n) {
      throw new SenderError('maxRounds must be at least 1');
    }

    ctx.db.jurySession.insert({
      id: 0n,
      topic: normalizedTopic,
      status: SESSION_PHASE.DISCOVERY_PENDING,
      currentTurn: OPENING_ROLE,
      roundNumber: 0n,
      maxRounds: rounds,
      createdBy: ctx.sender,
      evidenceSnapshotId: undefined,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      verdictId: undefined,
    });
  }
);

export const startDebate = spacetimedb.reducer(
  { sessionId: t.u64() },
  (ctx, { sessionId }) => {
    const session = requireSession(ctx, sessionId);

    if (isTerminalPhase(session.status)) {
      throw new SenderError('Session is already terminal');
    }

    if (session.status !== SESSION_PHASE.DISCOVERY_PENDING) {
      throw new SenderError('Session has already moved beyond discovery');
    }

    ctx.db.jurySession.id.update({
      ...session,
      currentTurn: OPENING_ROLE,
      updatedAt: ctx.timestamp,
    });
  }
);

export const ingestEvidence = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    idempotencyKey: t.string(),
    source: t.string(),
    title: t.string(),
    content: t.string(),
    url: t.string().optional(),
  },
  (ctx, { sessionId, idempotencyKey, source, title, content, url }) => {
    const normalizedKey = requireIdempotencyKey(idempotencyKey);
    const existing = findEvidenceByIdempotencyKey(ctx, normalizedKey) as any | undefined;
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new SenderError('idempotencyKey already belongs to another session');
      }
      return;
    }

    const session = requireSession(ctx, sessionId);
    if (session.status !== SESSION_PHASE.DISCOVERY_PENDING) {
      throw new SenderError('Evidence can only be ingested during DISCOVERY_PENDING');
    }

    if (session.evidenceSnapshotId !== undefined) {
      throw new SenderError('Evidence snapshot already frozen for this session');
    }

    const normalizedSource = normalizeText(source);
    const normalizedTitle = normalizeText(title);
    const normalizedContent = content.trim();
    if (!normalizedSource || !normalizedTitle || !normalizedContent) {
      throw new SenderError('source, title, and content are required');
    }

    const evidence = ctx.db.evidence.insert({
      id: 0n,
      sessionId,
      idempotencyKey: normalizedKey,
      source: normalizedSource,
      title: normalizedTitle,
      content: normalizedContent,
      url,
      createdAt: ctx.timestamp,
    });

    ctx.db.jurySession.id.update({
      ...session,
      status: SESSION_PHASE.DISCOVERY_DONE,
      evidenceSnapshotId: evidence.id,
      currentTurn: JURY_ROLE.PROSECUTION,
      roundNumber: 1n,
      updatedAt: ctx.timestamp,
    });
  }
);

export const postArgument = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    idempotencyKey: t.string(),
    role: t.string(),
    content: t.string(),
  },
  (ctx, { sessionId, idempotencyKey, role, content }) => {
    const normalizedKey = requireIdempotencyKey(idempotencyKey);
    const existing = findMessageByIdempotencyKey(ctx, normalizedKey) as any | undefined;
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new SenderError('idempotencyKey already belongs to another session');
      }
      return;
    }

    const session = requireSession(ctx, sessionId);
    const canonicalRole = toCanonicalRole(role);
    if (!canonicalRole) {
      throw new SenderError('Invalid role, expected PROSECUTION, DEFENSE, or DEVILS_ADVOCATE');
    }

    const currentRound = toBigInt(session.roundNumber);
    const maxRounds = toBigInt(session.maxRounds ?? DEFAULT_MAX_ROUNDS);
    const messageRound = canonicalRole === JURY_ROLE.DEVILS_ADVOCATE ? currentRound + 1n : currentRound;

    const existingRoleMessage = findMessageBySessionRoleAndRound(
      ctx,
      sessionId,
      canonicalRole,
      messageRound
    ) as any | undefined;
    if (existingRoleMessage) {
      return;
    }

    if (isTerminalPhase(session.status)) {
      throw new SenderError('Session is terminal');
    }

    const expectedRole = EXPECTED_ROLE_BY_PHASE[session.status as keyof typeof EXPECTED_ROLE_BY_PHASE];
    if (!expectedRole) {
      throw new SenderError(`Session phase ${session.status} does not accept debate messages`);
    }

    if (canonicalRole !== expectedRole) {
      throw new SenderError(`Expected role ${expectedRole} for phase ${session.status}`);
    }

    if (session.evidenceSnapshotId === undefined) {
      throw new SenderError('Session has no frozen evidence snapshot');
    }

    const normalizedContent = content.trim();
    if (!normalizedContent) {
      throw new SenderError('Argument content is required');
    }

    ctx.db.message.insert({
      id: 0n,
      sessionId,
      idempotencyKey: normalizedKey,
      evidenceSnapshotId: session.evidenceSnapshotId,
      role: canonicalRole,
      messageStatus: MESSAGE_STATUS.DRAFT,
      sender: ctx.sender,
      content: normalizedContent,
      roundNumber: messageRound,
      createdAt: ctx.timestamp,
    });

    let nextStatus = session.status;
    let nextTurn = session.currentTurn;
    let nextRound = currentRound;

    if (canonicalRole === JURY_ROLE.PROSECUTION) {
      nextStatus = SESSION_PHASE.PROSECUTION_DONE;
      nextTurn = JURY_ROLE.DEFENSE;
    } else if (canonicalRole === JURY_ROLE.DEFENSE) {
      if (currentRound < maxRounds) {
        nextStatus = SESSION_PHASE.DISCOVERY_DONE;
        nextTurn = JURY_ROLE.PROSECUTION;
        nextRound = currentRound + 1n;
      } else {
        nextStatus = SESSION_PHASE.DEFENSE_DONE;
        nextTurn = JURY_ROLE.DEVILS_ADVOCATE;
      }
    } else {
      nextStatus = SESSION_PHASE.DEVILS_ADVOCATE_DONE;
      nextTurn = 'ANALYZING';
    }

    ctx.db.jurySession.id.update({
      ...session,
      status: nextStatus,
      currentTurn: nextTurn,
      roundNumber: nextRound,
      updatedAt: ctx.timestamp,
    });
  }
);

export const advanceMessageStatus = spacetimedb.reducer(
  {
    messageId: t.u64(),
    status: t.string(),
  },
  (ctx, { messageId, status }) => {
    const message = ctx.db.message.id.find(messageId);
    if (!message) {
      throw new SenderError('Message not found');
    }

    const currentStatus = toCanonicalMessageStatus(message.messageStatus);
    if (!currentStatus) {
      throw new SenderError('Message has an invalid current status');
    }

    const nextStatus = toCanonicalMessageStatus(status);
    if (!nextStatus) {
      throw new SenderError('Invalid status, expected DRAFT, VALIDATED, BROADCASTABLE, or SPOKEN');
    }

    if (!canAdvanceMessageStatus(currentStatus, nextStatus)) {
      throw new SenderError(`Cannot transition message status from ${currentStatus} to ${nextStatus}`);
    }

    if (currentStatus === nextStatus) {
      return;
    }

    ctx.db.message.id.update({
      ...message,
      messageStatus: nextStatus,
    });
  }
);

export const recordFallacyAlert = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    messageId: t.u64().optional(),
    source: t.string(),
    severity: t.string(),
    content: t.string(),
  },
  (ctx, { sessionId, messageId, source, severity, content }) => {
    requireSession(ctx, sessionId);

    if (messageId !== undefined) {
      const message = ctx.db.message.id.find(messageId);
      if (!message) {
        throw new SenderError('messageId does not exist');
      }
      if (message.sessionId !== sessionId) {
        throw new SenderError('messageId does not belong to the provided session');
      }
    }

    const normalizedSource = normalizeText(source);
    const normalizedSeverity = normalizeText(severity);
    const normalizedContent = content.trim();
    if (!normalizedSource || !normalizedSeverity || !normalizedContent) {
      throw new SenderError('source, severity, and content are required');
    }

    ctx.db.alert.insert({
      id: 0n,
      sessionId,
      messageId,
      source: normalizedSource,
      severity: normalizedSeverity,
      content: normalizedContent,
      createdAt: ctx.timestamp,
    });
  }
);

export const markAnalyzing = spacetimedb.reducer(
  { sessionId: t.u64() },
  (ctx, { sessionId }) => {
    const session = requireSession(ctx, sessionId);

    if (session.status === SESSION_PHASE.SYNTHESIS_PENDING) {
      return;
    }

    if (session.status !== SESSION_PHASE.DEVILS_ADVOCATE_DONE) {
      throw new SenderError('Session must be DEVILS_ADVOCATE_DONE before synthesis');
    }

    ctx.db.jurySession.id.update({
      ...session,
      status: SESSION_PHASE.SYNTHESIS_PENDING,
      currentTurn: 'SYNTHESIS',
      updatedAt: ctx.timestamp,
    });
  }
);

export const finalizeVerdict = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    idempotencyKey: t.string(),
    decision: t.string(),
    summary: t.string(),
  },
  (ctx, { sessionId, idempotencyKey, decision, summary }) => {
    const normalizedKey = requireIdempotencyKey(idempotencyKey);
    const existingByKey = findVerdictByIdempotencyKey(ctx, normalizedKey) as any | undefined;
    if (existingByKey) {
      if (existingByKey.sessionId !== sessionId) {
        throw new SenderError('idempotencyKey already belongs to another session');
      }
      return;
    }

    const session = requireSession(ctx, sessionId);
    if (session.status !== SESSION_PHASE.SYNTHESIS_PENDING) {
      throw new SenderError('Session must be SYNTHESIS_PENDING to finalize verdict');
    }

    if (session.evidenceSnapshotId === undefined) {
      throw new SenderError('Session has no evidence snapshot reference');
    }

    const existingBySession = firstOrUndefined(ctx.db.verdict.verdict_session_id.filter(sessionId));
    if (existingBySession) {
      throw new SenderError('Verdict already exists for this session');
    }

    const normalizedDecision = normalizeText(decision);
    const normalizedSummary = summary.trim();
    if (!normalizedDecision || !normalizedSummary) {
      throw new SenderError('decision and summary are required');
    }

    const verdict = ctx.db.verdict.insert({
      id: 0n,
      sessionId,
      evidenceSnapshotId: session.evidenceSnapshotId,
      idempotencyKey: normalizedKey,
      decision: normalizedDecision,
      summary: normalizedSummary,
      createdAt: ctx.timestamp,
    });

    ctx.db.jurySession.id.update({
      ...session,
      status: SESSION_PHASE.COMPLETED,
      currentTurn: SESSION_PHASE.COMPLETED,
      verdictId: verdict.id,
      updatedAt: ctx.timestamp,
    });
  }
);

export const failSession = spacetimedb.reducer(
  { sessionId: t.u64(), reason: t.string() },
  (ctx, { sessionId, reason }) => {
    const session = requireSession(ctx, sessionId);

    if (session.status === SESSION_PHASE.COMPLETED) {
      throw new SenderError('Completed sessions cannot be marked as failed');
    }

    if (session.status === SESSION_PHASE.FAILED) {
      return;
    }

    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new SenderError('reason is required');
    }

    ctx.db.alert.insert({
      id: 0n,
      sessionId,
      messageId: undefined,
      source: 'ORCHESTRATOR',
      severity: 'ERROR',
      content: normalizedReason,
      createdAt: ctx.timestamp,
    });

    ctx.db.jurySession.id.update({
      ...session,
      status: SESSION_PHASE.FAILED,
      currentTurn: SESSION_PHASE.FAILED,
      updatedAt: ctx.timestamp,
    });
  }
);
