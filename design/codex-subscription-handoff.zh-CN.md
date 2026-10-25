# Codex 订阅与 Desktop 交接

目标：调用方提交并读完一轮后，能将线程交还给 Desktop，事件观察不再重新取得别的客户端的 writer。

`thread/start` / `thread/resume` 显式取得订阅并加入 resumeTargets；原生连接重连仅恢复该集合，不重放用户输入。watchEvents 只安装通知接收者；移除每三秒扫描 loaded/list 并自动 resume 的逻辑。loaded 表示服务端状态，不代表本连接有权订阅。

`thread/unsubscribe {threadId}` 透传原生返回值（status：unsubscribed、notSubscribed、notLoaded）；成功响应后删除 resumeTargets。原生错误或传输 unknown 不冒认退订成功。最后订阅者离开后的卸载时机由原生服务负责，不增加本地计时器或调度状态。

同机的独立 app-server 与 Desktop 可共享历史，但持有不同连接。调用方先读取终态及答案，再由持有订阅的连接退订；之后 notifications 可能停止，持久历史用 thread/read 或 thread/turns/list。重新执行才显式 resume。connector 重启不是原生放锁证明。

参数 schema 从 Codex 0.160.1 generate-json-schema 的 ThreadUnsubscribeParams 核对（与 0.164.0 相同），保留原 schema 基线其余字段不变；导入脚本同步加入该方法。方法不设置本地响应转换或新增运行时版本限制。

隔离回归在 Unix/WebSocket 两种传输验证 loaded orphan 不被收养、unsubscribed/notSubscribed 后重连只恢复尚持有的线程且不重放 turn/start。真实 Desktop 的左栏项目可见与无 writerConflict 是独立 UI 验收；原生测试不代替它。
