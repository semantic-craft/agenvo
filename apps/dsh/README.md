# @agenvo/dsh

Attach Agenvo to a running DeepSeek Harness (DSH) desktop app. Every desktop session is shared,
including sessions the user opened by hand: list them, read output, create sessions, submit input,
interrupt, and receive `runtime.changed` events. Closing the Connector leaves DSH and its turns running.

The desktop Host serves no HTTP of its own. The
[dsh-grokbot-dispatch](https://github.com/semantic-craft/dsh-grokbot-dispatch) plugin, loaded in the
desktop profile, forwards the Host's native Typert endpoints on a same-user Unix socket
(`~/.local/state/dsh-grokbot-dispatch/native.sock`, mode 0600). Design and evidence:
[design/dsh-connector.zh-CN.md](../../design/dsh-connector.zh-CN.md).

```sh
agenvo-dsh instance add --id dsh-laptop \
  --endpoint unix://$HOME/.local/state/dsh-grokbot-dispatch/native.sock
agenvo-dsh connect https://RELAY --name "HOST / dsh"
agenvo-dsh service install
```

Methods keep DSH's native endpoint names and named arguments (`session/list`, `session/follow`,
`session/page`, `workspace/create`, `session/create`, `session/prompt`, `session/cancel`,
`userQuestions/answer`, ...). `session/create` sets the session to the native `/permission` preset
`permission` when you pass one, otherwise `danger-full-access`; `session/prompt` switches the session
to `permission` before submitting when you pass one, and otherwise leaves the session's current
permission unchanged (presets: `read-only`, `workspace-write`, `danger-full-access`). Declare the
execution convention in the instance `context`.
`session/follow` and `session/page` keep each `assistant/message` record's answer text in
`message.content`; the duplicated streaming frames (`data.stream`) are included only when you pass
`assistantStream: true`.

`workspace/attachSession` is a writable Connector bridge, not a native DSH endpoint.
The `agent-fleet-dsh` plugin serves it through the desktop Host's workspace registry
at `POST /bridge/workspace/attachSession`. Call it with
`{path: "/work/project", sessionId: "SESSION_ID", title: "Project"}` (`title` is optional)
to register an existing session, including one created with `dsh --profile headless`,
under a desktop sidebar project. `path` must be absolute and resolve to the session's cwd.
Registration is idempotent and safe while the CLI process is running; it does not submit input.
The plugin creates the workspace if absent and disambiguates duplicate names as
`basename · short parent path`. The result is
`{workspace: {workspaceId, path, title, sessionIds}, created}`.
Plugin refusals preserve their code, message and details in `error.native` (`native_error`).
HTTP 404 returns `unsupported`: the plugin is too old; publish `agent-fleet-dsh` and restart
DSH desktop. HTTP 400 (invalid arguments) and 503 (Host workspace registry unavailable)
are transport failures; no write is automatically retried.
