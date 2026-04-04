# AI Jury Room: Enhanced Workflow and Implementation Plan

Date: 2026-04-04

## 1) Mission

Build a research-grade, multi-agent debate platform that is:

- Grounded in verifiable evidence
- Robust against bias and prompt drift
- Auditable from topic input to final verdict
- Reliable under retries, failures, and partial outages

## 2) Current System Snapshot (As-Is)

### 2.1 Core Runtime

- Frontend: React + Vite + SpacetimeDB bindings
- Orchestrator: Node.js + TypeScript worker loop
- State engine: SpacetimeDB (sessions, evidence, messages, alerts, verdicts)
- External services:
  - Tavily for evidence search
  - Groq-hosted LLMs for argument generation, fallacy checks, and synthesis
  - MongoDB for verdict records

### 2.2 Active Workers

- Discovery worker
- Prosecution worker
- Defense worker
- Devil's Advocate worker
- Fallacy worker
- Synthesis worker

### 2.3 Current Models and Roles

- `llama-3.3-70b-versatile`:
  - Prosecution arguments
  - Defense arguments
  - Devil's Advocate critique
  - Final synthesis
- `llama-3.1-8b-instant`:
  - Fallacy analysis

### 2.4 What Is Already Improved

- Debate text readability improved with stricter prompts and output caps
- UI formatting improved (argument timeline shown as points)
- Markdown artifact cleanup in UI rendering (`**...**` stripped)
- Discovery upgraded from single-result evidence to curated multi-source snapshot
- Basic bias indicators added to evidence curation (source diversity notes)

## 3) Canonical End-to-End Workflow (Target)

1. Session is created with status `DISCOVERY_PENDING`.
2. Discovery performs multi-query search and builds a curated evidence snapshot.
3. Evidence is frozen and session advances to `DISCOVERY_DONE` with turn `PROSECUTION`.
4. Prosecution posts argument and advances to `PROSECUTION_DONE`.
5. Defense posts argument and advances to `DEFENSE_DONE`.
6. Devil's Advocate posts critique and moves session to analyzing phase.
7. Fallacy worker runs in parallel over posted messages and records alerts.
8. Synthesis reads frozen evidence plus debate history and writes final verdict.
9. Final verdict is persisted for audit/public record.

## 4) State Machine Contract

`DISCOVERY_PENDING` -> `DISCOVERY_DONE` -> `PROSECUTION_DONE` -> `DEFENSE_DONE` -> `DEVILS_ADVOCATE_DONE` -> `SYNTHESIS_PENDING` -> `COMPLETED`

Failure branch: any phase may transition to `FAILED` through guarded failure handling.

Rules:

- Only one phase owner writes phase transitions.
- Reducers must remain deterministic.
- Idempotency keys are required for external-action writes.
- Evidence snapshot is immutable after discovery completes.

## 5) Research-Grade Gap Analysis (As-Is vs To-Be)

### 5.1 Implemented

- Deterministic reducer state model
- Multi-worker orchestrator skeleton
- Multi-agent role separation
- Fallacy advisory path
- MongoDB persistence for synthesis output

### 5.2 Missing or Partial

- Policy gate layer before every external action (search, generation, publish)
- Strong evidence balancing policy (source class quotas, contradiction checks)
- Audio/TTS pipeline and `SPOKEN` message lifecycle
- Structured quality scoring for each debate turn
- Session-level benchmark and evaluation harness
- Operational dashboards and SLO metrics

## 6) Enhancement Plan (Phased)

## Phase A: Evidence Hardening (In Progress)

Objective: reduce search and ranking bias before debate begins.

Deliverables:

- Multi-query evidence retrieval (primary + counter-view)
- Result dedupe and source diversity selection
- Curated snapshot with findings, source list, and diversity report
- Audit log fields for selected source URLs and diversity flags

Acceptance:

- Snapshot contains >= 2 distinct domains for non-trivial topics when available
- Discovery retries do not create duplicate evidence rows

## Phase B: Policy Gate Integration

Objective: introduce governance checks without breaking throughput.

Deliverables:

- Add policy module for pre-search, pre-argument, pre-synthesis, and pre-publish checks
- Record policy violations in alerts/audit log
- Non-blocking degrade path (safe fallback response if gate fails)

Acceptance:

- Every external call has a gate decision trace in logs
- Rejected turns are observable and do not deadlock session progression

## Phase C: Argument Quality Layer

Objective: make debate quality measurable and consistent.

Deliverables:

- Add rubric scores per message (clarity, grounding, logical consistency)
- Prompt-inject previous score feedback into next role turn
- Add low-quality retry path with capped attempts

Acceptance:

- Each message has score metadata in audit stream
- Average quality trend is non-degrading over rounds

## Phase D: Synthesis Reliability and Publication

Objective: produce neutral, traceable verdicts.

Deliverables:

- Enforce verdict template output contract
- Add contradiction summary between roles
- Publish structured verdict package (topic, evidence snapshot, arguments, alerts, verdict)

Acceptance:

- Verdict always includes all required sections
- Publication payload links to immutable evidence snapshot id

## Phase E: Audio and Delivery Layer

Objective: complete message lifecycle to `SPOKEN` and support multimodal output.

Deliverables:

- Audio worker for TTS generation and delivery
- Message status transitions: `DRAFT -> VALIDATED -> BROADCASTABLE -> SPOKEN`
- Frontend playback controls and state indicators

Acceptance:

- Posted arguments can be rendered and played as audio
- Status transitions are consistent and observable

## Phase F: Evaluation and Operations

Objective: move from demo-grade to production-grade reliability.

Deliverables:

- Golden test topics and expected phase traces
- Metrics: phase latency, retry rate, failure rate, policy reject rate
- Health dashboard + alerting thresholds

Acceptance:

- Repeatable end-to-end pass rate >= 95% on benchmark set
- Mean time to detect failure < 1 minute

## 7) Immediate Implementation Backlog (Next 10 Tasks)

1. Add policy gate scaffolding module and typed gate decisions.
2. Wire policy gate into discovery before Tavily call.
3. Wire policy gate into prosecution/defense/devils prompts.
4. Add synthesis pre-publish policy check.
5. Add explicit failure reducer path for unrecoverable worker errors.
6. Add message quality score calculator and audit persistence.
7. Add contradiction extractor in synthesis step.
8. Add publish payload serializer for final verdict records.
9. Add audio worker stub and message status integration points.
10. Add benchmark script for multi-session end-to-end regression tests.

## 8) Validation Plan

### Functional

- Session transitions follow exact phase graph
- Each phase writes expected rows and no duplicates
- Verdict creation completes with required sections

### Quality

- Arguments remain concise and role-consistent
- Evidence snapshot includes diversity checks
- Verdict cites both agreement and disagreement zones

### Reliability

- Worker retry behavior is idempotent
- Transient API failures recover without manual intervention
- Frontend remains readable and updates in real time

## 9) Runbook (Developer)

1. Build backend orchestrator:

```powershell
cd jury-room-backend\orchestrator
npm run build
```

2. Run frontend:

```powershell
cd ai-jury-frontend
npm run dev
```

3. Verify health:

- Frontend loads and lists sessions
- Orchestrator logs all worker start messages
- New session can progress from discovery to synthesis

## 10) Definition of Done for Research-Grade v1

The enhanced workflow is considered complete when:

- Multi-source evidence curation and bias checks are enforced
- Policy gates are active for all external actions
- Debate quality scores are generated and used in-loop
- Synthesis is structured, neutral, and audit-linked
- Audio lifecycle to `SPOKEN` is implemented
- Regression suite demonstrates stable end-to-end behavior
