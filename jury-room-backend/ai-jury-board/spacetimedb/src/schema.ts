import { schema, table, t } from 'spacetimedb/server';

export const JurySession = table(
  {
    name: 'jury_session',
    public: true,
    indexes: [
      { accessor: 'jury_session_status', name: 'jury_session_status', algorithm: 'btree', columns: ['status'] },
      { accessor: 'jury_session_current_turn', name: 'jury_session_current_turn', algorithm: 'btree', columns: ['currentTurn'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    topic: t.string(),
    status: t.string(),
    currentTurn: t.string(),
    roundNumber: t.u64(),
    maxRounds: t.u64(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    verdictId: t.u64().optional(),
  }
);

export const Evidence = table(
  {
    name: 'evidence',
    public: true,
    indexes: [{ accessor: 'evidence_session_id', name: 'evidence_session_id', algorithm: 'btree', columns: ['sessionId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    source: t.string(),
    title: t.string(),
    content: t.string(),
    url: t.string().optional(),
    createdAt: t.timestamp(),
  }
);

export const Message = table(
  {
    name: 'message',
    public: true,
    indexes: [
      { accessor: 'message_session_id', name: 'message_session_id', algorithm: 'btree', columns: ['sessionId'] },
      { accessor: 'message_role', name: 'message_role', algorithm: 'btree', columns: ['role'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    role: t.string(),
    sender: t.identity(),
    content: t.string(),
    roundNumber: t.u64(),
    createdAt: t.timestamp(),
  }
);

export const Alert = table(
  {
    name: 'alert',
    public: true,
    indexes: [{ accessor: 'alert_session_id', name: 'alert_session_id', algorithm: 'btree', columns: ['sessionId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    messageId: t.u64().optional(),
    source: t.string(),
    severity: t.string(),
    content: t.string(),
    createdAt: t.timestamp(),
  }
);

export const Verdict = table(
  {
    name: 'verdict',
    public: true,
    indexes: [{ accessor: 'verdict_session_id', name: 'verdict_session_id', algorithm: 'btree', columns: ['sessionId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    decision: t.string(),
    summary: t.string(),
    createdAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  jurySession: JurySession,
  evidence: Evidence,
  message: Message,
  alert: Alert,
  verdict: Verdict,
});

export default spacetimedb;