import { SenderError, t } from 'spacetimedb/server';

import spacetimedb from './schema';
import {
  DEFAULT_MAX_ROUNDS,
  OPENING_ROLE,
  isValidRole,
  nextRole,
  normalizeText,
} from './lib';

type JurySessionRow = {
  id: bigint;
  topic: string;
  status: string;
  currentTurn: string;
  roundNumber: bigint;
  maxRounds: bigint;
  createdBy: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  verdictId?: bigint;
};

type JuryReducerCtx = {
  timestamp: unknown;
  sender: unknown;
  db: any;
};

function requireSession(ctx: JuryReducerCtx, sessionId: bigint) {
  const session = ctx.db.jurySession.id.find(sessionId);
  if (!session) {
    throw new SenderError('Session not found');
  }
  return session as any;
}

function advanceSessionTurn(ctx: JuryReducerCtx, session: JurySessionRow) {
  const isDefenseTurn = session.currentTurn === 'defense';
  const nextTurn = nextRole(isValidRole(session.currentTurn) ? session.currentTurn : OPENING_ROLE);
  const nextRound = isDefenseTurn ? session.roundNumber + 1n : session.roundNumber;
  const reachedAnalysis = isDefenseTurn && nextRound > session.maxRounds;

  ctx.db.jurySession.id.update({
    ...session,
    currentTurn: reachedAnalysis ? 'analyzing' : nextTurn,
    roundNumber: nextRound,
    status: reachedAnalysis ? 'analyzing' : 'debating',
    updatedAt: ctx.timestamp,
  });
}

export default spacetimedb;

export const init = spacetimedb.init(() => {
  // No bootstrap data yet.
});

export const onConnect = spacetimedb.clientConnected(() => {
  // Connection lifecycle hook reserved for future room bookkeeping.
});

export const onDisconnect = spacetimedb.clientDisconnected(() => {
  // Connection lifecycle hook reserved for future cleanup.
});

export const createSession = spacetimedb.reducer(
  { topic: t.string(), maxRounds: t.u64().optional() },
  (ctx, { topic, maxRounds }) => {
    const normalizedTopic = normalizeText(topic);
    if (!normalizedTopic) {
      throw new SenderError('Topic is required');
    }

    const sessionMaxRounds = maxRounds ?? DEFAULT_MAX_ROUNDS;

    ctx.db.jurySession.insert({
      id: 0n,
      topic: normalizedTopic,
      status: 'idle',
      currentTurn: OPENING_ROLE,
      roundNumber: 1n,
      maxRounds: sessionMaxRounds,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      verdictId: undefined,
    });
  }
);

export const startDebate = spacetimedb.reducer(
  { sessionId: t.u64() },
  (ctx, { sessionId }) => {
    const session = requireSession(ctx, sessionId) as any;

    if (session.status !== 'idle') {
      throw new SenderError('Session is already active');
    }

    ctx.db.jurySession.id.update({
      ...session,
      status: 'debating',
      currentTurn: OPENING_ROLE,
      roundNumber: 1n,
      updatedAt: ctx.timestamp,
    });
  }
);

export const ingestEvidence = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    source: t.string(),
    title: t.string(),
    content: t.string(),
    url: t.string().optional(),
  },
  (ctx, { sessionId, source, title, content, url }) => {
    const session = requireSession(ctx, sessionId) as any;

    ctx.db.evidence.insert({
      id: 0n,
      sessionId,
      source: normalizeText(source),
      title: normalizeText(title),
      content: content.trim(),
      url,
      createdAt: ctx.timestamp,
    });

    if (session.status === 'idle') {
      ctx.db.jurySession.id.update({
        ...session,
        status: 'debating',
        updatedAt: ctx.timestamp,
      });
    }
  }
);

export const postArgument = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    role: t.string(),
    content: t.string(),
  },
  (ctx, { sessionId, role, content }) => {
    const session = requireSession(ctx, sessionId) as any;
    const normalizedRole = normalizeText(role).toLowerCase();

    if (!isValidRole(normalizedRole)) {
      throw new SenderError('Invalid debate role');
    }

    if (session.status !== 'debating') {
      throw new SenderError('Session is not accepting arguments');
    }

    if (session.currentTurn !== normalizedRole) {
      throw new SenderError(`It is currently ${session.currentTurn}'s turn`);
    }

    ctx.db.message.insert({
      id: 0n,
      sessionId,
      role: normalizedRole,
      sender: ctx.sender,
      content: content.trim(),
      roundNumber: session.roundNumber,
      createdAt: ctx.timestamp,
    });

    advanceSessionTurn(ctx, session);
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

    ctx.db.alert.insert({
      id: 0n,
      sessionId,
      messageId,
      source: normalizeText(source),
      severity: normalizeText(severity),
      content: content.trim(),
      createdAt: ctx.timestamp,
    });
  }
);

export const markAnalyzing = spacetimedb.reducer(
  { sessionId: t.u64() },
  (ctx, { sessionId }) => {
    const session = requireSession(ctx, sessionId) as any;

    ctx.db.jurySession.id.update({
      ...session,
      status: 'analyzing',
      currentTurn: 'analyzing',
      updatedAt: ctx.timestamp,
    });
  }
);

export const finalizeVerdict = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    decision: t.string(),
    summary: t.string(),
  },
  (ctx, { sessionId, decision, summary }) => {
    const session = requireSession(ctx, sessionId) as any;

    if (session.status === 'closed') {
      throw new SenderError('Session already finalized');
    }

    const existingVerdict = [...ctx.db.verdict.verdict_session_id.filter(sessionId)][0];
    if (existingVerdict) {
      throw new SenderError('Verdict already exists for this session');
    }

    const verdict = ctx.db.verdict.insert({
      id: 0n,
      sessionId,
      decision: normalizeText(decision),
      summary: summary.trim(),
      createdAt: ctx.timestamp,
    });

    ctx.db.jurySession.id.update({
      ...session,
      status: 'closed',
      currentTurn: 'closed',
      verdictId: verdict.id,
      updatedAt: ctx.timestamp,
    });
  }
);