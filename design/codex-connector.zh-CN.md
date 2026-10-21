# Codex app-server Connector

Codex Connector 暴露原生 thread/turn 能力，以及连接通知和服务端请求的必要桥接。Thread 是可继续交互的工作上下文，turn 是一次原生执行。共同契约见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)，调用方式见[管理指南](../docs/management.zh-CN.md#codex)。

## 连接与执行

Connector 仅通过 Unix socket 或 loopback WebSocket 连接独立运行的 app-server，不启动或终止原生进程。Connector 的关闭、更新和重启不停止服务或轮次。配置只记录已有 home、默认工作目录与端点，不创建 Codex home；初始化核对原生 `codexHome`，版本取自 `initialize.userAgent`。Windows 使用 loopback WebSocket。创建、恢复和输入路径应用 full access / never，自动回答执行权限请求；用户问题和动态工具调用由用户在原生客户端回答，Connector 经 `requests.list` 列出待响应条目。

方法保留原生名称及 threadId、turnId。`thread/start` 创建工作上下文，`turn/start` 提交输入；未加载会话可能需要先 resume。列表过滤决定 provider/source 覆盖范围，不将当前加载集合解释为全部持久会话。

## 请求与通知桥接

服务端主动发来的请求不是普通 RPC 调用。`requests.list` 返回完整待响应请求、参数和 responseSchema，供调用者查看；用户在原生客户端回答，原生服务处理后条目随 `serverRequest/resolved`、`item/completed` 或轮次结束清除。请求标识绑定当前连接。自动处理的权限审批不进入待回答列表。

`notifications.list` 返回当前连接已收到的有界原生通知，按 threadId 和 cursor 读取并报告 gap。resume 会话以订阅，但不重放过去输出；未订阅、断线或淘汰会造成缺口。它不提供持久历史或全实例日志。原生历史可用时直接读取；待响应请求独立保存，不能从可淘汰事件日志推导。

## 原生接口依据

接口基线为 Codex CLI 0.160.1，仅用于复现与追溯，不作为运行时版本白名单。

依据该版本二进制生成的 JSON Schema 与[官方 App Server 文档](https://developers.openai.com/codex/app-server/)。schema 包含 experimental 定义，不保证对应功能在所有服务配置下可用。

| 原生能力 | 映射约束 |
| --- | --- |
| `thread/list`、`thread/loaded/list` | 持久列表与当前加载集合不同 |
| `thread/start`、`thread/resume`、`turn/start` | Thread 是可继续交互的上下文，turn 是一次执行 |
| `turn/steer` | 必须携带 `expectedTurnId`；没有匹配的活跃轮次时拒绝，不创建新轮 |
| `turn/interrupt` | 请求确认与实际 interrupted 结果分开观察 |
| `thread/read`、`thread/turns/list`、`thread/items/list` | 历史支持受版本与持久化模式约束，不能据 schema 假定可恢复全部输出 |
| thread/turn/item 通知 | 只有当前订阅连接收到的通知能进入观察记录 |
| server request、`serverRequest/resolved` | 请求绑定当前连接，其他客户端回答后可能失效 |
| `thread/archive/unarchive` | 改变可见性，不等于停止执行或销毁 |

`ThreadStatus` 区分 notLoaded、idle、systemError、active；`TurnStatus` 区分 inProgress、completed、interrupted、failed。Thread 空闲和 turn 完成不能合并为业务成功。

权限请求、用户问题和动态工具调用使用不同响应 schema。`requests.*` 是 Agenvo 对 server request 的桥接方法，不是 Codex 原生 RPC。0.160.1 的历史查询可能返回 `list_turns is not supported yet`；只需元数据时，使用不带 `includeTurns` 的 `thread/read`。

## 验证依据

`tests/system/codex-events.test.ts` 使用独立 Codex 0.160.1 和隔离的本地模型，通过构建后的 CLI 与 Relay MCP 验证 Unix socket、loopback WebSocket 两种连接：执行期间退出 Connector，模型继续完成；以相同设备配置重启后发现原线程、读取同一 turn 的结果，并检查模型请求数未增加。`tests/adapters/codex-turns.test.ts` 在客户端替换后继续 steer 和精确 interrupt 同一活跃 turn。进程生命周期由测试 fixture 持有，Connector 仅持有连接。

协议测试覆盖自动权限响应、用户交互、多客户端请求失效、断线后恢复订阅且不重放输入，以及 home 身份与 Unix 目录权限检查。配置和 doctor 测试检查缺失服务保持不可用且不创建 home。Windows 使用同一 WebSocket 路径；Unix socket 测试只适用于 macOS/Linux。

原生历史不可读时，连接通知日志是已收到输出的唯一记录；事件淘汰后未响应的请求仍要保留，因此通知记录与待响应请求分开保存。

## 更新接口基线

用目标版本重新生成 schema，并通过[适配器测试](../CONTRIBUTING.zh-CN.md)验证；出现字段不等于具有去重、重放或稳定性保证。

```sh
codex --version
codex app-server generate-json-schema --experimental --out /tmp/agenvo-codex-schema
```

仓库中的[Codex schema](../apps/codex-app-server/src/schema/codex.json)保留导入定义；[执行配置](../apps/codex-app-server/src/codex-execution.ts)负责 full-access 设置和自动权限响应。


## 2026-10：显式订阅与交接边界

用户目标是远程派活后在桌面续接。独立 app-server 共用历史但不能同时持有同一 thread writer；轮次完成不释放 writer。0.163.0 生成的协议仅提供 thread/unsubscribe，没有 thread/unload、thread/close 或原子 idle-and-release RPC。隔离双服务、本地模型测试已复现退订成功后仍 loaded、另一服务 resume 返回 active writer；同一服务另一客户端可恢复同一 ID，保留输出与继续输入。

本变更增加原生 thread/unsubscribe，保留原生响应而不伪造“已交还桌面”。执行前核对 idle/notLoaded 与本连接已知待处理交互；同 thread 的本连接变更互斥。它不保证与其他客户端活动原子互斥，也不停止运行中工作。当前连接丢失的交互覆盖不能从旧通知推定；未知原生状态失败关闭。

删除每 3 秒遍历 loaded 并 resume 的自动发现，避免刚退订后或 Connector 重启后再次持有会话。退订发送前删除内存 resumeTargets，原生拒绝或回执丢失也要求显式 resume 恢复；重连不重放输入。后续 turn/start 必须已有本 Connector 的明确订阅目标，避免接受输入却无结果通知。订阅不随 turn/completed 自动移除：完成可能仍需远程追问，交接是显式操作。

安全替代架构是所有交互客户端附着同一个受支持的 app-server，而不是各自启动服务共享 CODEX_HOME。测试只证明原生同服务多客户端协议，不证明当前桌面 UI 已支持此拓扑。部署前必须独立确认桌面支持的入口；没有入口时不能声称根治即时续接，也不能用重启、archive/unarchive 或删锁规避。

验证：tests/codex-handoff.test.ts 使用协议 mock 覆盖 active、pending、同连接并发、idle、重连、重启、回执丢失与显式恢复；tests/native/codex-handoff-0.163.test.ts 使用独立 HOME/CODEX_HOME、两个真实服务及本地模型，覆盖真实 writer 拒绝、同服务续接和两轮历史。没有生产任务、真实 provider 或凭据。原生宽限期的完整 30 分钟到期路径未运行，不把文档时长当成本机已测结果。

schema 基线保留 0.160.1；新增 thread/unsubscribe 单独标注 0.163.0 来源。导入脚本分别接受两份 generate-json-schema 目录，避免把其余方法整体升级或丢失来源。

该0.163.0兼容性回归通过 npm run test:codex-handoff 显式执行，要求 PATH 指向0.163.0。它不纳入仍固定0.160.1的 test:adapters，不把新版特定行为强加给旧版CI。
