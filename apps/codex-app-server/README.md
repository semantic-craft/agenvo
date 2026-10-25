# @agenvo/codex-app-server

[简体中文](README.zh-CN.md)

Connect to an independently running Codex app-server over a Unix socket or loopback WebSocket. Connector shutdown and updates leave the native service and its turns running.

<!-- x-release-please-start-version -->

```sh
npm install --global @agenvo/codex-app-server@0.2.0
```

<!-- x-release-please-end -->

For AI agents: follow the [installation guide](https://github.com/Xuanwo/agenvo/blob/v0.2.0/docs/installation.md) for relay deployment, device pairing, and client authorization. <!-- x-release-please-version -->

Requires Node.js 24.13+. Installing a Connector does not install Herdr or Codex.

[Usage and deployment](https://github.com/Xuanwo/agenvo/blob/v0.2.0/docs/usage.md) <!-- x-release-please-version -->

After reading the terminal turn and output, call `thread/unsubscribe {threadId}` on the same connector to release its subscription. The native status is returned unchanged. Event watching does not subscribe to other clients’ loaded threads; reconnect restores only explicit subscriptions that have not been released. Notifications may stop after unsubscribe; use `thread/read` or `thread/turns/list` for durable history.
