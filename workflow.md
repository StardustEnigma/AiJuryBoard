# 🏛️ Jury Room: Technical Architecture & Workflow (2026)

**Project Goal:** Patching Reality by using multi-agent AI to simulate high-stakes, logically grounded debates on controversial topics.

---

## 🛠️ The 2026 Tech Stack
| Layer | Technology | Function |
| :--- | :--- | :--- |
| **Orchestrator** | **Node.js (v24+)** | Manages API lifecycles and event loops. |
| **State Engine** | **SpacetimeDB (v2.0)** | Real-time relational database for agent synchronization. |
| **Intelligence** | **Claude 4.5** (Prosecution, Defense, Devil's Advocate) | Persona-driven adversarial debate with distinct biases. |
| **Synthesis** | **Gemini 3.1 Pro** | Neutral analysis & final verdict synthesis. |
| **Reason Check** | **Llama 3.3** (The Skeptic) | Real-time logical fallacy detection. |
| **Grounding** | **Tavily AI** | Real-time 2026 web search for "Ground Truth" evidence. |
| **Governance** | **ArmorIQ** | Intent-based firewall to enforce agent roles and safety. |
| **Sensory** | **ElevenLabs (Turbo 2.5)** | Low-latency, emotive TTS for distinct agent voices. |

---

## 🏗️ System Architecture (Separation of Concerns)

### SpacetimeDB: Deterministic State Engine
**Purpose:** Session state, message audit log, evidence snapshots, and alerts only.

**Never do:** Network calls, AI inference, file I/O, or non-deterministic operations.

**Tables:**
- `jury_session` — tracks phase transitions (DISCOVERY_PENDING → COMPLETED)
- `evidence` — frozen snapshots of facts per session
- `message` — debate turns with status lifecycle (DRAFT → BROADCASTABLE → SPOKEN)
- `alert` — fallacy detections, logged *after* messages are stored
- `verdict` — final synthesis output with evidence_snapshot_id for auditability

---

### Node.js Orchestrator: Nondeterministic Workers
**Purpose:** Poll for phase changes, invoke external APIs, retry safely, enforce policy gates.

**Worker Pattern:**
1. Poll SpacetimeDB for a specific session phase (e.g., DISCOVERY_PENDING)
2. Call external API (Tavily, Claude, Gemini, Llama, ElevenLabs) on frozen evidence snapshot
3. ArmorIQ pre-gate validation (policy check before each action)
4. Call SpacetimeDB reducer to atomically write result and advance phase
5. On failure: retry with idempotency key (prevents duplicate messages/evidence)

**The Safe Debate Loop (per session):**
1. **Evidence Snapshot** → Tavily search (ArmorIQ: is this a legitimate search?) → freeze with `ingestEvidence`
2. **Prosecution** → Claude with frozen evidence (ArmorIQ: stays in role?) → `postArgument`
3. **Defense** → Claude reads prosecution msg (ArmorIQ: stays in role?) → `postArgument`
4. **Devil's Advocate** → Claude reads both (ArmorIQ: surfaces genuine edge cases?) → `postArgument`
5. **Fallacy Detection** (parallel) → Llama scans messages → `recordFallacyAlert` (advisory, never rewrites)
6. **Audio Streaming** (parallel) → ElevenLabs per message → updates message status to SPOKEN
7. **Synthesis** → Gemini reads frozen facts + all messages (ArmorIQ: neutral analysis?) → `finalizeVerdict` → MongoDB

---

## � Conflict Controls: Strict Phase Transitions

Each session has exactly one active phase at a time. Only the orchestrator can advance phases (via idempotent gate).

```
DISCOVERY_PENDING
  ↓ [Orch: Tavily → ArmorIQ gate → ingestEvidence → freeze snapshot]
DISCOVERY_DONE
  ↓ [Orch: Claude prosecution → ArmorIQ gate → postArgument]
PROSECUTION_DONE
  ↓ [Orch: Claude defense → ArmorIQ gate → postArgument]
DEFENSE_DONE
  ↓ [Orch: Claude devil's advocate → ArmorIQ gate → postArgument]
DEVILS_ADVOCATE_DONE
  ↓ [Orch: (Llama fallacy scan in parallel) → markAnalyzing]
SYNTHESIS_PENDING
  ↓ [Orch: Gemini → ArmorIQ gate → finalizeVerdict → MongoDB]
COMPLETED or FAILED
```

**Hard Protections:**
1. **Idempotency key** on every external action (Tavily search ID, Claude request ID, Gemini session hash)—retries don't duplicate
2. **One writer per phase**—only orchestrator can call reducers, prevents race conditions
3. **Message status lifecycle**—DRAFT → VALIDATED → BROADCASTABLE → SPOKEN (ArmorIQ and TTS don't conflict)
4. **Evidence freeze**—no new evidence after DISCOVERY_DONE (facts don't mutate during debate)
5. **Message snapshot ref**—every verdict stores `evidence_snapshot_id` for full auditability

---

## 🚀 Setup & Deployment

1. **Start SpacetimeDB server:**
   ```powershell
   spacetime start
   ```

2. **Publish schema to server:**
   ```powershell
   cd jury-room-backend\ai-jury-board
   spacetime publish ai-jury-board
   ```

3. **Generate TypeScript client bindings:**
   ```powershell
   spacetime generate --lang typescript --out-dir ..\..\ai-jury-frontend\src\module_bindings
   ```

4. **Create `.env` file in project root:**
   ```env
   SPACETIME_URI=http://localhost:3000
   SPACETIME_DB=ai-jury-board
   
   CLAUDE_API_KEY=sk-...
   GEMINI_API_KEY=...
   TAVILY_API_KEY=...
   LLAMA_API_KEY=...
   ARMOR_IQ_KEY=...
   ELEVENLABS_API_KEY=...
   
   MONGODB_URI=mongodb+srv://...
   ```

5. **Install dependencies & build orchestrator:**
   ```powershell
   npm install
   npm run build
   npm run start:orchestrator
   ```

6. **Start frontend (separate terminal):**
   ```powershell
   cd ai-jury-frontend
   npm run dev
   ```

7. **Verify end-to-end:**
   - Open http://localhost:5173
   - Create a session → watch orchestrator logs
   - Evidence ingests, then debate progresses phase-by-phase
   - Check SpacetimeDB dashboard for session phases
   - Verify final verdict + evidence_snapshot_id in MongoDB

---

## � Implementation Tracker

| Component | Status | Location | Notes |
|-----------|--------|----------|-------|
| **Spacetime Schema** | ✅ Done | `spacetimedb/src/schema.ts` | Tables: JurySession, Evidence, Message, Alert, Verdict |
| **Spacetime Reducers** | ✅ Done | `spacetimedb/src/index.ts` | All 7 reducers implemented |
| **Frontend UI Harness** | ✅ Done | `ai-jury-frontend/src/App.tsx` | Session creation & start debate UI |
| **Phase Transition System** | ⏳ Pending | `spacetimedb/src/schema.ts` | Add status field with strict enum: DISCOVERY_PENDING, DISCOVERY_DONE, ..., COMPLETED |
| **Evidence Snapshot Ref** | ⏳ Pending | `spacetimedb/src/schema.ts` | Add `evidence_snapshot_id` to Message & Verdict for auditability |
| **Message Status Lifecycle** | ⏳ Pending | `spacetimedb/src/schema.ts` | Add `message_status: DRAFT | VALIDATED | BROADCASTABLE | SPOKEN` to Message table |
| **Idempotency Keys** | ⏳ Pending | `spacetimedb/src/schema.ts` | Add `idempotency_key` to Evidence, Message, Verdict (prevent duplicates on retry) |
| **Orchestrator Entry Point** | ⏳ Pending | `orchestrator/index.ts` | Boot all workers, watch phase transitions, enforce one-writer lock per phase |
| **Discovery Worker** | ⏳ Pending | `orchestrator/workers/discovery.ts` | Poll DISCOVERY_PENDING → Tavily (ArmorIQ gate) → ingestEvidence → DISCOVERY_DONE |
| **Prosecution Worker** | ⏳ Pending | `orchestrator/workers/prosecution.ts` | Poll DISCOVERY_DONE → Claude prosecution (ArmorIQ gate) → postArgument → PROSECUTION_DONE |
| **Defense Worker** | ⏳ Pending | `orchestrator/workers/defense.ts` | Poll PROSECUTION_DONE → Claude defense (ArmorIQ gate) → postArgument → DEFENSE_DONE |
| **Devil's Advocate Worker** | ⏳ Pending | `orchestrator/workers/devils_advocate.ts` | Poll DEFENSE_DONE → Claude/Grok contrarian (ArmorIQ gate) → postArgument → DEVILS_ADVOCATE_DONE |
| **Llama Fallacy Worker** | ⏳ Pending | `orchestrator/workers/fallacy.ts` | Subscribe Message table → Llama analysis → recordFallacyAlert (advisory only, no rewrites) |
| **ElevenLabs Audio Worker** | ⏳ Pending | `orchestrator/workers/audio.ts` | Subscribe Message table → ElevenLabs TTS → stream WebSocket → update status SPOKEN |
| **Synthesis Worker** | ⏳ Pending | `orchestrator/workers/synthesis.ts` | Poll SYNTHESIS_PENDING → Gemini (frozen snapshot + messages) → ArmorIQ gate → finalizeVerdict → MongoDB |
| **ArmorIQ Policy Gates** | ⏳ Pending | `orchestrator/armor.ts` | Validate pre-Tavily, pre-Claude, pre-Gemini, pre-TTS, pre-MongoDB |
| **Frontend Audio Player** | ⏳ Pending | `ai-jury-frontend/src/App.tsx` | Subscribe Message table (status=SPOKEN) → render streaming waveform |
| **MongoDB Public Record** | ⏳ Pending | `orchestrator/workers/mongodb.ts` | Write final Verdict with evidence_snapshot_id + debate metadata for audit log |

---

## 🛡️ Governance & Ethics

**Tri-Agent Debate Model:**
- **Prosecution (Pro):** Maximalist perspective—supports the thesis aggressively.
- **Defense (Con):** Minimalist perspective—opposes the thesis empathetically.
- **Devil's Advocate (Reality):** Pragmatist perspective—questions both sides, surfaces edge cases and nuance.

**Devil's Advocate Implementation:**
- Model: Claude 4.5 with explicit contrarian system prompt (or Grok if contrarian depth is prioritized)
- Enters after DEFENSE_DONE
- Reads evidence snapshot + both prosecution and defense messages
- Generates critiques on logical assumptions, hidden dependencies, empirical gaps
- Does NOT announce a winner; focuses on "what breaks this argument?"

**ArmorIQ Enforcement (Node.js orchestrator, NOT in-reducer):**
- Pre-Tavily gate: "Is this a legitimate evidence search, not a jailbreak?"
- Pre-Claude gate: "Does the message enforce the assigned persona?"
- Pre-Gemini gate: "Is the synthesis neutral or biased toward one side?"
- Pre-TTS gate: "Should this audio be broadcast (on-topic, not offensive)?"
- Pre-MongoDB gate: "Should this verdict be published (grounded in evidence)?"

Rejected turns are logged as `alert` (severity=POLICY_VIOLATION) and the debate continues. One failed message never blocks the session.

**Auditability:**
Every verdict stores `evidence_snapshot_id`, so any future review can see *exactly* what facts were available when the decision was made. This prevents "we changed our facts midway" arguments and builds immutable debate records.