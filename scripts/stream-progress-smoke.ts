import assert from "node:assert/strict";
import { deskMoment, loopSteps } from "../components/desk-loop";
import {
  encodeInvestigationEvent,
  parseInvestigationLine,
  readInvestigationNdjson,
  type InvestigationEvent,
} from "../lib/investigation-events";
import { investigationResponse } from "../lib/investigation-stream";
import { collectKeys, FORBIDDEN_PAYLOAD_KEYS } from "../lib/redline";
import { resetSession, toPublicSession } from "../lib/session-store";
import { PHASE_LABELS } from "../lib/types";
import { createCompatibleProvider } from "./mock-investigator";

type TimedChunk = { at: number; text: string };

function eventsFromChunks(chunks: TimedChunk[]): InvestigationEvent[] {
  let buffer = "";
  const events: InvestigationEvent[] = [];
  for (const chunk of chunks) {
    buffer += chunk.text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) events.push(parseInvestigationLine(line));
    }
  }
  if (buffer.trim()) events.push(parseInvestigationLine(buffer));
  return events;
}

function traceByChunk(chunks: TimedChunk[]): number[] {
  let buffer = "";
  let trace = 0;
  const lengths: number[] = [];
  for (const chunk of chunks) {
    buffer += chunk.text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      trace = parseInvestigationLine(line).session.trace.length;
    }
    lengths.push(trace);
  }
  return lengths;
}

async function readTimedChunks(response: Response): Promise<TimedChunk[]> {
  assert.ok(response.body, "investigation response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const started = Date.now();
  const chunks: TimedChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push({ at: Date.now() - started, text: decoder.decode(value, { stream: true }) });
  }
  const tail = decoder.decode();
  if (tail) chunks.push({ at: Date.now() - started, text: tail });
  return chunks;
}

async function main() {
  assert.throws(() => parseInvestigationLine("not-json"), /JSON/);

  resetSession();
  const sample = toPublicSession();
  sample.phase = "ingesting";
  const encoded = encodeInvestigationEvent({ type: "progress", session: sample });
  const mid = Math.max(1, Math.floor(encoded.length / 2));
  const encoder = new TextEncoder();
  const split = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encoded.slice(0, mid)));
      controller.enqueue(encoder.encode(encoded.slice(mid)));
      controller.close();
    },
  });
  const splitSeen: InvestigationEvent[] = [];
  await readInvestigationNdjson(split, (event) => {
    splitSeen.push(event);
  });
  assert.equal(splitSeen.length, 1);
  assert.equal(splitSeen[0]?.type, "progress");
  assert.equal(splitSeen[0]?.session.phase, "ingesting");

  const previousProvider = process.env.AI_PROVIDER;
  const previousProviderName = process.env.AI_PROVIDER_NAME;
  const previousKey = process.env.AI_API_KEY;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER = "openai";
  delete process.env.AI_PROVIDER_NAME;

  try {
    resetSession();
    const provider = createCompatibleProvider("channel-loss-budget", "json-text", 40);
    const response = investigationResponse(provider.model);
    assert.match(response.headers.get("content-type") ?? "", /ndjson/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const chunks = await readTimedChunks(response);
    const events = eventsFromChunks(chunks);
    const keys = collectKeys(events);
    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      assert.equal(keys.has(key), false, `investigation stream exposed ${key}`);
    }

    assert.ok(events.length >= 4, `expected several events, got ${events.length}`);
    assert.equal(events[0]?.type, "progress");
    assert.equal(events[0]?.session.phase, "ingesting");
    assert.equal(events[0]?.session.trace.length, 0);
    assert.equal(events.filter((event) => event.type === "result").length, 1);
    assert.equal(events.at(-1)?.type, "result");

    const investigating = events.findIndex(
      (event) => event.session.phase === "investigating" && event.session.trace.length === 0,
    );
    const firstTool = events.findIndex((event) => event.session.trace.length >= 1);
    assert.ok(investigating >= 0 && firstTool > investigating, "phase stayed idle until tools finished");

    let increases = 0;
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1]?.session.trace.length ?? 0;
      const next = events[index]?.session.trace.length ?? 0;
      assert.ok(next >= previous, "trace shrank mid-run");
      if (next > previous) increases += 1;
    }
    assert.ok(increases >= 2, `expected the trail to grow at least twice, grew ${increases}`);

    const traces = traceByChunk(chunks);
    const finalTrace = traces.at(-1) ?? 0;
    assert.equal(traces[0], 0);
    assert.ok(
      traces.slice(0, -1).some((length) => length >= 1 && length < finalTrace),
      `tool rows arrived only in the last chunk: ${traces.join(",")}`,
    );
    const gap = (chunks.at(-1)?.at ?? 0) - (chunks[0]?.at ?? 0);
    assert.ok(gap >= 100, `stream was buffered until the run finished, gap ${gap}ms`);

    for (const event of events) {
      if (event.type !== "progress") continue;
      assert.notEqual(event.session.phase, "idle");
      assert.notEqual(PHASE_LABELS[event.session.phase], "空闲");
      const moment = deskMoment(event.session, true);
      assert.equal(moment.focus, "wait");
      assert.equal(moment.title, "调查进行中");
      assert.match(moment.detail, new RegExp(PHASE_LABELS[event.session.phase]));
    }

    const withTool = events.find(
      (event) => event.session.phase === "investigating" && event.session.trace.length >= 1,
    );
    assert.ok(withTool, "no investigating snapshot contained a tool row");
    assert.equal(loopSteps(withTool.session, true).find((step) => step.id === "query")?.mark, "current");

    const updating = events.find((event) => event.type === "progress" && event.session.phase === "updating");
    assert.ok(updating, "updating phase was not streamed");
    assert.equal(loopSteps(updating.session, true).find((step) => step.id === "query")?.mark, "done");
    assert.equal(loopSteps(updating.session, true).find((step) => step.id === "hypothesize")?.mark, "current");
    assert.equal(updating.session.hypotheses.length, 0);

    const last = events.at(-1);
    assert.ok(last && last.type === "result" && last.ok === true);
    if (last && last.type === "result" && last.ok) {
      assert.equal(last.session.phase, "awaiting_test_approval");
      assert.ok(last.session.hypotheses.length >= 1);
      assert.equal(last.session.proposal?.testId, "channel-loss-budget");
      assert.equal(deskMoment(last.session, false).focus, "approve");
      assert.equal(deskMoment(last.session, false).title, "批准诊断");
    }

    resetSession();
    delete process.env.AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const missingBody = investigationResponse().body;
    assert.ok(missingBody);
    const missingSeen: InvestigationEvent[] = [];
    await readInvestigationNdjson(missingBody, (event) => {
      missingSeen.push(event);
    });
    assert.equal(missingSeen[0]?.type, "progress");
    assert.equal(missingSeen[0]?.session.phase, "ingesting");
    assert.equal(missingSeen[0]?.session.trace.length, 0);
    const missingLast = missingSeen.at(-1);
    assert.ok(missingLast && missingLast.type === "result" && missingLast.ok === false);
    if (missingLast && missingLast.type === "result" && !missingLast.ok) {
      assert.equal(missingLast.session.phase, "error");
      assert.equal(missingLast.session.trace.length, 0);
      assert.match(missingLast.error, /密钥|API_KEY/);
    }

    console.log("stream progress smoke ok");
  } finally {
    if (previousProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousProvider;
    if (previousProviderName === undefined) delete process.env.AI_PROVIDER_NAME;
    else process.env.AI_PROVIDER_NAME = previousProviderName;
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : "stream progress smoke failed";
  console.error(message);
  process.exit(1);
});
