import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveDiagnosticEvidence } from "../lib/diagnostic-resolver";
import { readIncidentFile } from "../lib/fixture-io";
import { listSecretStrings, loadHiddenIncident } from "../lib/hidden-fixture";
import { buildSampleModelMessages } from "../lib/model-context";
import { loadDiagnosticOutcome, loadPublicIncident } from "../lib/public-fixture";
import { assertModelSafe, FORBIDDEN_PAYLOAD_KEYS } from "../lib/redline";
import {
  approveDiagnostic,
  getSession,
  rejectDiagnostic,
  resetSession,
  toPublicSession,
} from "../lib/session-store";
import { investigationTools, listRegisteredToolNames } from "../lib/tools";
import { DEFAULT_INCIDENT_ID, ENVIRONMENT_TOOL_NAMES } from "../lib/types";

const ROOT = process.cwd();
const HIDDEN_PATH = path.join(
  ROOT,
  "fixtures",
  "incidents",
  DEFAULT_INCIDENT_ID,
  "hidden.json",
);
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "agent-tools",
  "uploads",
  "out",
  "coverage",
]);
const LOADER_ALLOWLIST = new Set([
  "lib/hidden-fixture.ts",
  "lib/diagnostic-resolver.ts",
  "lib/fixture-io.ts",
  "scripts/redline-smoke.ts",
]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
      continue;
    }
    files.push(full);
  }
  return files;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

async function runTool(
  name: keyof typeof investigationTools,
  input: Record<string, unknown>,
): Promise<unknown> {
  const execute = investigationTools[name].execute;
  assert.equal(typeof execute, "function", `${name} is missing execute`);
  return execute!(input as never, {
    toolCallId: `smoke-${name}`,
    messages: [],
    abortSignal: new AbortController().signal,
  } as never);
}

function assertNoSecrets(label: string, payload: unknown, secrets: string[]) {
  assertModelSafe(label, payload, secrets);
  const serialized = JSON.stringify(payload) ?? "";
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `${label} contains a hidden string`);
  }
  const keys = new Set<string>();
  const walkKeys = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walkKeys(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      walkKeys(child);
    }
  };
  walkKeys(payload);
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    assert.equal(keys.has(key), false, `${label} contains forbidden key ${key}`);
  }
}

async function main() {
  const hidden = loadHiddenIncident();
  const secrets = listSecretStrings(hidden);
  assert.ok(secrets.length >= 4, "hidden fixture did not yield secret strings");
  for (const secret of secrets) {
    assert.ok(secret.length >= 8, "secret string is too short to police");
  }

  const files = walk(ROOT);
  for (const file of files) {
    const rel = relative(file);
    if (rel === relative(HIDDEN_PATH)) continue;
    if (!/\.(json|ts|tsx|md|js|mjs|css|txt|example)$/.test(file) && !path.basename(file).startsWith(".env")) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const secret of secrets) {
      if (text.includes(secret)) {
        throw new Error(`Red line: ${rel} contains a hidden incident string`);
      }
    }
    if (/\.(ts|tsx)$/.test(file)) {
      const mentionsLoader =
        text.includes("hidden.json") ||
        text.includes("loadHiddenIncident") ||
        text.includes("listSecretStrings");
      if (mentionsLoader && !LOADER_ALLOWLIST.has(rel)) {
        throw new Error(`Red line: ${rel} references the hidden fixture loader`);
      }
    }
  }

  assert.throws(
    () => readIncidentFile(DEFAULT_INCIDENT_ID, "hidden.json"),
    /public fixture loader/,
  );

  const names = listRegisteredToolNames().slice().sort();
  assert.deepEqual(names, [...ENVIRONMENT_TOOL_NAMES].slice().sort());
  for (const name of names) {
    assert.equal(name.toLowerCase().includes("hypothes"), false);
    assert.ok(investigationTools[name].inputSchema, `${name} is missing inputSchema`);
  }

  resetSession();
  const incidentId = DEFAULT_INCIDENT_ID;
  const telemetry = await runTool("query_telemetry", { incidentId, metric: "both" });
  const logs = await runTool("query_logs", { incidentId, source: "any", limit: 8 });
  const maintenance = await runTool("query_maintenance_context", { incidentId });
  const catalog = await runTool("list_available_diagnostics", { incidentId });
  for (const [label, payload] of [
    ["query_telemetry", telemetry],
    ["query_logs", logs],
    ["query_maintenance_context", maintenance],
    ["list_available_diagnostics", catalog],
  ] as const) {
    assertNoSecrets(label, payload, secrets);
  }

  const catalogJson = JSON.stringify(catalog);
  assert.equal(catalogJson.includes("withinLimit"), false);
  assert.equal(catalogJson.includes("observed"), false);
  for (const testId of ["pol-controller-basis-check", "channel-loss-budget", "detector-dark-count", "clock-sync-offset"]) {
    const outcome = loadDiagnosticOutcome(incidentId, testId);
    assert.equal(catalogJson.includes(outcome.observed), false, "catalog leaked an outcome");
  }

  await assert.rejects(
    () => runTool("run_diagnostic_test", { incidentId, testId: "pol-controller-basis-check" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HITL_GATE/);
      assertNoSecrets("denied diagnostic error", error.message, secrets);
      return true;
    },
  );

  approveDiagnostic("pol-controller-basis-check");
  const approved = await runTool("run_diagnostic_test", {
    incidentId,
    testId: "pol-controller-basis-check",
  });
  assertNoSecrets("approved diagnostic", approved, secrets);
  const resolved = resolveDiagnosticEvidence(incidentId, "channel-loss-budget");
  assertNoSecrets("resolver outcome", resolved, secrets);

  rejectDiagnostic();
  await assert.rejects(
    () => runTool("run_diagnostic_test", { incidentId, testId: "pol-controller-basis-check" }),
    /HITL_GATE/,
  );

  const pollutedIncident = {
    ...loadPublicIncident(),
    leakSentinel: hidden.leakSentinel,
    rootCause: hidden.rootCause,
    oracle: hidden.rootCause.oracle,
  };
  const messages = buildSampleModelMessages({
    incident: pollutedIncident,
    evidence: [
      {
        evidenceId: "ev-sample",
        sourceTool: "query_logs",
        evidenceClass: "logs",
        title: "sample",
        body: "operator closed the window",
        rootCause: hidden.rootCause,
      } as never,
    ],
    hypotheses: [
      {
        id: "h-sample",
        title: "待查",
        status: "active",
        rationale: "还没有测量",
        supportingEvidenceIds: [],
        oracle: hidden.rootCause.oracle,
      } as never,
    ],
    steering: [],
    approvedTestId: null,
  });
  assertNoSecrets("sample model messages", messages, secrets);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");

  resetSession();
  assertNoSecrets("public session", toPublicSession(getSession()), secrets);
  assert.equal(JSON.stringify(toPublicSession()).includes("withinLimit"), false);

  console.log("redline smoke: ok");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "redline smoke failed";
  console.error(message);
  process.exit(1);
});
