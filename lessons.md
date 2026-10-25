# 项目教训

## 观察线程不等于取得订阅

- 起因与后果：watchEvents 扫描 loaded/list 后 resume 全部线程，会取得其他客户端的 writer，导致 Desktop writerConflict。
- 修复：显式 start/resume 决定 resumeTargets，退订成功删除目标；事件观察不自动收养线程。
- 验证：tests/codex-attach.test.ts 在 Unix/WebSocket 覆盖原失败路径与退订后的重连；真实 Desktop 可见性另验。
- Seen 1x (2026-10-25)。
