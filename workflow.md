# 🏛️ Jury Room: Technical Architecture & Workflow (2026)

**Project Goal:** Patching Reality by using multi-agent AI to simulate high-stakes, logically grounded debates on controversial topics.

---

## 🛠️ The 2026 Tech Stack
| Layer | Technology | Function |
| :--- | :--- | :--- |
| **Orchestrator** | **Node.js (v24+)** | Manages API lifecycles and event loops. |
| **State Engine** | **SpacetimeDB (v2.0)** | Real-time relational database for agent synchronization. |
| **Intelligence** | **Gemini 3.1 & Claude 4.5** | Reasoning, persona-driven debate, and final analysis. |
| **Grounding** | **Tavily AI** | Real-time 2026 web search for "Ground Truth" evidence. |
| **Governance** | **ArmorIQ** | Intent-based firewall to enforce agent roles and safety. |
| **Sensory** | **ElevenLabs (Turbo 2.5)** | Low-latency, emotive TTS for distinct agent voices. |

---

## 🔄 Full System Flow

### 1. Discovery Phase (Data Ingestion)
1. User submits a topic (e.g., *Article 370* or *Ram Mandir Verdict*).
2. **Node.js** triggers **Tavily AI** to perform an "Advanced Depth" search.
3. **Tavily** returns verified 2026 news snippets and legal precedents.
4. Data is pushed to the `Evidence` table in **SpacetimeDB**.

### 2. The Agentic Relay (The Debate Loop)
The debate moves through a state machine managed by **SpacetimeDB Reducers**:

* **Prosecution (Claude 4.5):** Reads evidence -> Generates aggressive argument.
* **Defense (Claude 4.5):** Reads Prosecutor's message via SpacetimeDB event -> Generates empathetic rebuttal.
* **The Firewall (ArmorIQ):** Every message is intercepted *before* broadcast. If an agent "breaks character" or hallucinates, ArmorIQ rejects the transaction.
* **The Skeptic (Llama 3.3):** Monitors the `Message` table and injects "Logical Fallacy" alerts in real-time.



### 3. Audio & UI Synchronization
1. Verified text is piped from **Node.js** to **ElevenLabs**.
2. **ElevenLabs** streams audio chunks to the frontend with <100ms latency.
3. The **React Frontend** subscribes to SpacetimeDB; agent cards "pulse" and waveforms animate based on which `AgentID` is currently writing to the DB.

### 4. The Reality Patch (Final Synthesis)
1. After X rounds, **Gemini 3.1 Pro** ingests the entire `Message` table.
2. It identifies the "Shared Reality"—the points where logic converged despite the bias.
3. The **Neutral Analyst** delivers the final verdict, stored in **MongoDB** for the "Public Record."

---

## 🚀 DevOps Workflow (How to Run)

1. **Initialize and publish SpacetimeDB:**
   ```powershell
   spacetime init --lang typescript
   spacetime publish ai-jury-board
   ```

2. **Set environment variables:**
   Create a `.env` file and configure:
   - `GEMINI_API_KEY`
   - `CLAUDE_API_KEY`
   - `TAVILY_KEY`
   - `ARMOR_IQ_KEY`
   - `ELEVENLABS_ID`

3. **Install dependencies and start the orchestrator:**
   ```bash
   npm install
   node orchestrator.js
   ```

4. **Verify end-to-end flow:**
   Submit a sample topic, confirm evidence ingestion, observe debate turns in SpacetimeDB, and validate that final synthesis is saved to the public record store.

---

## 🛡️ Governance & Ethics

ArmorIQ ensures that, even when agents are intentionally biased for adversarial debate, outputs remain role-consistent and fact-grounded. This reduces hallucination loops common in unconstrained LLM pipelines and supports a transparent, auditable truth-vs-manipulation process.