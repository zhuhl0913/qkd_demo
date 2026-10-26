"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { readInvestigationNdjson } from "@/lib/investigation-events";
import {
  briefInput,
  deskMoment,
  diffSessions,
  EVIDENCE_CLASS_LABEL,
  formatOffset,
  hasFreshEvidence,
  latestLeg,
  legLabel,
  shortTime,
  STATUS_LABEL,
  steerContinuesInvestigation,
  toolLabel,
  type DeskDiff,
  type DeskFocus,
} from "./desk-loop";
import {
  carryDemoSteer,
  DEMO_STEP_MS,
  demoApprove,
  demoContinue,
  demoEpilogue,
  demoOpening,
  demoReject,
  demoSteer,
} from "./demo-playback";
import { interpretOperatorNote, type OperatorNote } from "./operator-note";
import { demoRemainingMs, formatEta, liveRemainingMs, nowMs, postureCopy } from "./run-eta";
import { canExportReport, downloadInvestigationHandoff, downloadInvestigationReport } from "./investigation-report";
import { TutorialCoach } from "./tutorial-coach";
import {
  tutorialCanAdvance,
  tutorialCopy,
  tutorialOnOpeningFrame,
  tutorialTarget,
  type TutorialStepId,
} from "./tutorial";
import {
  PHASE_LABELS,
  type EvidenceClass,
  type EvidenceItem,
  type Hypothesis,
  type HypothesisStatus,
  type Phase,
  type PublicIncident,
  type PublicSession,
  type TraceEvent,
} from "@/lib/types";

type ApiBody = {
  ok?: boolean;
  error?: string;
  session?: PublicSession;
};

const EVIDENCE_REQUESTS = [
  ["telemetry", "遥测"],
  ["logs", "日志"],
  ["maintenance", "维护"],
] as const;

type Play = {
  gen: number;
  frames: PublicSession[];
  shown: number;
  stepStarted: number;
  frozenInto: number;
  tutorial: boolean;
};

const RUNNING_PHASES = new Set<Phase>(["ingesting", "investigating", "testing", "updating", "proposing_test"]);

function yieldPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function postJson(url: string, body?: unknown): Promise<ApiBody> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json()) as ApiBody;
  if (!response.ok && !data.error) {
    throw new Error(`请求失败（${response.status}）`);
  }
  return data;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function InvestigationDesk() {
  const [session, setSession] = useState<PublicSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [testId, setTestId] = useState("");
  const [highlight, setHighlight] = useState<DeskDiff | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [demoOn, setDemoOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [notes, setNotes] = useState<OperatorNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [etaLabel, setEtaLabel] = useState<string | null>(null);
  const [tutorialStep, setTutorialStep] = useState<TutorialStepId | null>(null);
  const [selectedHypothesisId, setSelectedHypothesisId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [openEvidenceId, setOpenEvidenceId] = useState<string | null>(null);
  const sessionRef = useRef<PublicSession | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const demoRef = useRef(false);
  const demoGen = useRef(0);
  const demoStartedRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const pausedRef = useRef(false);
  const playRef = useRef<Play | null>(null);
  const tutorialRef = useRef<TutorialStepId | null>(null);
  const liveStartedRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/session")
      .then(async (response) => {
        const data = (await response.json()) as ApiBody;
        if (!response.ok) throw new Error(data.error ?? "无法读取会话");
        return data.session;
      })
      .then((next) => {
        if (cancelled || !next) return;
        sessionRef.current = next;
        setSession(next);
        setTestId(next.proposal?.testId ?? next.diagnosticCatalog[0]?.testId ?? "");
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "无法读取会话");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function remember(next: PublicSession) {
    const diff = diffSessions(sessionRef.current, next);
    const cleared =
      next.phase === "idle" &&
      next.trace.length === 0 &&
      next.evidence.length === 0 &&
      next.hypotheses.length === 0 &&
      next.steering.length === 0;
    if (diff || cleared) setHighlight(diff);
    sessionRef.current = next;
    setSession(next);
    setSelectedHypothesisId((id) => (id && next.hypotheses.some((item) => item.id === id) ? id : null));
    setSelectedEvidenceId((id) => (id && next.evidence.some((item) => item.evidenceId === id) ? id : null));
    setOpenEvidenceId((id) => (id && next.evidence.some((item) => item.evidenceId === id) ? id : null));
    setExportNote(null);
    setTestId((current) => {
      if (next.proposal?.testId) return next.proposal.testId;
      if (next.diagnosticCatalog.some((item) => item.testId === current)) return current;
      return next.diagnosticCatalog[0]?.testId ?? "";
    });
  }

  function apply(data: ApiBody) {
    if (data.session) remember(data.session);
    setBanner(data.ok === false ? (data.error ?? "操作失败") : null);
  }

  async function run(task: () => Promise<ApiBody>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    setBanner(null);
    try {
      apply(await task());
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "请求失败");
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }

  async function runInvestigationStream() {
    if (busyRef.current || pausedRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    liveStartedRef.current = nowMs();
    setPending(true);
    setBanner(null);
    let sawResult = false;
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { Accept: "application/x-ndjson" },
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.body || !contentType.includes("ndjson")) {
        const text = await response.text();
        throw new Error(text.slice(0, 180) || `请求失败（${response.status}）`);
      }
      await readInvestigationNdjson(response.body, async (event) => {
        if (controller.signal.aborted) return;
        remember(event.session);
        if (event.type === "result") {
          sawResult = true;
          const held = event.ok === false && event.error === "已暂停。";
          setBanner(event.ok || held ? null : (event.error ?? "操作失败"));
          if (held) {
            pausedRef.current = true;
            setPaused(true);
          }
          setPending(false);
          return;
        }
        await yieldPaint();
      });
      if (!sawResult && !controller.signal.aborted) {
        const recovered = await fetch("/api/session")
          .then(async (next) => (await next.json()) as ApiBody)
          .catch(() => null);
        if (recovered?.session) remember(recovered.session);
        if (!recovered?.session || RUNNING_PHASES.has(recovered.session.phase)) {
          setBanner("这一轮的进度流中断了。");
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (pausedRef.current) {
          const recovered = await fetch("/api/session")
            .then(async (next) => (await next.json()) as ApiBody)
            .catch(() => null);
          if (recovered?.session) remember(recovered.session);
        }
        return;
      }
      setBanner(error instanceof Error ? error.message : "请求失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      busyRef.current = false;
      setPending(false);
      if (!pausedRef.current) setEtaLabel(null);
    }
  }

  function clearDemoTimers() {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
  }

  function stopDemo() {
    demoGen.current += 1;
    clearDemoTimers();
    playRef.current = null;
    demoRef.current = false;
    pausedRef.current = false;
    tutorialRef.current = null;
    setTutorialStep(null);
    setDemoOn(false);
    setPaused(false);
    setNotes([]);
    setNoteDraft("");
    setEtaLabel(null);
    busyRef.current = false;
    setPending(false);
    abortRef.current?.abort();
  }

  function finishPlay() {
    playRef.current = null;
    busyRef.current = false;
    setPending(false);
    setEtaLabel(null);
  }

  function releaseTutorialHold() {
    clearDemoTimers();
    busyRef.current = false;
    setPending(false);
    const play = playRef.current;
    if (play && play.shown < play.frames.length) {
      pausedRef.current = true;
      setPaused(true);
      play.frozenInto = nowMs() - play.stepStarted;
      setEtaLabel(`${formatEta(demoRemainingMs(play.frames.length, play.shown, play.frozenInto))} · 已暂停`);
      return;
    }
    setEtaLabel(null);
  }

  function arm(delay: number) {
    const play = playRef.current;
    if (!play) return;
    clearDemoTimers();
    const gen = play.gen;
    const id = window.setTimeout(() => {
      if (demoGen.current !== gen || pausedRef.current) return;
      const current = playRef.current;
      if (!current || current.gen !== gen) return;
      const frame = current.frames[current.shown];
      if (!frame) {
        finishPlay();
        return;
      }
      remember(frame);
      current.shown += 1;
      current.stepStarted = nowMs();
      current.frozenInto = 0;
      const guided = current.tutorial ? tutorialRef.current : null;
      if (guided) {
        const directed = tutorialOnOpeningFrame(guided, frame);
        if (directed.step !== guided) {
          tutorialRef.current = directed.step;
          setTutorialStep(directed.step);
        }
        if (directed.hold) {
          releaseTutorialHold();
          return;
        }
      }
      if (current.shown >= current.frames.length) finishPlay();
      else arm(DEMO_STEP_MS);
    }, delay);
    timersRef.current = [id];
  }

  function beginPlay(frames: PublicSession[], tutorial = false) {
    clearDemoTimers();
    const gen = ++demoGen.current;
    demoRef.current = true;
    pausedRef.current = false;
    setDemoOn(true);
    setPaused(false);
    busyRef.current = true;
    setPending(true);
    setBanner(null);
    playRef.current = { gen, frames, shown: 0, stepStarted: nowMs(), frozenInto: 0, tutorial };
    setEtaLabel(formatEta(demoRemainingMs(frames.length, 0, 0)));
    arm(0);
  }

  function rememberSteer(next: PublicSession) {
    const play = playRef.current;
    if (play) {
      play.frames = play.frames.map((frame, index) => (index >= play.shown ? carryDemoSteer(frame, next) : frame));
    }
    remember(next);
  }

  // Synthetic playback. Frames use the same PublicSession shape as the NDJSON stream.
  function playOpening(tutorial = false) {
    const base = sessionRef.current;
    if (!base || busyRef.current || pausedRef.current) return;
    demoStartedRef.current = nowMs();
    setSelectedHypothesisId(null);
    setSelectedEvidenceId(null);
    setOpenEvidenceId(null);
    setNotes([]);
    beginPlay(demoOpening(base, demoStartedRef.current), tutorial);
  }

  function playEpilogue() {
    const base = sessionRef.current;
    if (!base || busyRef.current || !demoRef.current || !base.approval) return;
    if (tutorialRef.current === "gate" || tutorialRef.current === "result") {
      tutorialRef.current = "result";
      setTutorialStep("result");
    }
    beginPlay(demoEpilogue(base, demoStartedRef.current || nowMs()));
  }

  function continueDemo(steered: PublicSession) {
    if (pausedRef.current) return;
    const frames = demoContinue(steered, demoStartedRef.current || nowMs());
    if (frames.length === 0) return;
    beginPlay(frames, tutorialRef.current !== null);
  }

  async function steerLive(body: {
    action: "exclude" | "prioritize" | "request_evidence";
    hypothesisId?: string;
    evidenceClass?: "telemetry" | "logs" | "maintenance";
  }) {
    if (busyRef.current || demoRef.current) return;
    busyRef.current = true;
    setPending(true);
    setBanner(null);
    let handoff = false;
    try {
      const data = await postJson("/api/steer", body);
      apply(data);
      handoff =
        data.ok !== false &&
        data.session != null &&
        steerContinuesInvestigation(data.session, pausedRef.current);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "请求失败");
    } finally {
      busyRef.current = false;
      setPending(false);
    }
    if (handoff) void runInvestigationStream();
  }

  function onTutorial() {
    if (!sessionRef.current || busyRef.current) return;
    stopDemo();
    tutorialRef.current = "case";
    setTutorialStep("case");
    void run(() => postJson("/api/session", { action: "reset" }));
  }

  function onTutorialNext() {
    const step = tutorialRef.current;
    if (!step || busyRef.current) return;
    if (step === "case") {
      playOpening(true);
      return;
    }
    if (step === "work") {
      tutorialRef.current = "log";
      setTutorialStep("log");
      return;
    }
    if (step === "log") {
      const play = playRef.current;
      if (!play || play.shown >= play.frames.length) return;
      play.tutorial = true;
      if (pausedRef.current) onResume();
      return;
    }
    if (step === "gate") {
      playEpilogue();
      return;
    }
    onTutorialExit();
  }

  function onTutorialSkip() {
    const step = tutorialRef.current;
    const play = playRef.current;
    tutorialRef.current = null;
    setTutorialStep(null);
    if (play) play.tutorial = false;
    if (step === "case") {
      playOpening();
      return;
    }
    if (demoRef.current && play && pausedRef.current && play.shown < play.frames.length) onResume();
  }

  function onTutorialExit() {
    const play = playRef.current;
    tutorialRef.current = null;
    setTutorialStep(null);
    if (play) play.tutorial = false;
    if (demoRef.current && play && play.shown < play.frames.length && !pausedRef.current) onPause();
  }

  function onPause() {
    const play = playRef.current;
    if (demoRef.current && play && play.shown < play.frames.length) {
      pausedRef.current = true;
      setPaused(true);
      play.frozenInto = nowMs() - play.stepStarted;
      clearDemoTimers();
      busyRef.current = false;
      setPending(false);
      setEtaLabel(`${formatEta(demoRemainingMs(play.frames.length, play.shown, play.frozenInto))} · 已暂停`);
      return;
    }
    if (!abortRef.current) return;
    pausedRef.current = true;
    setPaused(true);
    abortRef.current.abort();
    busyRef.current = false;
    setPending(false);
  }

  function onResume() {
    if (!pausedRef.current) return;
    const play = playRef.current;
    if (demoRef.current && play && play.shown < play.frames.length) {
      pausedRef.current = false;
      setPaused(false);
      busyRef.current = true;
      setPending(true);
      play.stepStarted = nowMs();
      arm(play.shown === 0 ? 0 : DEMO_STEP_MS);
      return;
    }
    pausedRef.current = false;
    setPaused(false);
    void runInvestigationStream();
  }

  function onRun() {
    if (pausedRef.current) return;
    const guided = tutorialRef.current;
    if (guided && guided !== "gate" && guided !== "result") return;
    if (demoRef.current) {
      if (sessionRef.current?.approval) playEpilogue();
      return;
    }
    void runInvestigationStream();
  }

  function onExclude(hypothesisId: string) {
    const current = sessionRef.current;
    if (!current || busyRef.current) return;
    if (demoRef.current) {
      const steered = demoSteer(current, { action: "exclude", hypothesisId, at: new Date().toISOString() });
      rememberSteer(steered);
      continueDemo(steered);
      return;
    }
    void steerLive({ action: "exclude", hypothesisId });
  }

  function onPrioritize(hypothesisId: string) {
    const current = sessionRef.current;
    if (!current || busyRef.current) return;
    if (demoRef.current) {
      const steered = demoSteer(current, { action: "prioritize", hypothesisId, at: new Date().toISOString() });
      rememberSteer(steered);
      continueDemo(steered);
      return;
    }
    void steerLive({ action: "prioritize", hypothesisId });
  }

  function onRequest(evidenceClass: "telemetry" | "logs" | "maintenance") {
    const current = sessionRef.current;
    if (!current || busyRef.current) return;
    if (demoRef.current) {
      const steered = demoSteer(current, { action: "request_evidence", evidenceClass, at: new Date().toISOString() });
      rememberSteer(steered);
      continueDemo(steered);
      return;
    }
    void steerLive({ action: "request_evidence", evidenceClass });
  }

  function onApprove() {
    const current = sessionRef.current;
    if (!current || busyRef.current) return;
    if (tutorialRef.current && !demoRef.current) return;
    const chosen = testId || current.proposal?.testId || "";
    if (demoRef.current) {
      if (!chosen) return;
      remember(demoApprove(current, chosen, new Date().toISOString()));
      return;
    }
    void run(() => postJson("/api/diagnostic", { decision: "approve", testId: chosen }));
  }

  function onReject() {
    const current = sessionRef.current;
    if (!current || busyRef.current) return;
    if (tutorialRef.current && !demoRef.current) return;
    if (demoRef.current) {
      remember(demoReject(current));
      return;
    }
    void run(() => postJson("/api/diagnostic", { decision: "reject" }));
  }

  function onNote(raw: string) {
    const current = sessionRef.current;
    if (!current) return;
    const interpreted = interpretOperatorNote(raw, current, selectedHypothesisId);
    if (!interpreted) return;
    let effect = interpreted.effect;
    let detail = interpreted.detail;
    const heldForLiveRun = effect !== "note" && !demoRef.current && busyRef.current;
    if (heldForLiveRun) {
      effect = "note";
      detail = "已记下。";
    } else if (effect === "exclude" && interpreted.hypothesisId) onExclude(interpreted.hypothesisId);
    else if (effect === "prioritize" && interpreted.hypothesisId) onPrioritize(interpreted.hypothesisId);
    else if (effect === "request_evidence" && interpreted.evidenceClass) onRequest(interpreted.evidenceClass);
    setNotes((currentNotes) => [
      ...currentNotes,
      {
        id: `note-${currentNotes.length + 1}`,
        at: new Date().toISOString(),
        text: interpreted.text,
        effect,
        detail,
        hypothesisId: heldForLiveRun ? undefined : interpreted.hypothesisId,
        evidenceClass: heldForLiveRun ? undefined : interpreted.evidenceClass,
      },
    ]);
    setNoteDraft("");
  }

  function onReset() {
    stopDemo();
    void run(() => postJson("/api/session", { action: "reset" }));
  }

  function onSelectHypothesis(hypothesisId: string) {
    setSelectedHypothesisId(hypothesisId);
  }

  function onToggleEvidence(evidenceId: string) {
    setOpenEvidenceId((current) => (current === evidenceId ? null : evidenceId));
    setSelectedEvidenceId(evidenceId);
    const current = sessionRef.current;
    if (!current) return;
    const related = current.hypotheses.filter((item) => item.supportingEvidenceIds.includes(evidenceId));
    const focus = related.find((item) => item.status === "priority") ?? related[0];
    if (focus) setSelectedHypothesisId(focus.id);
  }

  useEffect(() => {
    return () => {
      demoGen.current += 1;
      for (const id of timersRef.current) window.clearTimeout(id);
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!pending && !paused) return;
    const id = window.setInterval(() => {
      const play = playRef.current;
      const started = liveStartedRef.current;
      const currentPhase = sessionRef.current?.phase ?? "investigating";
      if (play) {
        const into = pausedRef.current ? play.frozenInto : nowMs() - play.stepStarted;
        const label = formatEta(demoRemainingMs(play.frames.length, play.shown, into));
        setEtaLabel(pausedRef.current ? `${label} · 已暂停` : label);
        return;
      }
      if (pending && started && !pausedRef.current) {
        const remaining = liveRemainingMs(currentPhase === "idle" ? "investigating" : currentPhase, nowMs() - started);
        setEtaLabel(remaining == null ? null : formatEta(remaining));
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [pending, paused]);

  const phase: Phase = session?.phase ?? "idle";
  const moment = session
    ? deskMoment(session, pending)
    : loadError
      ? { focus: "wait" as const, title: "会话没有读出来", detail: "" }
      : { focus: "wait" as const, title: "读取会话", detail: "" };
  const showApprove = moment.focus === "approve";
  const keyNote =
    session &&
    !demoOn &&
    !session.provider.configured &&
    (moment.focus === "run" || moment.focus === "rerun") &&
    !moment.detail.includes("密钥") &&
    !moment.detail.includes("API_KEY");
  const detail = keyNote ? [moment.detail, "密钥未配置。"].filter(Boolean).join(" ") : moment.detail;
  const strayBanner = banner && banner !== session?.error ? banner : null;
  const exportReady = session ? canExportReport(session) : false;
  const showRun = Boolean(session) && (moment.focus === "run" || moment.focus === "rerun" || (moment.focus === "wait" && pending));
  const showSteer = Boolean(
    session &&
      session.hypotheses.length > 0 &&
      !pending &&
      !showApprove &&
      (moment.focus === "steer" || (moment.focus === "done" && phase !== "concluded")),
  );
  const awaitingApproval = phase === "awaiting_test_approval";
  const demoBlocksLiveRun = demoOn && !session?.approval;
  const tutorialBlocksRun = tutorialStep !== null && tutorialStep !== "gate" && tutorialStep !== "result";
  let posture = postureCopy({ pending, paused, phase, focus: moment.focus });
  if (tutorialStep) {
    if ((awaitingApproval || moment.focus === "approve") && !session?.approval) posture = "等待你批准";
    else if (tutorialStep === "case") posture = "教程";
    else if (paused) posture = "教程停在这一帧";
    else if (pending) posture = "教程回放";
  }
  const showPause = pending && !paused && tutorialStep === null;
  const showResume = paused && tutorialStep === null;
  const diagnosed = session ? hasFreshEvidence(session) : false;
  const keySuffix = keyNote ? "密钥未配置。" : "";
  let railTitle = moment.title;
  let railDetail = detail;
  if (session && phase !== "error") {
    if (showResume) {
      railTitle = "已暂停";
      railDetail = "停在当前这一步。点「继续」接着跑。";
    } else if (pending) {
      railDetail = [moment.detail, etaLabel].filter(Boolean).join(" · ");
    } else if (moment.focus === "rerun" && session.approval) {
      const approvedId = session.approval.testId;
      const approvedName = session.diagnosticCatalog.find((item) => item.testId === approvedId)?.title ?? approvedId;
      railTitle = `已批准「${approvedName}」`;
      railDetail = joinCopy("点「再运行调查」执行这项测试，结果作为新证据回到假设。", keySuffix);
    } else if (moment.focus === "steer") {
      railTitle = diagnosed ? "诊断结果已回填" : "定方向";
      railDetail = diagnosed
        ? "对照中栏看假设变化。还要查就补一类证据，收尾就导出交接稿。"
        : "在中栏排除或先查一条假设，或在这里补一类证据。";
    } else if (moment.focus === "approve") {
      railDetail = "批准后只跑这项诊断，不改设备。";
    } else if (moment.focus === "done") {
      railTitle = "调查已结束";
      railDetail = "导出交接稿留档。要重来，点右上「重置」。";
    } else if (moment.focus === "run") {
      railDetail = joinCopy(
        session.steering.length > 0 ? "转向已记下，运行后按新方向再查。" : "代理会查遥测、日志和维护记录，再给出假设。",
        keySuffix,
      );
    }
  }
  const emphasizeExport = exportReady && !pending && (moment.focus === "done" || (moment.focus === "steer" && diagnosed));
  const tutorialApproved = Boolean(session?.approval);
  const tutorialRejected = tutorialStep === "gate" && !tutorialApproved && session?.proposal == null;
  const tutorialView = tutorialStep
    ? tutorialCopy(tutorialStep, { pending, approved: tutorialApproved, rejected: tutorialRejected })
    : null;
  const tutorialReady = tutorialStep
    ? tutorialCanAdvance(tutorialStep, { pending: pending || busyRef.current, approved: tutorialApproved })
    : false;
  const coachLocks = tutorialStep !== null && tutorialStep !== "result";

  return (
    <main
      className="nw flex h-dvh min-h-0 w-full flex-col overflow-hidden"
      data-desk-layout="wide"
      data-desk-focus={moment.focus}
      data-phase={phase}
      data-demo={tutorialStep ? "tutorial" : demoOn ? "playback" : "off"}
      data-tutorial={tutorialStep ?? "off"}
      data-paused={paused ? "true" : "false"}
      data-posture={posture}
      aria-busy={pending}
    >
      <header
        className="nw-bar flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5"
        inert={coachLocks ? true : undefined}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-2">
            <span className="nw-mark" aria-hidden="true" />
            <span className="nw-kicker">事件调查台</span>
          </span>
          <h1 className="text-[15px] font-semibold">{session?.incident.title ?? "合成 QKD 运维事件"}</h1>
          {session ? (
            <span className="nw-faint font-mono text-xs">
              {session.incident.severity.toUpperCase()} · {session.incident.id}
            </span>
          ) : null}
          {demoOn ? (
            <span className="nw-badge" title="回放预制帧，不调用模型和工具">
              合成回放
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tutorialStep === null ? (
            <DeskButton
              tone="quiet"
              disabled={!session || pending}
              title="带说明的合成回放，不调用模型"
              data-action="tutorial"
              onClick={onTutorial}
            >
              教程
            </DeskButton>
          ) : null}
          <HandoffExport
            ready={exportReady}
            emphasize={emphasizeExport}
            onMarkdown={() => {
              if (!session || !canExportReport(session)) return;
              const fileName = downloadInvestigationReport(session, new Date().toISOString(), notes);
              setExportNote(`已下载 ${fileName}`);
            }}
            onJson={() => {
              if (!session || !canExportReport(session)) return;
              const fileName = downloadInvestigationHandoff(session, new Date().toISOString(), notes);
              setExportNote(`已下载 ${fileName}`);
            }}
          />
          <DeskButton tone="quiet" disabled={pending || !session} title="清空这次调查" onClick={onReset}>
            <ResetMark />
            重置
          </DeskButton>
        </div>
      </header>

      {exportNote || strayBanner || loadError ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--nw-line)] px-4 py-2" inert={coachLocks ? true : undefined}>
          {exportNote ? (
            <p className="nw-muted text-sm" role="status">
              {exportNote}
            </p>
          ) : null}
          {strayBanner ? <Alert>{strayBanner}</Alert> : null}
          {loadError ? <Alert>{loadError}</Alert> : null}
        </div>
      ) : null}

      <div className="nw-scroll min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)_minmax(19rem,24rem)] lg:overflow-hidden">
        <CaseColumn session={session} locked={coachLocks && tutorialTarget(tutorialStep ?? "case") !== "case"} />
        <WorkColumn
          session={session}
          highlight={highlight}
          pending={pending}
          selectedHypothesisId={selectedHypothesisId}
          selectedEvidenceId={selectedEvidenceId}
          openEvidenceId={openEvidenceId}
          onSelectHypothesis={onSelectHypothesis}
          onToggleEvidence={onToggleEvidence}
          onExclude={onExclude}
          onPrioritize={onPrioritize}
          locked={coachLocks && (tutorialStep == null || tutorialTarget(tutorialStep) !== "work")}
        />
        <TrailColumn
          session={session}
          highlight={highlight}
          pending={pending}
          phase={phase}
          notes={notes}
          noteDraft={noteDraft}
          onDraft={setNoteDraft}
          onNote={onNote}
          locked={coachLocks && (tutorialStep == null || tutorialTarget(tutorialStep) !== "log")}
        />
      </div>

      <DecisionRail
        phase={phase}
        title={railTitle}
        detail={railDetail}
        focus={moment.focus}
        pending={pending}
        session={session}
        testId={testId}
        etaLabel={etaLabel}
        showApprove={showApprove}
        showRun={showRun}
        showSteer={showSteer}
        showPause={showPause}
        showResume={showResume}
        awaitingApproval={awaitingApproval}
        demoBlocksLiveRun={demoBlocksLiveRun}
        tutorialBlocksRun={tutorialBlocksRun}
        locked={coachLocks && (tutorialStep == null || tutorialTarget(tutorialStep) !== "hitl")}
        onTestId={setTestId}
        onPause={onPause}
        onResume={onResume}
        onRun={onRun}
        onApprove={onApprove}
        onReject={onReject}
        onRequest={onRequest}
      />
      {tutorialStep && tutorialView ? (
        <TutorialCoach
          step={tutorialStep}
          copy={tutorialView}
          canAdvance={tutorialReady}
          layoutKey={`${phase}:${session?.evidence.length ?? 0}:${session?.hypotheses.length ?? 0}:${session?.trace.length ?? 0}:${paused ? "paused" : "run"}`}
          onNext={onTutorialNext}
          onSkip={onTutorialSkip}
          onExit={onTutorialExit}
        />
      ) : null}
    </main>
  );
}

function CaseColumn({ session, locked }: { session: PublicSession | null; locked?: boolean }) {
  return (
    <section
      className="nw-scroll nw-side border-b px-4 py-4 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0"
      aria-label="链路与症状"
      data-tutorial-target="case"
      inert={locked ? true : undefined}
    >
      <SectionHead title="链路" />
      {session ? <LinkDiagram incident={session.incident} /> : null}
      {session ? (
        <>
          <div className="mt-6">
            <SectionHead title="症状" />
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {session.incident.symptoms.map((symptom) => (
              <li key={symptom} className="flex gap-2 text-sm leading-5">
                <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 bg-[var(--nw-pop)]" />
                <span>{symptom}</span>
              </li>
            ))}
          </ul>
          <dl className="nw-panel mt-6 divide-y divide-[var(--nw-line)] text-sm">
            <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 px-3 py-2.5">
              <dt className="nw-faint text-xs leading-5">观察窗</dt>
              <dd className="font-mono text-xs leading-5">
                {shortTime(session.incident.timeWindow.from)} – {shortTime(session.incident.timeWindow.to)}
              </dd>
            </div>
            <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 px-3 py-2.5">
              <dt className="nw-faint text-xs leading-5">开单</dt>
              <dd className="font-mono text-xs leading-5">{shortTime(session.incident.openedAt)}</dd>
            </div>
            <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 px-3 py-2.5">
              <dt className="nw-faint text-xs leading-5">维护</dt>
              <dd className="leading-5">{session.incident.maintenanceWindowSummary}</dd>
            </div>
          </dl>
        </>
      ) : null}
    </section>
  );
}

function LinkDiagram({ incident }: { incident: PublicIncident }) {
  return (
    <div
      className="mt-3"
      aria-label={`链路 ${incident.nodes.alice} 经 ${incident.nodes.linkId} 到 ${incident.nodes.bob}`}
    >
      <div className="flex items-start gap-2">
        <Endpoint role="Alice" nodeId={incident.nodes.alice} />
        <div className="flex min-w-0 flex-1 flex-col items-center pt-3">
          <svg viewBox="0 0 120 16" className="h-4 w-full text-[var(--nw-line-strong)]" aria-hidden="true">
            <line x1="0" y1="8" x2="50" y2="8" stroke="currentColor" strokeWidth="1" />
            <path d="M60 2 L68 8 L60 14 L52 8 Z" fill="none" stroke="var(--nw-pop)" strokeWidth="1" />
            <line x1="70" y1="8" x2="120" y2="8" stroke="currentColor" strokeWidth="1" />
          </svg>
          <p className="nw-pop-text mt-1 text-xs">{incident.nodes.linkId}</p>
        </div>
        <Endpoint role="Bob" nodeId={incident.nodes.bob} />
      </div>
    </div>
  );
}

function Endpoint({ role, nodeId }: { role: string; nodeId: string }) {
  return (
    <div className="flex w-24 shrink-0 flex-col items-center gap-1.5 text-center">
      <NodeGlyph />
      <span className="text-sm">{role}</span>
      <span className="nw-faint text-[11px] leading-4 break-all">{nodeId}</span>
    </div>
  );
}

function NodeGlyph() {
  return (
    <svg width="36" height="36" viewBox="0 0 32 32" aria-hidden="true" className="text-[var(--nw-text)]">
      <rect x="2" y="2" width="28" height="28" fill="var(--nw-panel)" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="16" cy="16" r="6" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="16" cy="16" r="1.6" fill="currentColor" />
    </svg>
  );
}

function WorkColumn({
  session,
  highlight,
  pending,
  selectedHypothesisId,
  selectedEvidenceId,
  openEvidenceId,
  onSelectHypothesis,
  onToggleEvidence,
  onExclude,
  onPrioritize,
  locked,
}: {
  session: PublicSession | null;
  highlight: DeskDiff | null;
  pending: boolean;
  selectedHypothesisId: string | null;
  selectedEvidenceId: string | null;
  openEvidenceId: string | null;
  onSelectHypothesis: (hypothesisId: string) => void;
  onToggleEvidence: (evidenceId: string) => void;
  onExclude: (hypothesisId: string) => void;
  onPrioritize: (hypothesisId: string) => void;
  locked?: boolean;
}) {
  return (
    <section
      className="nw-scroll border-b border-[var(--nw-line)] px-4 py-4 lg:min-h-0 lg:overflow-y-auto lg:border-b-0"
      aria-label="假设与证据"
      data-tutorial-target="work"
      inert={locked ? true : undefined}
    >
      <HypothesisBoard
        session={session}
        highlight={highlight}
        pending={pending}
        selectedHypothesisId={selectedHypothesisId}
        selectedEvidenceId={selectedEvidenceId}
        onSelectHypothesis={onSelectHypothesis}
        onExclude={onExclude}
        onPrioritize={onPrioritize}
      />
      <div className="mt-6">
        <EvidenceBoard
          session={session}
          highlight={highlight}
          pending={pending}
          selectedHypothesisId={selectedHypothesisId}
          selectedEvidenceId={selectedEvidenceId}
          openEvidenceId={openEvidenceId}
          onToggleEvidence={onToggleEvidence}
        />
      </div>
    </section>
  );
}

function DecisionRail({
  phase,
  title,
  detail,
  focus,
  pending,
  session,
  testId,
  etaLabel,
  showApprove,
  showRun,
  showSteer,
  showPause,
  showResume,
  awaitingApproval,
  demoBlocksLiveRun,
  tutorialBlocksRun,
  locked,
  onTestId,
  onPause,
  onResume,
  onRun,
  onApprove,
  onReject,
  onRequest,
}: {
  phase: Phase;
  title: string;
  detail: string;
  focus: DeskFocus;
  pending: boolean;
  session: PublicSession | null;
  testId: string;
  etaLabel: string | null;
  showApprove: boolean;
  showRun: boolean;
  showSteer: boolean;
  showPause: boolean;
  showResume: boolean;
  awaitingApproval: boolean;
  demoBlocksLiveRun: boolean;
  tutorialBlocksRun: boolean;
  locked?: boolean;
  onTestId: (id: string) => void;
  onPause: () => void;
  onResume: () => void;
  onRun: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRequest: (evidenceClass: "telemetry" | "logs" | "maintenance") => void;
}) {
  const runLabel = focus === "rerun" ? "再运行调查" : "运行调查";
  const needsHuman = awaitingApproval || showResume || (focus === "rerun" && Boolean(session?.approval));
  return (
    <footer
      className={cx("nw-rail shrink-0 px-4 py-3", needsHuman && "nw-rail-awaiting")}
      data-hitl-rail="true"
      data-tutorial-target="hitl"
      data-awaiting-approval={awaitingApproval ? "true" : "false"}
      data-eta={etaLabel ?? ""}
      data-phase={phase}
      aria-label="决策"
      inert={locked ? true : undefined}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 lg:max-w-2xl" aria-live="polite">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span
              aria-hidden="true"
              className={cx("nw-dot", needsHuman && "nw-dot-pop", pending && "nw-dot-live")}
            />
            {title}
          </p>
          {detail ? <p className="nw-muted mt-1 text-sm leading-5">{detail}</p> : null}
          {showApprove && session?.proposal ? <p className="mt-1 text-sm leading-5">{session.proposal.reason}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {showApprove && session ? (
            <ApproveControls
              session={session}
              pending={pending}
              testId={testId}
              onTestId={onTestId}
              onApprove={onApprove}
              onReject={onReject}
            />
          ) : null}
          {showSteer ? (
            <div className="flex flex-col items-start gap-1">
              <RequestButtons pending={pending} onRequest={onRequest} />
              <EvidenceRequestNote session={session} />
            </div>
          ) : null}
          {showPause ? (
            <DeskButton tone="quiet" data-action="pause" onClick={onPause}>
              暂停
            </DeskButton>
          ) : null}
          {showResume ? (
            <DeskButton tone="primary" className="px-4" data-action="resume" onClick={onResume}>
              继续
            </DeskButton>
          ) : null}
          {showRun && !pending ? (
            <>
              {focus === "rerun" ? (
                <DeskButton tone="quiet" onClick={onReject}>
                  撤回批准
                </DeskButton>
              ) : null}
              <DeskButton
                tone="primary"
                className="px-4"
                disabled={!session || demoBlocksLiveRun || tutorialBlocksRun}
                title={demoBlocksLiveRun ? "合成回放中。要走真实接口，先重置。" : undefined}
                onClick={onRun}
              >
                {runLabel}
              </DeskButton>
            </>
          ) : null}
        </div>
      </div>
    </footer>
  );
}

function ApproveControls({
  session,
  pending,
  testId,
  onTestId,
  onApprove,
  onReject,
}: {
  session: PublicSession;
  pending: boolean;
  testId: string;
  onTestId: (id: string) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const catalog = session.diagnosticCatalog;
  const selected = catalog.find((item) => item.testId === testId);
  const proposal = session.proposal;
  const proposalTitle = proposal
    ? (catalog.find((item) => item.testId === proposal.testId)?.title ?? proposal.testId)
    : "";
  return (
    <div className="flex flex-col gap-2" aria-label="诊断批准">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-2 text-sm" htmlFor="diagnostic-select">
          <span className="nw-faint shrink-0">测试</span>
          <select
            id="diagnostic-select"
            className="nw-select min-w-0 max-w-72 px-2 py-1.5 text-sm"
            value={testId}
            disabled={catalog.length === 0 || pending}
            onChange={(event) => onTestId(event.target.value)}
          >
            {catalog.map((item) => (
              <option key={item.testId} value={item.testId}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <DeskButton tone="quiet" disabled={pending || (!proposal && !session.approval)} onClick={onReject}>
          拒绝
        </DeskButton>
        <DeskButton tone="pop" className="px-4" disabled={pending || !testId} onClick={onApprove}>
          批准
        </DeskButton>
      </div>
      {selected ? <p className="nw-faint max-w-xl text-xs leading-5">{selected.measures}</p> : null}
      {proposal && selected && proposal.testId !== selected.testId ? (
        <p className="nw-faint max-w-xl text-xs leading-5">
          当前选择是「{selected.title}」，提案是「{proposalTitle}」。
        </p>
      ) : null}
    </div>
  );
}

function HypothesisBoard({
  session,
  highlight,
  pending,
  selectedHypothesisId,
  selectedEvidenceId,
  onSelectHypothesis,
  onExclude,
  onPrioritize,
}: {
  session: PublicSession | null;
  highlight: DeskDiff | null;
  pending: boolean;
  selectedHypothesisId: string | null;
  selectedEvidenceId: string | null;
  onSelectHypothesis: (hypothesisId: string) => void;
  onExclude: (hypothesisId: string) => void;
  onPrioritize: (hypothesisId: string) => void;
}) {
  const hypotheses = session?.hypotheses ?? [];
  const showSkeleton = hypotheses.length === 0 && Boolean(session) && (pending || RUNNING_PHASES.has(session?.phase ?? "idle"));
  return (
    <div className="flex flex-col gap-3">
      <SectionHead
        title="假设"
        meta={
          hypotheses.length === 0
            ? undefined
            : selectedHypothesisId
              ? `${hypotheses.length} 条`
              : `${hypotheses.length} 条 · 点一条可排除或先查`
        }
      />
      {hypotheses.length > 0 && session ? (
        <ul className="flex flex-col gap-3">
          {hypotheses.map((item) => (
            <HypothesisCard
              key={item.id}
              item={item}
              session={session}
              highlight={highlight}
              pending={pending}
              selected={item.id === selectedHypothesisId}
              linked={Boolean(selectedEvidenceId) && item.supportingEvidenceIds.includes(selectedEvidenceId ?? "") && item.id !== selectedHypothesisId}
              onSelect={() => onSelectHypothesis(item.id)}
              onExclude={() => onExclude(item.id)}
              onPrioritize={() => onPrioritize(item.id)}
            />
          ))}
        </ul>
      ) : null}
      {showSkeleton && session ? <DeskSkeleton label={PHASE_LABELS[session.phase]} /> : null}
    </div>
  );
}

function HypothesisCard({
  item,
  session,
  highlight,
  pending,
  selected,
  linked,
  onSelect,
  onExclude,
  onPrioritize,
}: {
  item: Hypothesis;
  session: PublicSession;
  highlight: DeskDiff | null;
  pending: boolean;
  selected: boolean;
  linked: boolean;
  onSelect: () => void;
  onExclude: () => void;
  onPrioritize: () => void;
}) {
  const change = highlight?.statusChanges[item.id];
  const isNew = highlight?.newHypothesisIds.includes(item.id) ?? false;
  const textChanged = highlight?.textChanges.includes(item.id) ?? false;
  const marked = Boolean(change) || isNew || textChanged;
  const evidenceNames = item.supportingEvidenceIds.map((evidenceId) => {
    const found = session.evidence.find((entry) => entry.evidenceId === evidenceId);
    return found ? found.title : evidenceId;
  });
  return (
    <li
      className={cx(
        "nw-panel nw-card relative p-3",
        selected && "nw-selected",
        !selected && linked && "nw-linked",
        marked && "desk-new",
        !selected && !linked && item.status === "priority" && "nw-priority",
        item.status === "excluded" && "opacity-60",
      )}
      data-hypothesis={item.id}
      data-selected={selected ? "true" : "false"}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className={cx("min-w-0 text-[15px] font-semibold leading-6", item.status === "excluded" && "line-through")}>
          <button
            type="button"
            className="text-left after:absolute after:inset-0 after:content-['']"
            aria-pressed={selected}
            onClick={onSelect}
          >
            {item.title}
          </button>
        </h3>
        <span className="flex shrink-0 items-center gap-2">
          {change ? (
            <span className="nw-pop-text text-xs">
              {STATUS_LABEL[change.from]} → {STATUS_LABEL[change.to]}
            </span>
          ) : null}
          {isNew ? <span className="nw-pop-text text-xs">新</span> : null}
          {!isNew && !change && textChanged ? <span className="nw-pop-text text-xs">依据已更新</span> : null}
          <StatusBadge status={item.status} />
        </span>
      </div>
      <p className={cx("nw-muted mt-1.5 text-sm leading-6", !selected && "line-clamp-2")}>{item.rationale}</p>
      {selected ? (
        <div className="relative z-10 mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--nw-line)] pt-3">
          <p className="nw-faint min-w-0 text-xs leading-5">
            {evidenceNames.length > 0 ? `依据：${evidenceNames.join("、")}` : "暂无直接证据"}
          </p>
          <span className="flex gap-2">
            <DeskButton tone="quiet" className="px-2.5 py-1 text-xs" disabled={pending || item.status === "priority"} onClick={onPrioritize}>
              先查这条
            </DeskButton>
            <DeskButton tone="quiet" className="px-2.5 py-1 text-xs" disabled={pending || item.status === "excluded"} onClick={onExclude}>
              排除
            </DeskButton>
          </span>
        </div>
      ) : null}
    </li>
  );
}

function EvidenceRequestNote({ session }: { session: PublicSession | null }) {
  const latest = [...(session?.steering ?? [])].reverse().find((record) => record.action === "request_evidence");
  if (!latest?.evidenceClass) return null;
  return <p className="nw-faint text-xs">已请求{EVIDENCE_CLASS_LABEL[latest.evidenceClass]}。</p>;
}

function HandoffExport({
  ready,
  emphasize,
  onMarkdown,
  onJson,
}: {
  ready: boolean;
  emphasize: boolean;
  onMarkdown: () => void;
  onJson: () => void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const pick = (action: () => void) => {
    action();
    menuRef.current?.removeAttribute("open");
  };
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  if (!ready) {
    return (
      <DeskButton tone="quiet" disabled title="还没有可导出的假设或证据" data-action="export-report">
        交接稿
      </DeskButton>
    );
  }
  return (
    <details ref={menuRef} className="nw-menu relative" aria-label="交接稿">
      <summary className={cx("nw-btn px-3 py-1.5 text-sm", emphasize && "nw-btn-primary")}>
        交接稿
        <Chevron open />
      </summary>
      <div className="nw-menu-list" role="menu">
        <button type="button" role="menuitem" data-action="export-report" onClick={() => pick(onMarkdown)}>
          <span>Markdown</span>
          <span className="nw-faint text-xs">给人看</span>
        </button>
        <button type="button" role="menuitem" data-action="export-json" onClick={() => pick(onJson)}>
          <span>JSON</span>
          <span className="nw-faint text-xs">公开会话</span>
        </button>
      </div>
    </details>
  );
}

function RequestButtons({
  pending,
  onRequest,
}: {
  pending: boolean;
  onRequest: (evidenceClass: "telemetry" | "logs" | "maintenance") => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="请求证据">
      {EVIDENCE_REQUESTS.map(([evidenceClass, label]) => (
        <DeskButton key={evidenceClass} tone="quiet" disabled={pending} onClick={() => onRequest(evidenceClass)}>
          请求{label}
        </DeskButton>
      ))}
    </div>
  );
}

// Accordion with progressive disclosure: compact summary, expand for provenance and body.
function EvidenceBoard({
  session,
  highlight,
  pending,
  selectedHypothesisId,
  selectedEvidenceId,
  openEvidenceId,
  onToggleEvidence,
}: {
  session: PublicSession | null;
  highlight: DeskDiff | null;
  pending: boolean;
  selectedHypothesisId: string | null;
  selectedEvidenceId: string | null;
  openEvidenceId: string | null;
  onToggleEvidence: (evidenceId: string) => void;
}) {
  const evidence = session?.evidence ?? [];
  const fresh = new Set([...(highlight?.evidenceIds ?? []), ...(highlight?.updatedEvidenceIds ?? [])]);
  const selectedHypothesis = session?.hypotheses.find((item) => item.id === selectedHypothesisId);
  const showSkeleton = evidence.length === 0 && Boolean(session) && (pending || RUNNING_PHASES.has(session?.phase ?? "idle"));
  return (
    <div className="flex flex-col gap-3">
      <SectionHead title="证据" meta={evidence.length > 0 ? `${evidence.length} 条` : undefined} />
      {evidence.length === 0 || !session ? null : (
        <ul className="flex flex-col gap-3">
          {evidence.map((item) => (
            <EvidenceCard
              key={item.evidenceId}
              item={item}
              session={session}
              fresh={fresh.has(item.evidenceId)}
              selected={item.evidenceId === selectedEvidenceId}
              linked={selectedHypothesis?.supportingEvidenceIds.includes(item.evidenceId) ?? false}
              open={item.evidenceId === openEvidenceId}
              onToggle={() => onToggleEvidence(item.evidenceId)}
            />
          ))}
        </ul>
      )}
      {showSkeleton ? <DeskSkeleton label="" /> : null}
    </div>
  );
}

function EvidenceCard({
  item,
  session,
  fresh,
  selected,
  linked,
  open,
  onToggle,
}: {
  item: EvidenceItem;
  session: PublicSession;
  fresh: boolean;
  selected: boolean;
  linked: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const diagnostic = item.evidenceClass === "diagnostic";
  const summary = item.body.split("\n")[0] ?? "";
  const provenance = evidenceProvenance(session, item);
  return (
    <li
      className={cx(
        "nw-panel nw-card overflow-hidden",
        selected && "nw-selected",
        !selected && linked && "nw-linked",
        fresh && "desk-new",
      )}
      data-evidence={item.evidenceId}
      data-open={open ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
    >
      <button type="button" className="nw-toggle flex w-full items-start gap-3 p-3 text-left" aria-expanded={open} onClick={onToggle}>
        <EvidenceGlyph evidenceClass={item.evidenceClass} />
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-3">
            <span className="text-sm font-medium leading-6">{item.title}</span>
            <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs">
              {fresh ? <span className="nw-pop-text">新</span> : null}
              <span className={diagnostic ? "nw-pop-text" : "nw-faint"}>{EVIDENCE_CLASS_LABEL[item.evidenceClass]}</span>
            </span>
          </span>
          {open ? null : <span className="nw-muted mt-1 line-clamp-1 block text-sm">{summary}</span>}
        </span>
        <span className="nw-faint pt-1.5">
          <Chevron open={open} />
        </span>
      </button>
      {open ? (
        <div className="border-t border-[var(--nw-line)] px-3 pt-2.5 pb-3 pl-13">
          <pre className="text-sm leading-6">{item.body}</pre>
          <p className="nw-faint mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
            {provenance ? <span>来源 {provenance}</span> : null}
            <MiniLink incident={session.incident} />
          </p>
        </div>
      ) : null}
    </li>
  );
}

function DeskSkeleton({ label }: { label: string }) {
  return (
    <div className="nw-panel p-3" aria-hidden="true">
      {label ? <span className="nw-badge">{label}</span> : null}
      <div className="nw-skel mt-3 h-3 w-2/3" />
      <div className="nw-skel mt-2 h-3 w-1/2" />
    </div>
  );
}

function EvidenceGlyph({ evidenceClass }: { evidenceClass: EvidenceClass }) {
  const diagnostic = evidenceClass === "diagnostic";
  return (
    <span
      className={cx(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
        diagnostic
          ? "border-[var(--nw-pop)] bg-[var(--nw-pop-wash)] text-[var(--nw-pop)]"
          : "border-[var(--nw-line)] bg-[var(--nw-panel-2)] text-[var(--nw-muted)]",
      )}
      title={EVIDENCE_CLASS_LABEL[evidenceClass]}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        {evidenceClass === "telemetry" ? (
          <path d="M1 11.5 L4.2 11.5 L6 5 L8.2 12.5 L10.2 7 L12 9 L15 9" fill="none" stroke="currentColor" strokeWidth="1.25" />
        ) : null}
        {evidenceClass === "logs" ? (
          <path d="M2 3.5 H14 M2 8 H14 M2 12.5 H9" fill="none" stroke="currentColor" strokeWidth="1.25" />
        ) : null}
        {evidenceClass === "maintenance" ? (
          <>
            <rect x="2" y="3" width="12" height="11" fill="none" stroke="currentColor" strokeWidth="1.25" />
            <path d="M2 6.5 H14 M5 1.5 V4 M11 1.5 V4" fill="none" stroke="currentColor" strokeWidth="1.25" />
          </>
        ) : null}
        {evidenceClass === "diagnostic" ? (
          <>
            <circle cx="8" cy="8" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
            <path d="M8 1.5 V4 M8 12 V14.5 M1.5 8 H4 M12 8 H14.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
          </>
        ) : null}
      </svg>
    </span>
  );
}

function MiniLink({ incident }: { incident: PublicIncident }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[var(--nw-faint)]"
      aria-label={`${incident.nodes.alice} 经 ${incident.nodes.linkId} 到 ${incident.nodes.bob}`}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      <span aria-hidden="true" className="h-px w-3 bg-[var(--nw-line-strong)]" />
      <span aria-hidden="true" className="h-1.5 w-1.5 rotate-45 border border-[var(--nw-pop)]" />
      <span aria-hidden="true" className="h-px w-3 bg-[var(--nw-line-strong)]" />
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </span>
  );
}

function TrailColumn({
  session,
  highlight,
  pending,
  phase,
  notes,
  noteDraft,
  onDraft,
  onNote,
  locked,
}: {
  session: PublicSession | null;
  highlight: DeskDiff | null;
  pending: boolean;
  phase: Phase;
  notes: OperatorNote[];
  noteDraft: string;
  onDraft: (value: string) => void;
  onNote: (text: string) => void;
  locked?: boolean;
}) {
  const trail = session?.phaseTrail ?? [];
  const path = latestLeg(trail).length > 1 ? legLabel(trail) : "";
  const count = session?.trace.length ?? 0;
  return (
    <aside
      className="nw-side flex flex-col lg:min-h-0 lg:overflow-hidden lg:border-l"
      aria-label="运行日志"
      data-tutorial-target="log"
      inert={locked ? true : undefined}
    >
      <div className="shrink-0 border-b border-[var(--nw-line)] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <SectionHead title="运行日志" meta={count > 0 ? `${count} 次调用` : undefined} />
          <span className={cx("nw-badge", (phase === "awaiting_test_approval" || phase === "error") && "nw-badge-priority")}>
            {PHASE_LABELS[phase]}
          </span>
        </div>
        {path ? <p className="nw-faint mt-1.5 text-xs leading-5">{path}</p> : null}
      </div>
      <div className="nw-scroll px-4 py-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <RunLog session={session} highlight={highlight} pending={pending} phase={phase} notes={notes} />
      </div>
      <form
        className="flex shrink-0 gap-2 border-t border-[var(--nw-line)] px-4 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          onNote(noteDraft);
        }}
      >
        <input
          className="nw-input min-w-0 flex-1 px-2.5 py-1.5 text-sm"
          value={noteDraft}
          placeholder="备注，或「排除」「先查」「看日志」"
          aria-label="操作备注"
          title="排除、优先、看遥测、看日志、看维护，或自由备注"
          data-action="operator-note"
          disabled={!session}
          onChange={(event) => onDraft(event.target.value)}
        />
        <DeskButton tone="quiet" disabled={!session || noteDraft.trim().length === 0} onClick={() => onNote(noteDraft)}>
          记下
        </DeskButton>
      </form>
    </aside>
  );
}

function RunLog({
  session,
  highlight,
  pending,
  phase,
  notes,
}: {
  session: PublicSession | null;
  highlight: DeskDiff | null;
  pending: boolean;
  phase: Phase;
  notes: OperatorNote[];
}) {
  const trace = [...(session?.trace ?? [])].sort((left, right) => left.at.localeCompare(right.at));
  const fresh = new Set(highlight?.traceIds ?? []);
  const origin = traceOrigin(trace);
  const showLive = pending && phase !== "idle";
  const showError = !pending && phase === "error" && Boolean(session?.error);
  if (trace.length === 0 && notes.length === 0 && !showLive && !showError) return null;
  return (
    <ol>
      {trace.map((event) => (
        <ToolRow key={event.id} event={event} origin={origin} fresh={fresh.has(event.id)} />
      ))}
      {notes.map((note) => (
        <li key={note.id} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 border-b border-[var(--nw-line)] py-2.5 last:border-b-0" data-note={note.id}>
          <span className="nw-faint pt-0.5 font-mono text-[11px]">注</span>
          <div className="min-w-0">
            <p className="text-sm">{note.text}</p>
            <p className="nw-faint mt-1 text-xs">{note.detail}</p>
          </div>
        </li>
      ))}
      {showLive ? (
        <li className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 border-b border-[var(--nw-line)] py-2.5 last:border-b-0">
          <span className="flex items-center pt-1.5">
            <span aria-hidden="true" className="nw-dot nw-dot-live" />
          </span>
          <p className="text-sm font-medium">{PHASE_LABELS[phase]}…</p>
        </li>
      ) : null}
      {showError ? (
        <li className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 py-2.5">
          <span className="nw-faint pt-0.5 font-mono text-[11px]">—</span>
          <div className="min-w-0">
            <p className="nw-pop-text text-sm font-medium">{PHASE_LABELS.error}</p>
            <p className="nw-muted mt-1 text-xs leading-5">{session?.error}</p>
          </div>
        </li>
      ) : null}
    </ol>
  );
}

function ToolRow({ event, origin, fresh }: { event: TraceEvent; origin: number | null; fresh: boolean }) {
  const summary = briefInput(event.input);
  const failed = event.status === "error";
  const stamp = formatStamp(event.at, origin);
  return (
    <li
      className={cx(
        "grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 border-b border-[var(--nw-line)] py-2.5 last:border-b-0",
        fresh && "desk-new",
      )}
    >
      <span className="nw-faint pt-0.5 font-mono text-[11px]">{stamp}</span>
      <div className="min-w-0">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className={cx("shrink-0 text-sm font-medium", failed && "nw-pop-text")}>{toolLabel(event.toolName)}</span>
          <span className="nw-faint truncate font-mono text-[11px]">{event.toolName}</span>
        </p>
        {summary ? <p className="nw-muted mt-1 text-xs leading-5">{summary}</p> : null}
        {failed ? <p className="nw-pop-text mt-1 text-xs leading-5">{event.error}</p> : null}
        <details className="mt-1">
          <summary className="nw-faint text-xs">原始 JSON</summary>
          <p className="nw-faint mt-2 text-[11px]">入参</p>
          <pre className="nw-code mt-1">{JSON.stringify(event.input, null, 2)}</pre>
          {event.status === "ok" ? (
            <>
              <p className="nw-faint mt-2 text-[11px]">返回</p>
              <pre className="nw-code mt-1">{JSON.stringify(event.output, null, 2)}</pre>
            </>
          ) : null}
        </details>
      </div>
    </li>
  );
}

function evidenceProvenance(session: PublicSession, item: EvidenceItem): string | null {
  const trace = [...session.trace].sort((left, right) => left.at.localeCompare(right.at));
  const origin = traceOrigin(trace);
  const outputText = (event: TraceEvent) => {
    try {
      return JSON.stringify(event.output ?? "");
    } catch {
      return "";
    }
  };
  const match =
    [...trace].reverse().find((event) => event.status === "ok" && event.toolName === item.sourceTool && outputText(event).includes(item.evidenceId)) ??
    [...trace].reverse().find((event) => event.status === "ok" && event.toolName === item.sourceTool);
  if (!match) return null;
  return `${toolLabel(match.toolName)} · ${formatStamp(match.at, origin)} · ${match.toolName}`;
}

function traceOrigin(trace: TraceEvent[]): number | null {
  return trace.reduce<number | null>((earliest, event) => {
    const time = Date.parse(event.at);
    if (Number.isNaN(time)) return earliest;
    return earliest === null || time < earliest ? time : earliest;
  }, null);
}

function formatStamp(at: string, origin: number | null): string {
  const time = Date.parse(at);
  if (origin === null || Number.isNaN(time)) return "—";
  return formatOffset(time - origin);
}

function SectionHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <h2 className="flex items-baseline gap-2">
      <span className="nw-section">{title}</span>
      {meta ? <span className="nw-faint text-xs">{meta}</span> : null}
    </h2>
  );
}

function joinCopy(...parts: string[]): string {
  return parts.filter(Boolean).join("");
}

function StatusBadge({ status }: { status: HypothesisStatus }) {
  return (
    <span
      className={cx(
        "nw-badge",
        status === "priority" && "nw-badge-priority",
        status === "excluded" && "nw-badge-excluded",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function DeskButton({
  tone,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone: "primary" | "quiet" | "pop" }) {
  return (
    <button
      {...props}
      type="button"
      className={cx(
        "nw-btn px-3 py-1.5 text-sm",
        tone === "primary" && "nw-btn-primary",
        tone === "pop" && "nw-btn-pop",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={cx("shrink-0 transition-transform", open ? "rotate-90" : "rotate-0")}
    >
      <path d="M4.5 2.5 L8 6 L4.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ResetMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.4-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12.2 2.6v3H9.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p className="nw-alert" role="alert">
      {children}
    </p>
  );
}
