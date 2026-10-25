"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { readInvestigationNdjson } from "@/lib/investigation-events";
import {
  briefInput,
  deskMoment,
  diffSessions,
  EVIDENCE_CLASS_LABEL,
  LOOP_STEPS,
  loopSteps,
  shortTime,
  STATUS_LABEL,
  toolLabel,
  type DeskDiff,
  type DeskFocus,
  type LoopStepView,
} from "./desk-loop";
import { PHASE_LABELS, PHASES, type Hypothesis, type HypothesisStatus, type Phase, type PublicSession } from "@/lib/types";

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

const LOADING_STEPS: LoopStepView[] = LOOP_STEPS.map((step, index) => ({
  id: step.id,
  label: step.label,
  done: false,
  mark: index === 0 ? "current" : "upcoming",
}));

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
  const sessionRef = useRef<PublicSession | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

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
    if (busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
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
          setBanner(event.ok ? null : (event.error ?? "操作失败"));
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
      if (controller.signal.aborted) return;
      setBanner(error instanceof Error ? error.message : "请求失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      busyRef.current = false;
      setPending(false);
    }
  }

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const phase: Phase = session?.phase ?? "idle";
  const moment = session
    ? deskMoment(session, pending)
    : loadError
      ? { focus: "wait" as const, title: "会话没有读出来", detail: "刷新页面后再看。" }
      : { focus: "wait" as const, title: "正在读取事件", detail: "" };
  const steps = session ? loopSteps(session, pending) : LOADING_STEPS;
  const showApprove = moment.focus === "approve";
  const keyNote =
    session &&
    !session.provider.configured &&
    (moment.focus === "run" || moment.focus === "rerun") &&
    !moment.detail.includes("密钥") &&
    !moment.detail.includes("API_KEY");
  const detail = keyNote ? `${moment.detail} 密钥未配置。` : moment.detail;
  const strayBanner = banner && banner !== session?.error ? banner : null;

  return (
    <main className="nw mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--nw-line)] pb-4">
        <div className="min-w-0">
          <p className="nw-kicker">事件调查台</p>
          <h1 className="truncate text-lg font-medium">{session?.incident.title ?? "合成 QKD 运维事件"}</h1>
          {session ? (
            <p className="nw-muted text-sm">
              {session.incident.severity} · {session.incident.nodes.linkId} · {session.incident.nodes.alice} →{" "}
              {session.incident.nodes.bob}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <DeskButton
            tone="quiet"
            disabled={pending || !session || session.hypotheses.length === 0}
            onClick={() => run(() => postJson("/api/session", { action: "conclude" }))}
          >
            结束调查
          </DeskButton>
          <DeskButton
            tone="quiet"
            disabled={pending || !session}
            onClick={() => run(() => postJson("/api/session", { action: "reset" }))}
          >
            <ResetMark />
            重置
          </DeskButton>
        </div>
      </header>

      {session ? <p className="nw-faint text-xs leading-5">{session.incident.disclaimer}</p> : null}
      {strayBanner ? <Alert>{strayBanner}</Alert> : null}
      {loadError ? <Alert>{loadError}</Alert> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <PrimaryZone
          phase={phase}
          steps={steps}
          title={moment.title}
          detail={detail}
          focus={moment.focus}
          pending={pending}
          session={session}
          testId={testId}
          showApprove={showApprove}
          onTestId={setTestId}
          onRun={() => void runInvestigationStream()}
          onApprove={() => run(() => postJson("/api/diagnostic", { decision: "approve", testId }))}
          onReject={() => run(() => postJson("/api/diagnostic", { decision: "reject" }))}
        />
        <HypothesisBoard
          session={session}
          highlight={highlight}
          pending={pending}
          onExclude={(hypothesisId) => run(() => postJson("/api/steer", { action: "exclude", hypothesisId }))}
          onPrioritize={(hypothesisId) => run(() => postJson("/api/steer", { action: "prioritize", hypothesisId }))}
          onRequest={(evidenceClass) =>
            run(() => postJson("/api/steer", { action: "request_evidence", evidenceClass }))
          }
        />
        <TraceTimeline session={session} highlight={highlight} pending={pending} />
        <EvidenceBoard session={session} highlight={highlight} />
        {session ? <IncidentDetails session={session} /> : null}
        <PhaseDetails phase={phase} trail={session?.phaseTrail ?? ["idle"]} />
      </div>
    </main>
  );
}

function PrimaryZone({
  phase,
  steps,
  title,
  detail,
  focus,
  pending,
  session,
  testId,
  showApprove,
  onTestId,
  onRun,
  onApprove,
  onReject,
}: {
  phase: Phase;
  steps: LoopStepView[];
  title: string;
  detail: string;
  focus: DeskFocus;
  pending: boolean;
  session: PublicSession | null;
  testId: string;
  showApprove: boolean;
  onTestId: (id: string) => void;
  onRun: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const runLabel = pending ? "调查进行中" : focus === "rerun" ? "再运行调查" : "运行调查";
  const showRun = Boolean(session) && (focus === "run" || focus === "rerun" || (focus === "wait" && pending));
  return (
    <section
      className="nw-panel p-4 sm:p-5"
      aria-live="polite"
      aria-busy={pending}
      data-desk-focus={focus}
      data-phase={phase}
    >
      <LoopTrack steps={steps} />
      <p className="nw-faint mt-4 text-sm">{PHASE_LABELS[phase]}</p>
      <h2 className="mt-1 text-2xl font-medium tracking-tight">{title}</h2>
      {detail ? <p className="nw-muted mt-2 max-w-xl text-sm leading-6">{detail}</p> : null}
      {showApprove && session ? (
        <ApproveDock session={session} pending={pending} testId={testId} onTestId={onTestId} onApprove={onApprove} onReject={onReject} />
      ) : null}
      {showRun ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <DeskButton tone="primary" className="px-4 py-3 text-base" disabled={pending || !session} onClick={onRun}>
            {runLabel}
          </DeskButton>
          {focus === "rerun" ? (
            <DeskButton tone="quiet" disabled={pending} onClick={onReject}>
              拒绝
            </DeskButton>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ApproveDock({
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
    <div className="mt-4 border border-[var(--nw-pop)] bg-[var(--nw-panel-2)] p-3" aria-label="诊断批准">
      {proposal ? (
        <p className="text-sm">
          <span className="font-medium">{proposalTitle}</span>
          <span className="nw-muted mt-1 block">{proposal.reason}</span>
        </p>
      ) : (
        <p className="nw-muted text-sm">还没有提案。</p>
      )}
      <label className="mt-3 flex flex-col gap-1 text-sm" htmlFor="diagnostic-select">
        测试
        <select
          id="diagnostic-select"
          className="px-2 py-2"
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
      {selected ? <p className="nw-muted mt-2 text-sm">{selected.measures}</p> : null}
      {proposal && selected && proposal.testId !== selected.testId ? (
        <p className="nw-faint mt-2 text-sm">当前选择是「{selected.title}」，提案是「{proposalTitle}」。</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <DeskButton tone="primary" className="px-4 py-3 text-base" disabled={pending || !testId} onClick={onApprove}>
          批准
        </DeskButton>
        <DeskButton tone="quiet" disabled={pending || (!proposal && !session.approval)} onClick={onReject}>
          拒绝
        </DeskButton>
      </div>
    </div>
  );
}

function HypothesisBoard({
  session,
  highlight,
  pending,
  onExclude,
  onPrioritize,
  onRequest,
}: {
  session: PublicSession | null;
  highlight: DeskDiff | null;
  pending: boolean;
  onExclude: (hypothesisId: string) => void;
  onPrioritize: (hypothesisId: string) => void;
  onRequest: (evidenceClass: "telemetry" | "logs" | "maintenance") => void;
}) {
  if (!session || session.hypotheses.length === 0) return null;
  const hypotheses = session.hypotheses;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="nw-muted text-sm font-medium">假设</h2>
      <RequestRow session={session} pending={pending} onRequest={onRequest} />
      <ul className="flex flex-col gap-3">
        {hypotheses.map((item) => (
          <HypothesisCard
            key={item.id}
            item={item}
            session={session}
            highlight={highlight}
            pending={pending}
            onExclude={() => onExclude(item.id)}
            onPrioritize={() => onPrioritize(item.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function HypothesisCard({
  item,
  session,
  highlight,
  pending,
  onExclude,
  onPrioritize,
}: {
  item: Hypothesis;
  session: PublicSession;
  highlight: DeskDiff | null;
  pending: boolean;
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
        "nw-panel p-3",
        marked && "desk-new border-[var(--nw-pop)]",
        !marked && item.status === "priority" && "border-[var(--nw-pop)]",
        item.status === "excluded" && "opacity-55",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className={cx("text-base font-medium", item.status === "excluded" && "line-through")}>{item.title}</h3>
        <StatusBadge status={item.status} />
      </div>
      {change ? (
        <p className="nw-pop-text mt-2 text-sm">
          {STATUS_LABEL[change.from]} → {STATUS_LABEL[change.to]}
        </p>
      ) : null}
      {isNew ? <p className="nw-pop-text mt-2 text-sm">新假设</p> : null}
      {!isNew && !change && textChanged ? <p className="nw-pop-text mt-2 text-sm">依据已更新</p> : null}
      <p className="mt-2 text-sm leading-6">{item.rationale}</p>
      {evidenceNames.length > 0 ? <p className="nw-muted mt-2 text-sm">依据 {evidenceNames.join("、")}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <DeskButton tone="quiet" disabled={pending || item.status === "excluded"} onClick={onExclude}>
          排除
        </DeskButton>
        <DeskButton tone="quiet" disabled={pending || item.status === "priority"} onClick={onPrioritize}>
          优先调查
        </DeskButton>
      </div>
    </li>
  );
}

function RequestRow({
  session,
  pending,
  onRequest,
}: {
  session: PublicSession;
  pending: boolean;
  onRequest: (evidenceClass: "telemetry" | "logs" | "maintenance") => void;
}) {
  const latest = [...session.steering].reverse().find((record) => record.action === "request_evidence");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {EVIDENCE_REQUESTS.map(([evidenceClass, label]) => (
          <DeskButton key={evidenceClass} tone="quiet" disabled={pending} onClick={() => onRequest(evidenceClass)}>
            请求{label}
          </DeskButton>
        ))}
      </div>
      {latest?.evidenceClass ? (
        <p className="nw-muted text-sm">下一次查证会先看{EVIDENCE_CLASS_LABEL[latest.evidenceClass]}。</p>
      ) : null}
    </div>
  );
}

function EvidenceBoard({ session, highlight }: { session: PublicSession | null; highlight: DeskDiff | null }) {
  if (!session || session.evidence.length === 0) return null;
  const evidence = session.evidence;
  const fresh = new Set([...(highlight?.evidenceIds ?? []), ...(highlight?.updatedEvidenceIds ?? [])]);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="nw-muted text-sm font-medium">证据</h2>
      <ul className="flex flex-col gap-3">
          {evidence.map((item) => {
            const isFresh = fresh.has(item.evidenceId);
            const diagnostic = item.evidenceClass === "diagnostic";
            const long = item.body.length > 280 && !diagnostic && !isFresh;
            return (
              <li
                key={item.evidenceId}
                className={cx("nw-panel p-3", isFresh && "desk-new border-[var(--nw-pop)]")}
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-medium">{item.title}</h3>
                  <span className="nw-faint shrink-0 text-xs">
                    {EVIDENCE_CLASS_LABEL[item.evidenceClass]}
                    {isFresh ? (diagnostic ? " · 新证" : " · 新") : ""}
                  </span>
                </div>
                {long ? (
                  <details className="mt-2">
                    <summary className="text-sm">{item.body.split("\n")[0]}</summary>
                    <pre className="mt-2 text-sm">{item.body}</pre>
                  </details>
                ) : (
                  <pre className="mt-2 text-sm">{item.body}</pre>
                )}
              </li>
            );
          })}
        </ul>
    </section>
  );
}

function TraceTimeline({
  session,
  highlight,
  pending,
}: {
  session: PublicSession | null;
  highlight: DeskDiff | null;
  pending: boolean;
}) {
  const trace = session?.trace ?? [];
  const fresh = new Set(highlight?.traceIds ?? []);
  return (
    <aside className="nw-panel p-4 lg:sticky lg:top-4 lg:col-start-2 lg:row-span-5 lg:row-start-1 lg:self-start">
      <h2 className="nw-muted text-sm font-medium">工具轨迹</h2>
      {trace.length === 0 ? (
        <p className="nw-faint mt-3 text-sm">{pending ? "这一轮还没有工具返回。" : "还没有工具调用。"}</p>
      ) : (
        <ol className="mt-4" aria-label="工具轨迹">
          {trace.map((event, index) => {
            const summary = briefInput(event.input);
            const isNew = fresh.has(event.id);
            const failed = event.status === "error";
            return (
              <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                {index < trace.length - 1 ? (
                  <span aria-hidden="true" className="nw-rule-wait absolute top-3 bottom-0 left-[5px] w-px" />
                ) : null}
                <span
                  aria-hidden="true"
                  className={cx(
                    "relative z-10 mt-1 h-2.5 w-2.5 shrink-0 rounded-full border",
                    failed && "border-[var(--nw-pop)] bg-[var(--nw-pop)]",
                    !failed && isNew && "border-[var(--nw-pop)] bg-transparent",
                    !failed && !isNew && "border-[var(--nw-line-strong)] bg-transparent",
                  )}
                />
                <div className={cx("min-w-0", isNew && "desk-new px-2 py-1")}>
                  <p className="text-sm font-medium">
                    {toolLabel(event.toolName)}
                    {isNew ? " · 新" : ""}
                  </p>
                  <p className={cx("text-xs", failed ? "nw-pop-text" : "nw-faint")}>
                    {failed ? "失败" : "成功"} · {shortTime(event.at)}
                  </p>
                  {summary ? <p className="nw-muted mt-1 text-sm">{summary}</p> : null}
                  {failed ? <p className="nw-pop-text mt-1 text-sm">{event.error}</p> : null}
                  <details className="mt-1">
                    <summary className="nw-faint text-xs">原始输入输出</summary>
                    <p className="nw-faint mt-2 font-mono text-xs">{event.toolName}</p>
                    <pre className="mt-1 text-xs">{JSON.stringify(event.input, null, 2)}</pre>
                    {event.status === "ok" ? <pre className="mt-2 text-xs">{JSON.stringify(event.output, null, 2)}</pre> : null}
                  </details>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

function LoopTrack({ steps }: { steps: LoopStepView[] }) {
  return (
    <ol className="flex" aria-label="调查循环" data-desk="loop">
      {steps.map((step, index) => {
        const previousDone = index > 0 && steps[index - 1]?.done === true;
        const nextFilled = step.done && index < steps.length - 1;
        return (
          <li key={step.id} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <div className="flex w-full items-center">
              <span aria-hidden="true" className={cx("h-px flex-1", index === 0 ? "bg-transparent" : previousDone ? "nw-rule-done" : "nw-rule-wait")} />
              <span
                className={cx(
                  "nw-step",
                  step.mark === "current" && "nw-step-current",
                  step.mark === "done" && "nw-step-done",
                  step.mark === "upcoming" && "nw-step-upcoming",
                )}
                aria-current={step.mark === "current" ? "step" : undefined}
              >
                {step.done ? "✓" : index + 1}
              </span>
              <span
                aria-hidden="true"
                className={cx("h-px flex-1", index === steps.length - 1 ? "bg-transparent" : nextFilled ? "nw-rule-done" : "nw-rule-wait")}
              />
            </div>
            <span className={cx("text-center text-xs", step.mark === "current" ? "font-medium text-[var(--nw-text)]" : "nw-faint")}>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function PhaseDetails({ phase, trail }: { phase: Phase; trail: Phase[] }) {
  return (
    <details className="nw-panel px-3 py-2">
      <summary className="nw-muted text-sm">状态机 · {PHASE_LABELS[phase]}</summary>
      <ol className="mt-3 flex flex-col" data-phase={phase}>
        {PHASES.map((item) => {
          const active = item === phase;
          return (
            <li key={item} className="flex items-center gap-2 py-1 text-sm" aria-current={active ? "step" : undefined}>
              <span
                aria-hidden="true"
                className={cx(
                  "h-2 w-2 shrink-0 rounded-full",
                  active ? "bg-[var(--nw-pop)]" : "border border-[var(--nw-line-strong)]",
                )}
              />
              <span className={active ? "font-medium" : "nw-faint"}>{PHASE_LABELS[item]}</span>
              <span className="nw-faint font-mono text-xs">{item}</span>
            </li>
          );
        })}
      </ol>
      <p className="nw-faint mt-2 text-xs">经过：{trail.map((item) => PHASE_LABELS[item]).join(" → ")}</p>
    </details>
  );
}

function IncidentDetails({ session }: { session: PublicSession }) {
  const incident = session.incident;
  return (
    <details className="nw-panel px-3 py-2">
      <summary className="nw-muted text-sm">事件</summary>
      <div className="mt-2 flex flex-col gap-1 text-sm">
        <p>{incident.symptoms.join("；")}</p>
        <p>
          {incident.id} · 打开于 {shortTime(incident.openedAt)}
        </p>
        <p>
          时间窗 {shortTime(incident.timeWindow.from)} – {shortTime(incident.timeWindow.to)}
        </p>
        <p>{incident.maintenanceWindowSummary}</p>
      </div>
    </details>
  );
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone: "primary" | "quiet" }) {
  return (
    <button
      {...props}
      type="button"
      className={cx("nw-btn px-3 py-2 text-sm", tone === "primary" && "nw-btn-primary", className)}
    >
      {children}
    </button>
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
