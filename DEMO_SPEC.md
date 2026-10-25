# DEMO_SPEC.md — Synthetic QKD Incident Investigation (V1)

## Product one-liner
Engineering-ops style demo: synthetic QKD link incident → agent investigates with environment tools → maintains hypotheses as **LLM structured output** → human steers → human-approved diagnostic → new evidence → hypotheses update.

## Default incident (locked)
**QBER rising + key rate falling + maintenance context.**
No complex protocol plot. Fields are scenario skin only.

Incident id: `qber-rise-keyrate-drop`.

### Fixture layout (required)
- `fixtures/incidents/<id>/public.json` — model-visible facts (symptoms, time window, node ids, maintenance window summary).
- `fixtures/incidents/<id>/hidden.json` — **root cause and oracle only**. Loaded exclusively by the server-side diagnostic resolver; **never** passed to the model, never returned from tools, never shipped to the client bundle.

Sibling files (`telemetry.json`, `logs.json`, `maintenance.json`, `diagnostics.json`) are tool fixtures. `diagnostics.json` has a public `catalog` and server-side `outcomes`. `list_available_diagnostics` returns the catalog only. `run_diagnostic_test` returns one outcome and must not copy hidden fields.

## Environment tools (4–5; hypotheses are NOT a tool)
1. `query_telemetry` — QBER / key rate windowed series (synthetic).
2. `query_logs` — device/link log snippets.
3. `query_maintenance_context` — maintenance window / change tickets.
4. `list_available_diagnostics` — catalog of runnable tests.
5. `run_diagnostic_test` — **only after HITL approve**; returns new evidence; must not include hidden root-cause fields.

Registered with Vercel AI SDK `tool()` (`inputSchema` + `execute`) in `lib/tools.ts`.

## Hypotheses
Produced via Vercel AI SDK **structured output** (Zod schema), not a tool.
Schema: `{ hypotheses: [{ id, title, status: active|excluded|priority, rationale, supportingEvidenceIds[] }] }`.

M0 also asks the model for `proposedDiagnostic: { testId, reason } | null` on the same structured object, so the decision dock has a proposal to approve. That field is still structured output, not a tool.

## Steering (exactly three)
1. Exclude a hypothesis
2. Prioritize investigating a hypothesis
3. Request a class of evidence (`telemetry` | `logs` | `maintenance`)

Server replays these onto the next model-visible prompt and forces excluded / priority status onto the returned hypotheses.

## HITL
`run_diagnostic_test` is blocked until the UI Approve action sets a server-side approval flag (`session.approval.testId`). The tool `execute` checks that flag and throws `HITL_GATE` otherwise — it does not return evidence and does not read the hidden root cause on the refused path. Reject clears the flag and the current proposal and returns the phase to `awaiting_steer`.

The diagnostic resolver may read `hidden.json` only after the flag matches, and only to choose which canned outcome is consistent with the oracle. The returned JSON is an explicit field pick plus a red-line guard.

## UI (M0 ugly OK)
Incident header · Evidence board · Hypotheses panel · Trace rail · Steering trio · Decision dock for test approve.
Chat optional and must not be the only control surface. This M0 build has no chat box.

## State machine (show on screen)
`idle | ingesting | investigating | awaiting_steer | proposing_test | awaiting_test_approval | testing | updating | concluded | error`

The badge lists every phase and highlights the current one. The trail records phases actually entered.

## Runtime (locked)
Next.js + **Vercel AI SDK 7**, single Agent; model provider swappable via env (OpenAI Responses, OpenAI Chat Completions, or any OpenAI-compatible base URL). See `.env.example`.

`POST /api/agent` is one request per run. The body is NDJSON: `progress` lines are public session snapshots (phase, trace, evidence) emitted while the single `ToolLoopAgent.generate` call is still in flight, then one `result` line. Steer and diagnostic approve stay separate requests. Those HITL actions are the pauses between runs.

## M0 acceptance
- [x] App boots with `pnpm dev`
- [x] AGENTS.md + DEMO_SPEC.md in repo root
- [x] Tool stubs registered with real AI SDK tool definitions (fixture-backed)
- [x] State badge visible
- [x] One incident fixture with public/hidden split; `pnpm test` fails if hidden strings or forbidden keys enter tool results or the model-message builder
- [x] No polish required

## Out of M0
Pretty design, multi-agent, BB84/protocol simulation, production deploy, TraceWeave content.
