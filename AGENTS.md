<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — qkd-incident-agent (V1)

## Done-when (V1)
A stranger can complete one loop: load incident → agent queries evidence via real tools → structured hypotheses appear → human steers (exclude / prioritize / request evidence class) → human approves a diagnostic test → new evidence → hypotheses update. At least 3 real environment tool calls visible in UI. Tool/LLM failure surfaces as error, never fake success.

## Start
Package manager is **pnpm**.

```bash
pnpm install
pnpm dev
```

Open the URL Next prints (dev server is pinned to port **3457**). Copy `.env.example` → `.env.local` and set a provider key.

`pnpm test` runs the hidden-root-cause red-line smoke check.

## Red lines (do not violate)
1. **Hidden scenario root cause must never be included in model-visible context or tool results** (no system/developer prompt, no RAG stitch, no tool JSON field the model sees). `fixtures/incidents/<id>/hidden.json` is loaded only by the server diagnostic resolver (`lib/diagnostic-resolver.ts` via `lib/hidden-fixture.ts`).
2. No fake tool logs / no UI that pretends tools ran without calling the model runtime.
3. Single Agent only — no multi-agent orchestration in V1. One `ToolLoopAgent` in `lib/agent.ts`.
4. Do not implement BB84 or other QKD *protocols*; QKD is scenario skin/data only.
5. Never claim real vendor hardware, live links, or commercial key rates.
6. Do not commit unpublished research (JIT / TraceWeave) source.

## Plan discipline
If the session drifts from `DEMO_SPEC.md`, stop and revise the Plan / SPEC — do not patch randomly in a rotten chat.
