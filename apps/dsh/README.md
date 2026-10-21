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
`userQuestions/answer`, ...). `session/create` and `session/prompt` switch the session to the native
`danger-full-access` permission preset first when it differs; declare that in the instance `context`.
`session/follow` and `session/page` keep each `assistant/message` record's answer text in
`message.content`; the duplicated streaming frames (`data.stream`) are included only when you pass
`assistantStream: true`.
