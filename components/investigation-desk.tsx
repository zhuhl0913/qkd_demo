"use client";

import { useEffect, useState } from "react";
import { PHASE_LABELS, PHASES, type Phase, type PublicSession } from "@/lib/types";

type ApiBody = {
  ok?: boolean;
  error?: string;
  session?: PublicSession;
};

const STATUS_LABEL = {
  active: "调查中",
  excluded: "已排除",
  priority: "优先",
} as const;

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

export function InvestigationDesk() {
  const [session, setSession] = useState<PublicSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [hypothesisId, setHypothesisId] = useState("");
  const [testId, setTestId] = useState("");

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
        setSession(next);
        setHypothesisId(next.hypotheses[0]?.id ?? "");
        setTestId(next.proposal?.testId ?? next.diagnosticCatalog[0]?.testId ?? "");
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "无法读取会话");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function apply(data: ApiBody) {
    if (data.session) {
      setSession(data.session);
      setHypothesisId((current) =>
        data.session?.hypotheses.some((item) => item.id === current)
          ? current
          : (data.session?.hypotheses[0]?.id ?? ""),
      );
      setTestId((current) => {
        if (data.session?.proposal?.testId) return data.session.proposal.testId;
        if (data.session?.diagnosticCatalog.some((item) => item.testId === current)) return current;
        return data.session?.diagnosticCatalog[0]?.testId ?? "";
      });
    }
    setBanner(data.ok === false ? (data.error ?? "操作失败") : null);
  }

  async function run(task: () => Promise<ApiBody>) {
    setPending(true);
    setBanner(null);
    try {
      apply(await task());
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "请求失败");
    } finally {
      setPending(false);
    }
  }

  const phase: Phase = session?.phase ?? "idle";
  const hypotheses = session?.hypotheses ?? [];

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-4 sm:px-5">
      <header className="flex flex-col gap-3 border-b border-stone-300 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">合成 QKD 运维事件</p>
            <h1 className="text-2xl font-semibold">事件调查台</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="border border-stone-900 bg-stone-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              disabled={pending}
              onClick={() => run(() => postJson("/api/agent"))}
            >
              {pending ? "调查进行中…" : "运行调查"}
            </button>
            <button
              type="button"
              className="border border-stone-400 bg-white px-3 py-2 text-sm disabled:opacity-50"
              disabled={pending}
              onClick={() => run(() => postJson("/api/session", { action: "conclude" }))}
            >
              结束调查
            </button>
            <button
              type="button"
              className="border border-stone-400 bg-white px-3 py-2 text-sm disabled:opacity-50"
              disabled={pending}
              onClick={() => run(() => postJson("/api/session", { action: "reset" }))}
            >
              重置会话
            </button>
          </div>
        </div>
        <StateBadge phase={phase} trail={session?.phaseTrail ?? ["idle"]} />
        {session?.provider ? (
          <p className="text-sm text-stone-600">
            模型 {session.provider.provider} / {session.provider.modelId}
            {session.provider.provider === "openai" ? ` / ${session.provider.openaiApi}` : ""}
            {session.provider.baseURL ? ` @ ${session.provider.baseURL}` : ""}
            。密钥{session.provider.configured ? "已配置" : "未配置"}。未配置或调用失败时只显示错误，不伪造工具轨迹。
          </p>
        ) : null}
        {banner ? (
          <p className="border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
            {banner}
          </p>
        ) : null}
        {session?.error && session.error !== banner ? (
          <p className="border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
            {session.error}
          </p>
        ) : null}
      </header>

      {loadError ? (
        <p className="border border-red-700 bg-red-50 px-3 py-2 text-sm" role="alert">
          {loadError}
        </p>
      ) : null}
      {!session && !loadError ? <p className="text-sm text-stone-600">正在读取事件…</p> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 border border-stone-300 bg-white p-3">
          <h2 className="text-lg font-semibold">事件</h2>
          {session ? <IncidentHeader session={session} /> : <p className="text-sm text-stone-500">事件头会在会话加载后出现。</p>}
          <h2 className="text-lg font-semibold">证据</h2>
          {session && session.evidence.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {session.evidence.map((item) => (
                <li key={item.evidenceId} className="border border-stone-200 p-2">
                  <p className="text-xs text-stone-500">
                    {item.evidenceClass} · {item.sourceTool} · {item.evidenceId}
                  </p>
                  <p className="font-medium">{item.title}</p>
                  <pre className="mt-1 text-sm text-stone-800">{item.body}</pre>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-500">尚无工具证据。证据只来自模型运行时真正执行的环境工具。</p>
          )}
        </section>

        <section className="flex flex-col gap-3 border border-stone-300 bg-white p-3">
          <h2 className="text-lg font-semibold">假设</h2>
          {hypotheses.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {hypotheses.map((item) => (
                <li key={item.id} className="border border-stone-200 p-2">
                  <p className="text-xs text-stone-500">
                    {item.id} · {STATUS_LABEL[item.status]} ({item.status})
                  </p>
                  <p className="font-medium">{item.title}</p>
                  <p className="text-sm">{item.rationale}</p>
                  <p className="text-xs text-stone-500">
                    证据 {item.supportingEvidenceIds.length > 0 ? item.supportingEvidenceIds.join(", ") : "无"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-500">
              尚无假设。运行调查后，由模型的 structured output 写入。这里不会放本地假假设。
            </p>
          )}

          <h2 className="text-lg font-semibold">转向</h2>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm">
              假设
              <select
                className="border border-stone-400 bg-white px-2 py-1"
                value={hypothesisId}
                disabled={hypotheses.length === 0 || pending}
                onChange={(event) => setHypothesisId(event.target.value)}
              >
                {hypotheses.length === 0 ? <option value="">还没有假设</option> : null}
                {hypotheses.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} · {item.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="border border-stone-700 bg-white px-3 py-2 text-sm disabled:opacity-50"
                disabled={pending || hypotheses.length === 0}
                onClick={() =>
                  run(() => postJson("/api/steer", { action: "exclude", hypothesisId }))
                }
              >
                排除
              </button>
              <button
                type="button"
                className="border border-stone-700 bg-white px-3 py-2 text-sm disabled:opacity-50"
                disabled={pending || hypotheses.length === 0}
                onClick={() =>
                  run(() => postJson("/api/steer", { action: "prioritize", hypothesisId }))
                }
              >
                优先调查
              </button>
            </div>
            <p className="text-sm">请求一类证据</p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["telemetry", "遥测"],
                  ["logs", "日志"],
                  ["maintenance", "维护"],
                ] as const
              ).map(([evidenceClass, label]) => (
                <button
                  key={evidenceClass}
                  type="button"
                  className="border border-stone-700 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  disabled={pending}
                  onClick={() =>
                    run(() => postJson("/api/steer", { action: "request_evidence", evidenceClass }))
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {session && session.steering.length > 0 ? (
              <ul className="text-xs text-stone-600">
                {session.steering.map((record) => (
                  <li key={record.id}>
                    {record.at} {record.action}
                    {record.hypothesisId ? ` ${record.hypothesisId}` : ""}
                    {record.evidenceClass ? ` ${record.evidenceClass}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-500">还没有转向记录。排除和优先调查会在假设出现后可用。</p>
            )}
          </div>

          <h2 className="text-lg font-semibold">诊断批准</h2>
          <div className="flex flex-col gap-2 border border-dashed border-stone-400 p-2">
            {session?.proposal ? (
              <p className="text-sm">
                模型提案（structured output，不是工具）：{session.proposal.testId}。{session.proposal.reason}
              </p>
            ) : (
              <p className="text-sm text-stone-500">代理还没有提出诊断测试。</p>
            )}
            <label className="flex flex-col gap-1 text-sm">
              批准哪一项
              <select
                className="border border-stone-400 bg-white px-2 py-1"
                value={testId}
                disabled={!session || session.diagnosticCatalog.length === 0 || pending}
                onChange={(event) => setTestId(event.target.value)}
              >
                {(session?.diagnosticCatalog ?? []).map((item) => (
                  <option key={item.testId} value={item.testId}>
                    {item.testId} · {item.title}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-stone-500">
              下拉目录来自 fixture，不是工具调用。批准只设置服务器标记；run_diagnostic_test 要等下一次调查运行才会执行。
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="border border-stone-900 bg-stone-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                disabled={pending || !testId}
                onClick={() => run(() => postJson("/api/diagnostic", { decision: "approve", testId }))}
              >
                批准
              </button>
              <button
                type="button"
                className="border border-stone-700 bg-white px-3 py-2 text-sm disabled:opacity-50"
                disabled={pending}
                onClick={() => run(() => postJson("/api/diagnostic", { decision: "reject" }))}
              >
                拒绝
              </button>
            </div>
            {session?.approval ? (
              <p className="text-sm">
                服务器批准标记已打开：{session.approval.testId}（{session.approval.approvedAt}）。
              </p>
            ) : (
              <p className="text-sm text-stone-500">批准标记关闭。此时调用 run_diagnostic_test 会被服务器拒绝。</p>
            )}
          </div>
        </section>
      </div>

      <section className="border border-stone-300 bg-white p-3">
        <h2 className="text-lg font-semibold">工具轨迹</h2>
        {session && session.trace.length > 0 ? (
          <ol className="mt-2 flex flex-col gap-2">
            {session.trace.map((event, index) => (
              <li key={event.id} className="border border-stone-200 p-2">
                <p className="text-sm font-medium">
                  {index + 1}. {event.toolName} · {event.status === "ok" ? "成功" : "失败"} · {event.at}
                </p>
                <p className="mt-1 text-xs text-stone-500">输入</p>
                <pre className="text-xs">{JSON.stringify(event.input, null, 2)}</pre>
                {event.status === "ok" ? (
                  <>
                    <p className="mt-1 text-xs text-stone-500">输出</p>
                    <pre className="text-xs">{JSON.stringify(event.output, null, 2)}</pre>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-red-800">{event.error}</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-stone-500">
            尚无工具调用。轨迹只记录模型运行时真实返回的 tool call。
          </p>
        )}
      </section>
    </main>
  );
}

function StateBadge({ phase, trail }: { phase: Phase; trail: Phase[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">状态机</p>
      <ol className="flex flex-wrap gap-1">
        {PHASES.map((item) => {
          const active = item === phase;
          return (
            <li
              key={item}
              className={
                active
                  ? "border border-stone-900 bg-stone-900 px-2 py-1 text-xs text-white"
                  : "border border-stone-300 bg-white px-2 py-1 text-xs text-stone-600"
              }
              aria-current={active ? "step" : undefined}
            >
              <span className="font-mono">{item}</span>
              <span> {PHASE_LABELS[item]}</span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-stone-500">本轮经过：{trail.join(" → ")}</p>
    </div>
  );
}

function IncidentHeader({ session }: { session: PublicSession }) {
  const incident = session.incident;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="border border-amber-700 bg-amber-50 px-2 py-1">{incident.disclaimer}</p>
      <p className="text-base font-medium">{incident.title}</p>
      <p>
        {incident.id} · {incident.severity} · 打开于 {incident.openedAt}
      </p>
      <p>
        Alice {incident.nodes.alice} · Bob {incident.nodes.bob} · 链路 {incident.nodes.linkId}
      </p>
      <p>
        时间窗 {incident.timeWindow.from} – {incident.timeWindow.to}
      </p>
      <ul className="list-disc pl-5">
        {incident.symptoms.map((symptom) => (
          <li key={symptom}>{symptom}</li>
        ))}
      </ul>
      <p>维护摘要：{incident.maintenanceWindowSummary}</p>
    </div>
  );
}
