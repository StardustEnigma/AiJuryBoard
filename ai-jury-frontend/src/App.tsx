import { useMemo, useState } from 'react';
import { SpacetimeDBProvider, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables } from './module_bindings';
import type { Alert, Evidence, JurySession, Message, Verdict } from './module_bindings/types';

const SERVER_URL = 'https://maincloud.spacetimedb.com';
const DATABASE_NAME = 'ai-jury-board';
const ORCHESTRATOR_URL = 'http://localhost:9000';
const PHASE_FLOW = [
  'DISCOVERY_PENDING',
  'DISCOVERY_DONE',
  'PROSECUTION_DONE',
  'DEFENSE_DONE',
  'DEVILS_ADVOCATE_DONE',
  'SYNTHESIS_PENDING',
  'COMPLETED',
];
const SYNTHESIS_SECTION_LABELS = [
  'PROSECUTION_SUMMARY:',
  'DEFENSE_SUMMARY:',
  'DEVIL_ADVOCATE_ANALYSIS:',
  'SHARED_REALITY:',
  'REMAINING_DISAGREEMENT:',
  'VERDICT:',
] as const;
const SYNTHESIS_SECTION_TOKEN_REGEX =
  /(PROSECUTION_SUMMARY:|DEFENSE_SUMMARY:|DEVIL_ADVOCATE_ANALYSIS:|SHARED_REALITY:|REMAINING_DISAGREEMENT:|VERDICT:)/gi;

type NoticeTone = 'info' | 'success' | 'error';
type Notice = { tone: NoticeTone; message: string } | null;

function toBigInt(value: unknown): bigint {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.trim()) return BigInt(value);
  } catch {
    // Fall through to default.
  }

  return 0n;
}

function toId(value: unknown): string {
  return toBigInt(value).toString();
}

function compareBigIntAsc(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareBigIntDesc(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

function formatLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

function isNotProvided(value: string): boolean {
  return /^not provided\.?$/i.test(value.trim());
}

function parseSynthesisSections(value: string): Map<string, string[]> {
  const source = cleanMarkdownText(value).replace(/\s+/g, ' ').trim();
  const sections = new Map<string, string[]>();
  if (!source) {
    return sections;
  }

  const tokens: Array<{ label: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = SYNTHESIS_SECTION_TOKEN_REGEX.exec(source)) !== null) {
    tokens.push({
      label: match[1].toUpperCase(),
      start: match.index,
      end: SYNTHESIS_SECTION_TOKEN_REGEX.lastIndex,
    });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    const content = source.slice(current.end, next?.start ?? source.length).trim();
    if (!content) continue;

    const existing = sections.get(current.label) ?? [];
    existing.push(content);
    sections.set(current.label, existing);
  }

  return sections;
}

function preferredSectionValue(values: string[]): string {
  const preferred = values.find((value) => !isNotProvided(value));
  return preferred ?? values[0] ?? 'Not provided.';
}

function canonicalizeVerdictSummary(summary: string): string {
  const sections = parseSynthesisSections(summary);

  if (sections.size === 0) {
    const fallback = cleanMarkdownText(summary).replace(/\s+/g, ' ').trim();
    return fallback || 'Not provided.';
  }

  return SYNTHESIS_SECTION_LABELS.map((label) => {
    const values = sections.get(label) ?? [];
    return `${label} ${preferredSectionValue(values)}`;
  }).join(' ');
}

function normalizeVerdictDecision(decision: string, summary: string): string {
  const summarySections = parseSynthesisSections(summary);
  const summaryVerdict = preferredSectionValue(summarySections.get('VERDICT:') ?? []);

  let out = !isNotProvided(summaryVerdict)
    ? summaryVerdict
    : cleanMarkdownText(decision).replace(/\s+/g, ' ').trim();

  out = out.replace(/^VERDICT:\s*/i, '').trim();

  const marker = out.match(
    /(?:PROSECUTION_SUMMARY:|DEFENSE_SUMMARY:|DEVIL_ADVOCATE_ANALYSIS:|SHARED_REALITY:|REMAINING_DISAGREEMENT:|VERDICT:)/i
  );
  if (marker?.index && marker.index > 0) {
    out = out.slice(0, marker.index).trim();
  }

  return out || 'Not provided.';
}

function toMessagePoints(value: string): string[] {
  const trimmed = cleanMarkdownText(value).trim();
  if (!trimmed) return [];

  const rawLines = trimmed
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const normalizedLines = rawLines
    .map((line) => line.replace(/^[-*•\d]+[.)]?\s+/, '').trim())
    .filter(Boolean);

  if (normalizedLines.length >= 2 && normalizedLines.length <= 6) {
    return normalizedLines;
  }

  const normalizedText = trimmed.replace(/\s+/g, ' ').trim();
  const sentences = normalizedText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return [normalizedText];
  }

  const grouped: string[] = [];
  let bucket = '';

  for (const sentence of sentences) {
    const candidate = bucket ? `${bucket} ${sentence}` : sentence;
    const candidateWordCount = candidate.split(' ').filter(Boolean).length;

    // Keep each bullet readable while allowing connected reasoning.
    if (!bucket || candidateWordCount <= 42) {
      bucket = candidate;
    } else {
      grouped.push(bucket);
      bucket = sentence;
    }
  }

  if (bucket) {
    grouped.push(bucket);
  }

  if (grouped.length <= 6) {
    return grouped;
  }

  const compact = grouped.slice(0, 5);
  compact.push(grouped.slice(5).join(' '));
  return compact;
}

function statusClass(status: string): string {
  const normalized = status.toUpperCase();

  if (normalized === 'DISCOVERY_PENDING') return 'chip-status-pending';
  if (normalized === 'COMPLETED') return 'chip-status-complete';
  if (normalized === 'FAILED') return 'chip-status-failed';
  return 'chip-status-progress';
}

function roleClass(role: string): string {
  const normalized = role.toUpperCase();

  if (normalized === 'PROSECUTION') return 'chip-role-prosecution';
  if (normalized === 'DEFENSE') return 'chip-role-defense';
  if (normalized === 'DEVILS_ADVOCATE') return 'chip-role-devil';
  return 'chip-neutral';
}

function severityClass(severity: string): string {
  const normalized = severity.toUpperCase();

  if (normalized === 'CRITICAL') return 'chip-sev-critical';
  if (normalized === 'HIGH') return 'chip-sev-high';
  if (normalized === 'MEDIUM') return 'chip-sev-medium';
  if (normalized === 'LOW') return 'chip-sev-low';
  return 'chip-neutral';
}

function phaseProgress(status: string): number {
  const normalized = status.toUpperCase();
  const index = PHASE_FLOW.findIndex((phase) => phase === normalized);
  if (index < 0) return 0;
  return ((index + 1) / PHASE_FLOW.length) * 100;
}

/**
 * Notify orchestrator about session changes.
 */
async function notifyOrchestrator(session: JurySession): Promise<void> {
  try {
    const payload = {
      id: session.id.toString(),
      topic: session.topic,
      status: session.status,
      currentTurn: session.currentTurn,
      roundNumber: session.roundNumber.toString(),
    };

    const response = await fetch(`${ORCHESTRATOR_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.warn('Orchestrator notification failed:', response.status);
    }
  } catch (error) {
    console.warn('Could not reach orchestrator:', error);
  }
}

function JuryWorkspace({ conn }: { conn: DbConnection }) {
  const [sessions, sessionsLoading] = useTable(tables.jurySession);
  const [messages, messagesLoading] = useTable(tables.message);
  const [evidenceRows, evidenceLoading] = useTable(tables.evidence);
  const [alerts, alertsLoading] = useTable(tables.alert);
  const [verdicts, verdictsLoading] = useTable(tables.verdict);

  const [topic, setTopic] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const sortedSessions = useMemo(() => {
    const copy = [...sessions];
    copy.sort((a, b) => compareBigIntDesc(toBigInt(a.id), toBigInt(b.id)));
    return copy;
  }, [sessions]);

  const selectedSession = useMemo(() => {
    if (sortedSessions.length === 0) return null;
    if (!selectedSessionId) return sortedSessions[0] as JurySession;

    const match = sortedSessions.find((session) => toId(session.id) === selectedSessionId);
    return (match ?? sortedSessions[0]) as JurySession;
  }, [selectedSessionId, sortedSessions]);

  const activeSessionId = selectedSession ? toId(selectedSession.id) : null;

  const sessionEvidence = useMemo(() => {
    if (!activeSessionId) return [] as Evidence[];

    const filtered = evidenceRows.filter((row) => toId(row.sessionId) === activeSessionId) as Evidence[];
    filtered.sort((a, b) => compareBigIntAsc(toBigInt(a.id), toBigInt(b.id)));
    return filtered;
  }, [activeSessionId, evidenceRows]);

  const sessionMessages = useMemo(() => {
    if (!activeSessionId) return [] as Message[];

    const filtered = messages.filter((row) => toId(row.sessionId) === activeSessionId) as Message[];
    filtered.sort((a, b) => {
      const roundComparison = compareBigIntAsc(toBigInt(a.roundNumber), toBigInt(b.roundNumber));
      if (roundComparison !== 0) return roundComparison;
      return compareBigIntAsc(toBigInt(a.id), toBigInt(b.id));
    });
    return filtered;
  }, [activeSessionId, messages]);

  const sessionAlerts = useMemo(() => {
    if (!activeSessionId) return [] as Alert[];

    const filtered = alerts.filter((row) => toId(row.sessionId) === activeSessionId) as Alert[];

    const dedupedBySignature = new Map<string, Alert>();
    for (const alert of filtered) {
      const signature = [
        alert.messageId ? toId(alert.messageId) : 'N/A',
        String(alert.source || '').toLowerCase(),
      ].join('|');

      const existing = dedupedBySignature.get(signature);
      if (!existing || compareBigIntAsc(toBigInt(existing.id), toBigInt(alert.id)) < 0) {
        dedupedBySignature.set(signature, alert);
      }
    }

    const deduped = [...dedupedBySignature.values()];
    deduped.sort((a, b) => compareBigIntAsc(toBigInt(a.id), toBigInt(b.id)));
    return deduped;
  }, [activeSessionId, alerts]);

  const sessionVerdicts = useMemo(() => {
    if (!activeSessionId) return [] as Verdict[];

    const filtered = verdicts.filter((row) => toId(row.sessionId) === activeSessionId) as Verdict[];
    filtered.sort((a, b) => compareBigIntDesc(toBigInt(a.id), toBigInt(b.id)));
    return filtered;
  }, [activeSessionId, verdicts]);

  const streamLoading = sessionsLoading || messagesLoading || evidenceLoading || alertsLoading || verdictsLoading;

  const handleCreate = () => {
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      setNotice({ tone: 'info', message: 'Add a topic to create a session.' });
      return;
    }

    try {
      conn.reducers.createSession({ topic: normalizedTopic, maxRounds: 6n });
      setTopic('');
      setNotice({ tone: 'success', message: 'Session created. Select it and click Start Debate.' });
    } catch (error) {
      setNotice({ tone: 'error', message: `Create session failed: ${String(error)}` });
    }
  };

  const handleStart = (session: JurySession) => {
    setSelectedSessionId(session.id.toString());

    if (session.status.toUpperCase() !== 'DISCOVERY_PENDING') {
      setNotice({
        tone: 'info',
        message: 'This session is already running. Open Debate Monitor to follow live updates.',
      });
      return;
    }

    try {
      const sessionId = typeof session.id === 'bigint' ? session.id : BigInt(session.id);
      conn.reducers.startDebate({ sessionId });
      setNotice({ tone: 'success', message: 'Debate start sent. Live events will stream below.' });
      setTimeout(() => {
        void notifyOrchestrator(session);
      }, 100);
    } catch (error) {
      setNotice({ tone: 'error', message: `Start debate failed: ${String(error)}` });
    }
  };

  const activeStatus = selectedSession?.status.toUpperCase() ?? 'DISCOVERY_PENDING';
  const progressWidth = phaseProgress(activeStatus);

  return (
    <section className="workspace-grid">
      <aside className="panel session-panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Session Queue</h2>
            <p className="panel-subtitle">Create, start, and select sessions to inspect.</p>
          </div>
          <span className="chip chip-neutral">{sortedSessions.length} total</span>
        </div>

        {notice && <div className={`banner ${notice.tone}`}>{notice.message}</div>}

        <div className="create-row">
          <input
            className="text-input"
            placeholder="Debate topic, e.g. Should AI judges be advisory only?"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleCreate();
              }
            }}
          />
          <button onClick={handleCreate} className="btn btn-primary">
            Create Session
          </button>
        </div>

        {streamLoading && <div className="banner info">Syncing live tables from SpacetimeDB...</div>}

        <div className="session-list">
          {sortedSessions.length === 0 ? (
            <div className="empty-state">No sessions yet. Create your first topic to begin.</div>
          ) : (
            sortedSessions.map((session) => {
              const sessionKey = toId(session.id);
              const isSelected = selectedSession ? toId(selectedSession.id) === sessionKey : false;
              const canStart = session.status.toUpperCase() === 'DISCOVERY_PENDING';

              return (
                <article
                  key={sessionKey}
                  className={`session-card ${isSelected ? 'active' : ''}`}
                  onClick={() => setSelectedSessionId(sessionKey)}
                >
                  <div className="session-head">
                    <h3 className="session-topic">{session.topic}</h3>
                    <span className="session-id">#{sessionKey}</span>
                  </div>

                  <div className="chip-row">
                    <span className={`chip ${statusClass(session.status)}`}>{formatLabel(session.status)}</span>
                    <span className="chip chip-neutral">Turn {formatLabel(session.currentTurn)}</span>
                    <span className="chip chip-neutral">
                      Round {session.roundNumber.toString()} / {session.maxRounds.toString()}
                    </span>
                  </div>

                  <div className="session-actions" onClick={(event) => event.stopPropagation()}>
                    <button className="btn btn-ghost" onClick={() => setSelectedSessionId(sessionKey)}>
                      View Debate
                    </button>
                    <button className="btn btn-success" onClick={() => handleStart(session)} disabled={!canStart}>
                      {canStart ? 'Start Debate' : 'Debate Running'}
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </aside>

      <main className="panel detail-panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Debate Monitor</h2>
            <p className="panel-subtitle">
              {selectedSession
                ? `Session #${selectedSession.id.toString()} · ${selectedSession.topic}`
                : 'Select a session to monitor evidence, arguments, fallacies, and final verdict.'}
            </p>
          </div>
          <span className="chip chip-neutral">Realtime</span>
        </div>

        {!selectedSession ? (
          <div className="empty-state">Choose a session from the left to open the debate monitor.</div>
        ) : (
          <>
            <section className="phase-strip">
              <div className="phase-track">
                <div className="phase-fill" style={{ width: `${progressWidth}%` }} />
              </div>
              <p className="phase-caption">
                Current phase: <strong>{formatLabel(activeStatus)}</strong>
              </p>
            </section>

            <section className="metric-grid">
              <article className="metric-card">
                <p className="metric-label">Evidence</p>
                <p className="metric-value">{sessionEvidence.length}</p>
              </article>
              <article className="metric-card">
                <p className="metric-label">Messages</p>
                <p className="metric-value">{sessionMessages.length}</p>
              </article>
              <article className="metric-card">
                <p className="metric-label">Alerts</p>
                <p className="metric-value">{sessionAlerts.length}</p>
              </article>
              <article className="metric-card">
                <p className="metric-label">Verdict</p>
                <p className="metric-value">{sessionVerdicts.length > 0 ? 'Ready' : 'Pending'}</p>
              </article>
            </section>

            <section className="section-block">
              <h3 className="section-title">Evidence Snapshot</h3>
              {sessionEvidence.length === 0 ? (
                <div className="empty-state">Waiting for discovery evidence.</div>
              ) : (
                <div className="list-stack">
                  {sessionEvidence.map((evidence) => (
                    <article key={evidence.id.toString()} className="evidence-card">
                      <h4 className="entry-title">{evidence.title}</h4>
                      <p className="entry-content">{cleanMarkdownText(evidence.content)}</p>
                      <div className="entry-meta">
                        <span>{evidence.source}</span>
                        {evidence.url && (
                          <a className="source-link" href={evidence.url} target="_blank" rel="noreferrer">
                            Open Source
                          </a>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="section-block">
              <h3 className="section-title">Argument Timeline</h3>
              {sessionMessages.length === 0 ? (
                <div className="empty-state">No arguments posted yet.</div>
              ) : (
                <div className="list-stack">
                  {sessionMessages.map((message) => (
                    <article key={message.id.toString()} className="message-card">
                      <div className="chip-row">
                        <span className={`chip ${roleClass(message.role)}`}>{formatLabel(message.role)}</span>
                        <span className="chip chip-neutral">Round {toBigInt(message.roundNumber).toString()}</span>
                        <span className="chip chip-neutral">{formatLabel(message.messageStatus ?? 'DRAFT')}</span>
                      </div>
                      <ul className="entry-points" title={cleanMarkdownText(message.content)}>
                        {toMessagePoints(message.content).map((point, index) => (
                          <li key={`${message.id.toString()}-${index}`}>{point}</li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="section-block">
              <h3 className="section-title">Fallacy Alerts</h3>
              {sessionAlerts.length === 0 ? (
                <div className="empty-state">No fallacy alerts recorded yet.</div>
              ) : (
                <div className="list-stack">
                  {sessionAlerts.map((alert) => (
                    <article key={alert.id.toString()} className="alert-card">
                      <div className="chip-row">
                        <span className={`chip ${severityClass(alert.severity)}`}>{formatLabel(alert.severity)}</span>
                        <span className="chip chip-neutral">{alert.source}</span>
                        <span className="chip chip-neutral">
                          Message #{alert.messageId ? alert.messageId.toString() : 'N/A'}
                        </span>
                      </div>
                      <p className="entry-content">{cleanMarkdownText(alert.content)}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="section-block">
              <h3 className="section-title">Final Verdict</h3>
              {sessionVerdicts.length === 0 ? (
                <div className="empty-state">Verdict has not been finalized.</div>
              ) : (
                <article className="verdict-card">
                  <h4 className="entry-title">Decision</h4>
                  <p className="entry-content">
                    {normalizeVerdictDecision(sessionVerdicts[0].decision, sessionVerdicts[0].summary)}
                  </p>
                  <h4 className="entry-title">Summary</h4>
                  <p className="entry-content">{canonicalizeVerdictSummary(sessionVerdicts[0].summary)}</p>
                </article>
              )}
            </section>
          </>
        )}
      </main>
    </section>
  );
}

function JuryRoom() {
  const connectionState = useSpacetimeDB();
  const conn = connectionState.getConnection() as DbConnection | null;
  const identity = connectionState.identity?.toHexString();
  const connectionError = connectionState.connectionError?.message;

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div>
          <p className="eyebrow">Realtime Trial Intelligence</p>
          <h1>AI Jury Room</h1>
          <p className="subtitle">
            Professional workspace for monitoring evidence, argument quality, and verdict synthesis in one flow.
          </p>
        </div>
        <div className="connection-meta">
          <p>Database</p>
          <strong>{DATABASE_NAME}</strong>
          <p className="mono">{identity ? `${identity.slice(0, 12)}...` : 'anonymous'}</p>
        </div>
      </header>

      {connectionError && <div className="banner error">Connection error: {connectionError}</div>}

      {!connectionState.isActive || !conn ? (
        <div className="panel connection-loading">Connecting to SpacetimeDB and initializing live feeds...</div>
      ) : (
        <JuryWorkspace conn={conn} />
      )}
    </div>
  );
}

function App() {
  const connectionBuilder = useMemo(
    () => DbConnection.builder().withUri(SERVER_URL).withDatabaseName(DATABASE_NAME),
    []
  );

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <JuryRoom />
    </SpacetimeDBProvider>
  );
}

export default App;
