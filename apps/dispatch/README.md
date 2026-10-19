# @agenvo/dispatch

Fork-only connector (see [FORK.md](../../FORK.md)). Attaches Agenvo to an already running
[zcode-dispatch](https://github.com/semantic-craft/zcode-dispatch) receiver, so an MCP client
(ChatGPT, dots) can start visible ZCode desktop sessions. DSH desktop has its own native
connector, [`@agenvo/dsh`](../dsh/README.md).

```sh
agenvo-dispatch instance add --id zcode-laptop \
  --endpoint http://HOST:7791 --key-file ~/.config/zcode-dispatch/key
agenvo-dispatch connect https://RELAY --name "HOST / dispatch"
agenvo-dispatch service install
```

The receiver's `allowedIps` must include the connector's source address; the key file is the
receiver's own inbound Bearer key (mode 0600).

| Method        | Native call         | Notes                                                                                                                                                                                                        |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `health`      | `GET /health`       | Receiver availability, not app idleness                                                                                                                                                                      |
| `jobs.create` | `POST /v1/jobs`     | New visible session in `~/Projects/<project>`; adds `[Project: …]`; `yolo` by default; always sends `runner: "app"`, so a missing desktop app is a `rejected` HTTP 503 or a failed job, never a headless run |
| `jobs.get`    | `GET /v1/jobs/<id>` | State, `runner` (path that actually ran: `app` = visible session), session id, final text (truncated to fit 64 KiB)                                                                                          |

Events (`runtime.changed`): `job.started`, `job.finished` (polled every 5 s for jobs created
through this connector), `agenvo.resync_required` when the receiver becomes reachable. Jobs
created before a connector restart are not followed; read them with `jobs.get`.

No remote follow-up input: the receiver only creates sessions. Continue a session by hand in the
desktop app.
