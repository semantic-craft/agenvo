# agenvo 的最小补丁分支（基于上游 v0.2.0 之后的 main 9ec5643）

上游是 `Xuanwo/agenvo`（Apache-2.0），LICENSE 与 NOTICE 保持不变。分支 `xw/dispatch-connectors`，远端是公开 fork `semantic-craft/agenvo`（`main` 只镜像上游）
（本地 remote `xw`，走 SSH；`origin` 指向上游）。该 fork 已关闭 GitHub Actions，验证在本机执行。

为什么要有这个分支、何时可以去掉、整套基础设施怎么部署和验收，都在 [semantic-craft/agent-fleet](https://github.com/semantic-craft/agent-fleet)，
尤其是它的 [ADR-0002](https://github.com/semantic-craft/agent-fleet/blob/main/docs/decisions/0002-minimal-agenvo-fork.md)。本文件只记录补丁本身。

## 相对上游的改动

- `packages/protocol`：实例 `kind` 增加 `dsh`、`zcode`。relay 会校验这个枚举，所以 relay 也必须用本分支的源码部署。
- `packages/relay/src/releases.ts`：`dsh` 映射到 `@agenvo/dsh`，`zcode` 映射到 `@agenvo/dispatch`。上游的发布提示不会指向本分支，升级时手动合并上游 tag。
- `apps/dsh`：DSH 桌面版 connector `agenvo-dsh`，经桌面 Host 插件（dsh-grokbot-dispatch 的 native bridge）在同用户 Unix socket 上调用 DSH 原生 Typert 端点，覆盖列出/读取/新建/追加输入/中断与事件，见 [设计](design/dsh-connector.zh-CN.md)。
  `scripts/import-dsh-schema.mjs` 从 DSH 安装包导入原生 schema；`tests/dsh.test.ts` 是桥接契约 fixture 测试。这部分不依赖个人值，可以提给上游。
- `apps/dispatch`：ZCode 专用 connector `agenvo-dispatch`，薄封装接收端的 `GET /health`、`POST /v1/jobs`、`GET /v1/jobs/<id>`，见其 [README](apps/dispatch/README.md)。
  `jobs.create` 固定发送 `runner: "app"`；`jobs.get` 和 `job.finished` 事件带上实际执行路径 `runner`。
- `apps/codex-app-server`：不提供 `requests.respond`。agent 向用户提的问题与动态工具调用仍可经 `requests.list` 查看，由用户在 Codex 桌面版里回答；权限审批照上游自动处理。相关测试断言调用 `requests.respond` 返回 `unsupported_method`。
- `tests/dispatch.test.ts`：接收端契约、full access 默认值、`[Project:]` 标签、严格 runner 被拒的情形，以及 `job.finished` 事件。

## 合并上游

```sh
git fetch origin --tags && git merge vX.Y.Z      # 只会在 protocol 枚举和 releases 映射处产生冲突
npm ci && npm run check && npm test && node scripts/build.mjs dsh && node scripts/build.mjs dispatch
```

之后按 agent-fleet 的 runbook 重新部署 relay，并重启全部 connector。
