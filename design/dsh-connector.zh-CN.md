# DSH 桌面版 Connector

DSH（DeepSeek Harness）Connector 附着正在运行的 DSH 桌面版，经桌面 Host 自己的 Typert Remote 端点管理全部会话，包括用户在桌面里手动打开的会话。Session 是工作上下文，turn 是一次原生执行。共同契约见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)。

## 附着方式

DSH 桌面版的 Host 运行在 Electron 进程里，认证由桌面载体负责，不对外开放 HTTP；桌面 UI 通过进程内载体调用 Host 的 Typert 端点（`session/list`、`session/page`、`session/follow`、`session/prompt` 等）。`dsh web` 载体对外提供 `/connect?token=` 加 `/api/remote.mux`，但它是另一个 Host 进程，不是桌面版。

因此由运行在桌面 Host 内的插件（[dsh-grokbot-dispatch](https://github.com/semantic-craft/dsh-grokbot-dispatch) 的 `native-bridge.js`）在同用户 Unix socket 上转发原生端点：

| 路径 | 调用 |
| --- | --- |
| `POST /bridge/workspace/attachSession`，body `{args: {path, sessionId, title?}}` | `agent-fleet-dsh` 插件调用桌面 Host 的 workspace registry；非原生 Typert 端点 |
| `GET /health` | 插件状态与 DSH 版本 |
| `POST /api/<namespace>/<method>`，body `{args}` | `ctx.typertGateway.invoke()`，返回 `{ok, value}` 或 `{ok: false, error}`（原生 RemoteError） |
| `POST /stream/<namespace>/<method>`，body `{args}` | `ctx.typertGateway.stream()`，NDJSON 逐项返回 `{item}`，以 `{end}` 或 `{error}` 结束 |

插件为这条通路创建一个独立 Peer：owner principal，`interactions: "none"`，不接收也不回答 Host 转发的 waterfall（审批、提问等）。端点名、命名参数、结果和错误不做改写；Gateway 照常执行参数校验。访问控制就是 socket 本身：目录 0700、socket 0600，只有运行桌面版的 macOS 用户能连接，与 Codex app-server 的 Unix socket 附着方式相同。Connector 不启动或停止 DSH；退出、重启 Connector 不影响桌面版和正在执行的 turn。

### 未选的方案

- `dsh --profile acp`（ACP v1 stdio）：是独立 Host 进程。没有验证它建的会话是否出现在桌面左栏；即使出现，turn 也在 ACP 进程里执行并持有会话写锁（原生 `session/writer-held`），桌面版无法跟随或接手运行中的会话，也看不到用户在桌面里开的会话正在做什么。原生桥接已能直接满足需求，所以没有继续验证这条路。
- `dsh web` 的 `/connect` + mux：同样是独立 Host 进程；而且要实现 mux 帧协议。
- 原 `agenvo-dispatch`：只有 `health`、`jobs.create`、`jobs.get`，只能新建会话，不能列出用户会话、追加输入、读取历史或中断，且另有一套 job 状态。

## 方法与语义

除下述 `workspace/attachSession` 桥接方法外，方法名、参数和结果沿用原生端点，schema 由 `scripts/import-dsh-schema.mjs` 从 DSH 安装包内生成的 Typert 描述（`lib/typert.host.js`，每个线上参数带 JSON Schema）导入 `apps/dsh/src/schema.json`。调用参数就是原生 `args`，例如 `session/prompt` 的 `{request: {requestId, sessionId, mode, content}}`。

| 方法 | 共同术语 | 说明 |
| --- | --- | --- |
| `session/list` | list work contexts | 全部可见会话，含用户手动打开的；只读存储头，不唤醒 agent；`running`、`agentAvailable` 和投影随行。桥接分页，见下 |
| `session/search` | list / search | 按文本搜会话内容 |
| `session/projections` | native status | 标题、`permissions.currentValue`、`inbox`（排队输入）、`userQuestions`、`todos` 等 |
| `session/follow` | read output | 桥接：打开原生 follow，取开场 snapshot（header、`cursor`、尾部记录、投影）后关闭；实时变化走 runtime.changed |
| `session/page` | read output | 原生历史分页，`throughSeq` 不得超过 follow 给出的 `cursor` |
| `workspace/create`、`session/create`、`session/fork` | create work context | create 不提交输入；传 `workspaceId` 时会话出现在侧栏对应项目下 |
| `workspace/attachSession` | create work context grouping | 桥接：把已有会话登记到桌面侧栏项目，项目缺失时新建，不创建会话或提交输入 |
| `session/prompt` | submit input | `requestId` 幂等；`queue` 开始或排队一轮，`steer` 注入运行中的一轮 |
| `session/cancel` | interrupt | 只请求取消当前 turn，排队输入保留 |
| `session/updateQueue`、`session/rename`、`session/modelCatalog`、`session/selectModel` | — | 原生队列编辑、改名与模型选择 |
| `userQuestions/answer` | respond | 回答 agent 向用户提的问题 |
| `commands/list`、`commands/execute` | — | 原生斜杠命令，例如 `/compact` |

原生 `session/list` 一次返回全部行，`cursor` 参数保留未用；每行带完整投影（token 用量、上下文占用等）。一台机器上 84 个会话即达 75 KB，超过 64 KiB 帧上限。因此 Connector 在原生参数 `_request` 之外接受桥接参数 `limit`（默认 20）、`offset`（默认 0）和 `projections`（保留的投影键，默认 title、permissions、inbox、userQuestions、todos、goal、sessionListMetadata），返回 `{items, total, nextOffset}`。行仍是原生行，只裁掉未选的投影键；按活动排序，翻页之间可能移动。单个会话的全部投影用 `session/projections` 读。

`session/follow` 和 `session/page` 的每条 `assistant/message` 记录同时携带回答文本 `message.content[]` 和过程本地呈现分片 `data.stream[]`（含推理块）。长回答即使 `maxMessages: 1` 也可能因此超过 64 KiB。Connector 在 `bounded()` 之前把记录里的 `data.stream` 去掉，回答文本保留在 `message.content`；需要分片时，传原生选项 `request.assistantStream: true`（follow 原样转发），或传 Connector 桥接顶层参数 `assistantStream: true`（follow 与 page 都接受，转发给原生端点前去掉这个顶层键，因为原生顶层 `additionalProperties: false`）。

`accepted` 只说明原生端点或桥接方法接受了调用。`session/prompt` 返回 `{accepted: true}` 表示输入已进入会话，不表示推理开始、完成或业务目标达成；以 `turn/end` 事件和历史为准。

### 已有会话登记到桌面项目

调用者可把 `dsh --profile headless` 等 CLI 创建的已有会话登记到桌面左栏项目下。`workspace/attachSession` 是 Connector bridge，不是原生 DSH 端点；原生 Typert 没有等价能力。它在 `methods.ts` 中独立声明 schema 和 `readOnly: false`，不写入 `schema.json` 的 native operations，也不改变原生导入器。

调用参数为 `{path, sessionId, title?}`：`path` 是 DSH 桌面宿主的绝对路径，必须与会话 cwd 解析为同一路径；`sessionId` 必填，`title` 可选。Connector 向 `agent-fleet-dsh` 插件发送 `POST /bridge/workspace/attachSession`，body 为 `{args: 参数}`。插件通过桌面 Host 的 workspace registry 登记；项目不存在就新建，同名时按「basename · 短父路径」区分。登记幂等，CLI 进程运行中也可调用，不唤醒会话或提交输入。

HTTP 200 的 `{ok: true, value}` 解包为 `{workspace: {workspaceId, path, title, sessionIds}, created}`。`created` 描述项目是否新建，结果只证明登记结果，不证明会话任务完成。HTTP 200 的 `{ok: false, error}` 沿用原生错误处理，`native_error` 的 `error.native` 保留 code、message 和 details，包括 `bridge/attach-failed` 的 cwd 不符或会话存储不存在信息。

旧插件路由缺失时 HTTP 404 映射为 `unsupported`、`not_started`，明确提示插件版本过旧，需发布 `agent-fleet-dsh` 并重启 DSH 桌面版。HTTP 400（参数非法）和 503（Host 的 workspaceRegistry 不可用）沿用传输错误处理；没有可确认结果的写操作保守报告 `unknown`，不自动重试。

### 权限预设

执行约定由实例 `context` 声明。会话的权限预设由原生服务持有：`session/create` 和 `session/prompt` 接受 Connector 桥接顶层参数 `permission`（原生 `/permission` 预设名，可用 `read-only`、`workspace-write`、`danger-full-access`）。

- `session/create`：创建后把会话切到 `permission`；没传时切到 `danger-full-access`（编码会话默认不变）。
- `session/prompt`：传了 `permission` 时在提交前把会话切到该值；没传时保持会话当前权限，不做任何切换，已有会话的设置仍由原生服务持有。

切换与桌面里切换权限是同一条原生路径：Connector 先读 `session/projections` 的 `permissions.currentValue`，与目标不同才经原生 `commands/execute` 运行 `/permission <preset>`，相同则不重复执行；DSH 会在会话里记录策略变化，并向模型注入一条变化通知。准备步骤与输入不是事务：输入失败时权限切换可能已经生效。审批策略由原生预设决定（`danger-full-access` 为 `never`，不会产生需要回答的审批请求）；agent 向用户提的问题仍由调用者用 `userQuestions/answer` 明确回答。

### 结果与错误

原生 RemoteError 以 `native_error` 返回，`error.native` 保留 `{code, message, details}`；参数或策略拒绝为 `rejected`。写操作的响应丢失或 Gateway 内部错误报告 `unknown`，Connector 不自动重试；`session/prompt` 可以用同一 `requestId` 重试，由原生端去重。结果超过 64 KiB 时返回共享的 `result_too_large`，调用者用更小的 `maxMessages` 或 `session/page` 分页。

## 事件

Connector 常开一条原生 `session/control` 流。它对每个有活动 agent 的会话（不区分谁打开的）推送投影变化帧，Connector 据此对该会话打开 `session/follow`，把之后的持久事件作为 `runtime.changed` 发出：`turn/start`、`turn/end`、`approval/asked|decided`、`user-questions/*`，以及来源为 `user` 的 `user/message`（DSH 自己注入的运行时上下文、时间和策略通知不唤醒调用者）。`userQuestions` 投影变化另以 `projection/userQuestions` 发出。超过 8 KiB 的事件数据以 `dataOmitted` 代替，正文用 `session/page` 读取。follow 空闲 10 分钟后关闭，下次活动再打开，并从已报告的 seq 之后继续，不重复发出。

`session/control` 断开时发出 `agenvo.resync_required`，实例变为不可用，更换 generation 后重连；重连不重放业务写入，期间的事件可能缺失，调用者应重新读取会话状态和历史。

## 验证依据

接口基线为 DSH 桌面版 `0.2.1-rc.2`，仅用于复现，不是版本白名单。

- `workspace/attachSession`：隔离 socket fixture 覆盖可发现性、写操作标记、参数拒绝、成功 value、插件错误原文和旧插件 404。插件侧路由在 agent-fleet 的配套 PR 中实现；本 Connector 未连接真实 DSH，此方法的桌面效果与 relay 路径仍待验证。
- `tests/dsh.test.ts`：按插件桥接契约实现的 Unix socket fixture。覆盖共同术语发现、create 与 prompt 的权限预设（create 默认 `danger-full-access`，传 `permission` 时只执行一次对应 `/permission`；prompt 不传 `permission` 不切换，传则先切再提交；已是目标值时不重复）、列出用户会话、follow 快照与 page、原生拒绝、参数 schema 拒绝、写响应丢失报告 `unknown` 且不重试、事件过滤，以及观察流断开后的 resync 与重连。
- 隔离的真实 DSH：临时 `DSH_HOME` 与 `HOME` 下 `dsh web` 加载桥接插件，Connector 实测 `session/list`、`workspace/create`、`session/create`（随后为 `danger-full-access`）、`session/prompt`、`session/follow`、`session/page`、未知会话的 `session/not-found` 拒绝、`session/cancel`，以及 `turn/start`、`user/message`、`turn/end` 事件。没有模型凭据，turn 以原生错误结束，这不影响连接与事件路径的验证。
- 插件侧测试在 dsh-grokbot-dispatch 的 `test/native-bridge.test.js`。

## 更新接口基线

```sh
npx @electron/asar extract "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" /tmp/dsh-asar
node scripts/import-dsh-schema.mjs /tmp/dsh-asar
```

导入后比对 `schema.json` 的差异，并重跑 `tests/dsh.test.ts` 与上面的隔离实测。
