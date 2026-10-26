# 合成 QKD 运维事件调查（M0）

一场合成链路事件：QBER 上升、筛选后密钥率下降，旁边有一条维护记录。单个 Agent 用环境工具取证，再用结构化输出维护假设。人可以排除假设、把一条假设标成优先，或要求某一类证据；诊断测试必须先在界面上批准。

这不是真实设备，不是现网链路，不是商业密钥率，也不实现 BB84 或其他 QKD 协议。

## 本地启动

包管理器是 pnpm。

```bash
pnpm install
pnpm dev
```

要真跑模型，在项目根目录新建 `.env.local`，按下面「环境变量」一节填入变量。不填也能打开页面和教程。

开发服务器固定在端口 **3457**。打开 Next 打印的地址，一般是 [http://127.0.0.1:3457](http://127.0.0.1:3457)。

手机走局域网 IP 时，`next.config.ts` 的 `allowedDevOrigins` 已放行 `192.168.*.*`、`10.*.*.*`、`172.16.*.*`–`172.31.*.*` 和 `*.local`。改这份名单后要重启 `pnpm dev`。不是这些形式的主机名，需要按当时的主机名再加一条。

没有密钥时页面仍能打开，事件头来自公开 fixture。点击「运行调查」仍是一次请求：响应是 NDJSON，先把阶段推到「装载」，再以明确错误结束。不会伪造工具轨迹或假设。

## 教程

页眉「教程」走合成回放，不调用模型。回放到批准这一拍会停住，等你自己点「批准」。批准把诊断结果写成新证据，不是自动修复。

第一轮诊断落到「等待转向」之后，可以排除、先查一条，或在底栏请求遥测、日志、维护。请求证据会补上新的回放和工具轨迹。先查一条或请求证据会再提出一项诊断，仍要你批准。说明可以留在画面上，不挡住第二轮。交接稿或重置才结束，第一轮之后不会自己停死。

## 页眉

「教程」「交接稿」「重置」。交接稿下载 Markdown，旁边的 JSON 下载同一份公开会话。「重置」清空这次调查。真实调查走底栏「运行调查」，请求 `/api/agent`。

调查台上不再重复「这是合成数据 / 不是真机」。这句话留在本页开头，也留在交接稿引用的 fixture 声明里。

## 交接稿

已经有假设或证据时可以导出。Markdown 文件名形如 `investigation-report-qber-rise-keyrate-drop.md`。导出不开始调查，也不触发修复。

报告里有事件摘要、时间窗、证据要点、假设（优先 / 调查中 / 已排除）和理由、转向、诊断提案与批准、工具轨迹摘要、阶段说明，以及合成数据声明。这是本地交接稿，不是外部工单。

本地看：`pnpm dev`，打开 [http://127.0.0.1:3457](http://127.0.0.1:3457)。跑完一轮调查（或至少写出假设）后点「交接稿」。空会话上这组按钮是灰的。

有密钥时，同一次「运行调查」会在模型还在跑的时候推送阶段和工具轨迹。停在「批准诊断」时，批准只在服务器记下这项测试；点「再运行调查」才执行。排除、先查一条、请求一类证据会记入转向，并自动开始下一轮 `/api/agent`。暂停时不会自动开下一轮。未批准的诊断不会执行。

本地核对 SiliconFlow：把 `.env.local` 配成 `AI_PROVIDER=openai-compatible`、`AI_BASE_URL`（例如 `https://api.siliconflow.cn/v1`）、`AI_API_KEY` 和 `AI_MODEL`，运行 `pnpm dev`，打开端口 3457。点一次「运行调查」。阶段文字应从「空闲」变为「装载」「调查」，工具轨迹随每次工具返回增加，最后出现假设和「批准诊断」。不要把这一轮拆成多次点击。批准之后要再跑一轮才会执行诊断；转向会自己接上下一轮。

## 环境变量

写在项目根目录的 `.env.local`（不进 git）。

- `AI_PROVIDER=openai`：使用 `@ai-sdk/openai`。`AI_OPENAI_API=responses` 走 Responses API；`chat` 走 Chat Completions（兼容端点只有 `/chat/completions` 时用这个）。
- `AI_PROVIDER=openai-compatible`：使用 `@ai-sdk/openai-compatible`，必须设置 `AI_BASE_URL`。
- 密钥读 `AI_API_KEY`，没有则读 `OPENAI_API_KEY`。
- `AI_MODEL` 换成任何支持工具调用和结构化输出的模型名。

## 检查

```bash
pnpm test
pnpm typecheck
```

`pnpm test` 会失败，如果隐藏根因字符串或 `rootCause` / `oracle` / `leakSentinel` 等字段进入工具返回值，或进入样例模型消息。`hidden.json` 只允许诊断解析器在服务器上读取。

## 目录

```text
app/api/agent/route.ts          单次调查：NDJSON 推送阶段和工具轨迹，结束时给假设
app/api/session/route.ts        读取 / 重置 / 结束
app/api/steer/route.ts          排除、优先、请求一类证据
app/api/diagnostic/route.ts     批准或拒绝诊断（服务器标记）
components/investigation-desk.tsx
components/investigation-report.ts  从当前公开会话生成 Markdown 交接稿
lib/agent.ts                    唯一的 ToolLoopAgent
lib/tools.ts                    五个 AI SDK tool()
lib/hypotheses.ts               Zod 结构化输出（不是工具）
lib/model-context.ts            模型可见消息，只挑公开字段
lib/diagnostic-resolver.ts      批准后才读 hidden.json
fixtures/incidents/qber-rise-keyrate-drop/
  public.json                   模型可见的事件卡
  hidden.json                   根因与 oracle，不对模型、不对浏览器
  telemetry.json logs.json maintenance.json diagnostics.json
scripts/redline-smoke.ts
```

默认事件 id：`qber-rise-keyrate-drop`。

界面上的状态机是：`idle | ingesting | investigating | awaiting_steer | proposing_test | awaiting_test_approval | testing | updating | concluded | error`。

## M0 之外

视觉打磨、多 Agent、协议仿真、部署到 Vercel 生产环境、TraceWeave 内容。契约以 `DEMO_SPEC.md` 和 `AGENTS.md` 为准。
