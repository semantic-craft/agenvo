import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DshAdapter } from "../apps/dsh/src/dsh.js";
import { instanceConfigSchema } from "../apps/dsh/src/config.js";
import { describe } from "../packages/connector/src/adapters/adapter.js";
import { socketTempDir, until } from "./support/environment.js";

// Same wire contract as the native bridge in the dsh-grokbot-dispatch desktop plugin:
// POST /api/<endpoint> {args} -> {ok, value|error}; POST /stream/<endpoint> {args} -> NDJSON {item}.
async function desktop(socket: string) {
  let bridgeReply = { status: 404, body: { error: "not found" } as unknown };
  const calls: {
    endpoint: string;
    args: any;
    carrier: string;
    method?: string;
  }[] = [];
  const sessions = new Map<string, { preset: string; seq: number }>();
  const durable = new Map<string, any[]>();
  const control = new Set<http.ServerResponse>();
  const follows = new Map<string, Set<http.ServerResponse>>();
  let dropNext = "";
  const frame = (res: http.ServerResponse, item: unknown) =>
    res.write(JSON.stringify({ item }) + "\n");
  const append = (sessionId: string, type: string, data: unknown) => {
    const session = sessions.get(sessionId)!;
    const event = { type, seq: ++session.seq, time: Date.now(), data };
    for (const res of follows.get(sessionId) ?? [])
      frame(res, { type: "event", event });
    for (const res of control)
      frame(res, {
        type: "projection",
        sessionId,
        key: "sessionStats",
        value: {},
        seq: event.seq,
      });
  };
  const unary: Record<string, (args: any) => any> = {
    "session/list": () => ({
      items: [...sessions]
        .map(([sessionId, s]) => ({
          sessionId,
          running: false,
          projections: {
            values: {
              permissions: { currentValue: s.preset },
              tokenUsage: { padding: "t".repeat(1500) },
            },
          },
        }))
        .reverse(),
    }),
    "session/create": ({ request }) => {
      const sessionId = "session-" + (sessions.size + 1);
      sessions.set(sessionId, { preset: "workspace-write", seq: 2 });
      return { sessionId, cwd: request.cwd };
    },
    "session/projections": ({ request }) => {
      const s = sessions.get(request.sessionId);
      if (!s) throw { code: "session/not-found", message: "not found" };
      return { values: { permissions: { currentValue: s.preset } } };
    },
    "commands/execute": ({ agentId, line }) => {
      sessions.get(agentId)!.preset = line.split(" ")[1];
      return { commandId: "c1", result: { kind: "success", text: line } };
    },
    "session/prompt": ({ request }) => {
      if (!sessions.has(request.sessionId))
        throw { code: "session/not-found", message: "not found" };
      const id = request.sessionId;
      setTimeout(() => {
        append(id, "turn/start", { turn: 1 });
        append(id, "user/message", {
          source: { kind: "runtime-context" },
          content: [],
        });
        append(id, "user/message", {
          source: { kind: "user", rpcId: request.requestId },
          content: request.content,
        });
        append(id, "assistant/message", { content: "x".repeat(20000) });
        append(id, "turn/end", { turn: 1, reason: { kind: "completed" } });
      }, 50);
      return { accepted: true };
    },
    "session/page": ({ request }) => {
      const s = sessions.get(request.address.sessionId)!;
      if (request.throughSeq > s.seq)
        throw { code: "gateway/bad-request", message: "past cursor" };
      return {
        records: durable.get(request.address.sessionId) ?? [],
        hasMore: false,
      };
    },
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, pid: 1, dsh: "0.2.1-test" }));
    }
    const [, carrier, ...rest] = req.url!.split("/");
    const endpoint = rest.join("/");
    const { args } = JSON.parse(raw);
    calls.push({ endpoint, args, carrier, method: req.method });
    if (dropNext === endpoint) {
      dropNext = "";
      return req.socket.destroy();
    }
    if (carrier === "bridge") {
      res.writeHead(bridgeReply.status, { "content-type": "application/json" });
      return res.end(JSON.stringify(bridgeReply.body));
    }
    if (carrier === "api") {
      res.writeHead(200, { "content-type": "application/json" });
      try {
        return res.end(
          JSON.stringify({ ok: true, value: unary[endpoint](args) }),
        );
      } catch (error) {
        return res.end(JSON.stringify({ ok: false, error }));
      }
    }
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    if (endpoint === "session/control") {
      control.add(res);
      res.on("close", () => control.delete(res));
      return frame(res, { type: "baseline", value: { projections: {} } });
    }
    const id = args.request.address.sessionId;
    const s = sessions.get(id)!;
    const recs = durable.get(id) ?? [];
    frame(res, {
      type: "snapshot",
      cursor: s.seq,
      records: recs.length
        ? recs
        : [{ type: "event", event: { type: "turn/end", seq: s.seq } }],
    });
    if (!follows.has(id)) follows.set(id, new Set());
    follows.get(id)!.add(res);
    res.on("close", () => follows.get(id)!.delete(res));
  });
  server.listen(socket);
  await once(server, "listening");
  return {
    calls,
    reply: (status: number, body: unknown) => (bridgeReply = { status, body }),
    sessions,
    durable,
    seed: (sessionId: string, event: any) => {
      const list = durable.get(sessionId) ?? [];
      list.push({ type: "event", event });
      durable.set(sessionId, list);
    },
    append,
    drop: (endpoint: string) => (dropNext = endpoint),
    disconnect: () => {
      for (const res of control) res.destroy();
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test("dsh connector manages desktop sessions through native endpoints", async (t) => {
  const dir = await mkdtemp(join(socketTempDir(), "agenvo-dsh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socket = join(dir, "native.sock");
  const native = await desktop(socket);
  t.after(native.close);
  const adapter = new DshAdapter(
    instanceConfigSchema.parse({
      id: "dsh-test",
      label: "DSH",
      kind: "dsh",
      endpoint: "unix://" + socket,
    }),
  );
  t.after(() => adapter.close());
  const events: any[] = [];
  adapter.watchEvents((e) => events.push(e));
  await adapter.init();
  assert.equal(adapter.available, true);
  assert.equal(adapter.version, "0.2.1-test");

  // The shared discovery terms find the native endpoints.
  for (const [query, name] of [
    ["list work contexts", "session/list"],
    ["create work context", "session/create"],
    ["submit input", "session/prompt"],
    ["read output", "session/follow"],
    ["interrupt", "session/cancel"],
    ["respond", "userQuestions/answer"],
  ])
    assert.ok(
      describe(adapter, { query }).items.some((m: any) => m.name === name),
      query,
    );

  // Create applies full access through the native /permission command.
  const created = await adapter.call("session/create", {
    request: { cwd: "/work/koe" },
  });
  assert.equal(created.execution, "accepted");
  const sessionId = created.nativeIds!.sessionId;
  assert.equal(native.sessions.get(sessionId)!.preset, "danger-full-access");
  assert.deepEqual(
    native.calls.find((c) => c.endpoint === "commands/execute")!.args,
    {
      agentId: sessionId,
      line: "/permission danger-full-access",
      submittedAttachments: [],
    },
  );

  // A session the user opened by hand keeps its preset; listing does not switch it.
  native.sessions.set("session-user", { preset: "workspace-write", seq: 5 });
  const listed = await adapter.call("session/list", { _request: {} });
  assert.ok(
    (listed.result as any).items.some(
      (r: any) => r.sessionId === "session-user",
    ),
  );
  assert.equal(native.sessions.get("session-user")!.preset, "workspace-write");

  // Native session/list has no paging; the bridge pages rows and keeps chosen projection keys under 64 KiB.
  for (let n = 0; n < 60; n++)
    native.sessions.set(`session-old-${n}`, {
      preset: "workspace-write",
      seq: 1,
    });
  const first = (await adapter.call("session/list", { _request: {} })) as any;
  assert.equal(first.execution, "accepted");
  assert.equal(first.result.items.length, 20);
  assert.equal(first.result.total, 62);
  assert.equal(first.result.nextOffset, 20);
  assert.deepEqual(Object.keys(first.result.items[0].projections.values), [
    "permissions",
  ]);
  const last = (await adapter.call("session/list", {
    _request: {},
    offset: 60,
    limit: 20,
    projections: ["tokenUsage"],
  })) as any;
  assert.equal(last.result.items.length, 2);
  assert.equal(last.result.nextOffset, undefined);
  assert.ok(last.result.items[0].projections.values.tokenUsage);
  for (let n = 0; n < 60; n++) native.sessions.delete(`session-old-${n}`);

  // Create with a permission bridge key runs exactly that /permission, never full access.
  const ro = await adapter.call("session/create", {
    request: { cwd: "/work/koe" },
    permission: "read-only",
  });
  assert.equal(ro.execution, "accepted");
  const roId = ro.nativeIds!.sessionId;
  assert.equal(native.sessions.get(roId)!.preset, "read-only");
  const roExecutes = native.calls.filter(
    (c) => c.endpoint === "commands/execute" && c.args.agentId === roId,
  );
  assert.equal(roExecutes.length, 1);
  assert.equal(roExecutes[0].args.line, "/permission read-only");
  assert.ok(
    !native.calls.some(
      (c) =>
        c.endpoint === "commands/execute" &&
        c.args.agentId === roId &&
        c.args.line === "/permission danger-full-access",
    ),
  );
  // The bridge key is consumed by the Connector and never forwarded to native session/create.
  const createArgs = native.calls
    .filter((c) => c.endpoint === "session/create")
    .at(-1)!.args;
  assert.equal("permission" in createArgs, false);

  const executes = () =>
    native.calls.filter((c) => c.endpoint === "commands/execute").length;
  const before = executes();

  // Prompt without a permission bridge key runs no /permission and keeps the session's preset.
  const promptedRo = await adapter.call("session/prompt", {
    request: {
      requestId: "r1",
      sessionId: roId,
      mode: "queue",
      content: [{ type: "text", text: "只读：说明项目" }],
    },
  });
  assert.equal(promptedRo.execution, "accepted");
  assert.deepEqual(promptedRo.nativeIds, { sessionId: roId });
  assert.equal(native.sessions.get(roId)!.preset, "read-only");
  assert.equal(executes(), before);

  // Prompt with a permission bridge key switches the session first, then submits.
  const prompted = await adapter.call("session/prompt", {
    request: {
      requestId: "r2",
      sessionId: "session-user",
      mode: "queue",
      content: [{ type: "text", text: "写：说明项目" }],
    },
    permission: "danger-full-access",
  });
  assert.equal(prompted.execution, "accepted");
  assert.deepEqual(prompted.nativeIds, { sessionId: "session-user" });
  assert.equal(
    native.sessions.get("session-user")!.preset,
    "danger-full-access",
  );
  assert.equal(executes(), before + 1);
  // The bridge key is consumed by the Connector and never forwarded to native session/prompt.
  const promptArgs = native.calls
    .filter((c) => c.endpoint === "session/prompt")
    .at(-1)!.args;
  assert.equal("permission" in promptArgs, false);

  // A prompt without permission on the now-full-access session leaves it unchanged and runs no /permission.
  await adapter.call("session/prompt", {
    request: {
      requestId: "r5",
      sessionId: "session-user",
      mode: "queue",
      content: [{ type: "text", text: "again" }],
    },
  });
  assert.equal(
    native.sessions.get("session-user")!.preset,
    "danger-full-access",
  );
  assert.equal(executes(), before + 1);

  // Durable follow events wake the caller; DSH's own context injections and assistant output do not.
  await until(
    () =>
      events.some(
        (e) => e.nativeType === "turn/end" && e.threadId === "session-user",
      ),
    Boolean,
  );
  const types = events
    .filter((e) => e.threadId === "session-user")
    .map((e) => e.nativeType);
  assert.ok(types.includes("turn/start"));
  assert.equal(types.filter((t) => t === "user/message").length >= 1, true);
  assert.ok(!types.includes("assistant/message"));
  assert.ok(
    events
      .filter((e) => e.nativeType === "user/message")
      .every((e) => e.native.event.data.source.kind === "user"),
  );

  // Read output: follow snapshot, then a page through its cursor.
  const snap = await adapter.call("session/follow", {
    request: {
      address: { kind: "session", sessionId: "session-user" },
      maxMessages: 4,
    },
  });
  assert.equal(snap.execution, "accepted");
  const cursor = (snap.result as any).cursor;
  assert.equal(typeof cursor, "number");
  const page = await adapter.call("session/page", {
    request: {
      address: { kind: "session", sessionId: "session-user" },
      throughSeq: cursor,
    },
  });
  assert.equal(page.execution, "accepted");
  const past = await adapter.call("session/page", {
    request: {
      address: { kind: "session", sessionId: "session-user" },
      throughSeq: cursor + 100,
    },
  });
  assert.equal(past.execution, "rejected");
  assert.equal((past.error!.native as any).code, "gateway/bad-request");

  // Native refusal, schema refusal and a lost write response stay distinct.
  await assert.rejects(
    adapter.call("session/cancel", { request: {} }),
    (e: any) => e.code === "invalid_params" && e.execution === "not_started",
  );
  const notFound = await adapter.call("session/prompt", {
    request: {
      requestId: "r3",
      sessionId: "session-nope",
      mode: "queue",
      content: [{ type: "text", text: "x" }],
    },
  });
  assert.equal(notFound.execution, "rejected");
  native.drop("session/prompt");
  const lost = await adapter.call("session/prompt", {
    request: {
      requestId: "r4",
      sessionId: "session-user",
      mode: "queue",
      content: [{ type: "text", text: "x" }],
    },
  });
  assert.equal(lost.execution, "unknown");
  assert.equal(lost.error!.code, "native_transport_error");
  assert.equal(
    native.calls.filter(
      (c) =>
        c.endpoint === "session/prompt" && c.args.request.requestId === "r4",
    ).length,
    1,
    "a lost write is never retried",
  );

  // Losing the observation stream marks the instance unavailable and asks callers to resync.
  native.disconnect();
  await until(
    () => events.some((e) => e.native?.reason === "native_disconnected"),
    Boolean,
  );
  await until(() => adapter.available, Boolean);
  assert.ok(
    events.filter((e) => e.native?.reason === "native_connected").length >= 2,
  );
});

test("dsh connector reads output without duplicate assistant stream frames", async (t) => {
  const dir = await mkdtemp(join(socketTempDir(), "agenvo-dsh-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socket = join(dir, "native.sock");
  const native = await desktop(socket);
  t.after(native.close);
  const adapter = new DshAdapter(
    instanceConfigSchema.parse({
      id: "dsh-stream",
      label: "DSH stream",
      kind: "dsh",
      endpoint: "unix://" + socket,
    }),
  );
  t.after(() => adapter.close());
  await adapter.init();

  // A durable assistant/message whose answer text lives in message.content and whose
  // duplicated streaming frames in data.stream would push the record past 64 KiB.
  const content = "c".repeat(20 * 1024); // ~20 KiB of answer text
  const seed = (sessionId: string, seq: number, streamBytes: number) => {
    native.sessions.set(sessionId, { preset: "danger-full-access", seq });
    native.seed(sessionId, {
      type: "assistant/message",
      seq,
      time: Date.now(),
      data: {
        turn: { id: "t1" },
        step: { id: "s1" },
        message: {
          role: "assistant",
          content: [{ type: "text", text: content }],
          source: { kind: "assistant" },
          id: "m1",
        },
        usage: {},
        stream: [
          {
            type: "chunk",
            time: Date.now(),
            chunk: { type: "text", text: "s".repeat(streamBytes) },
          },
        ],
      },
    });
  };
  const record = (outcome: any) => outcome.result.records[0].event;

  // Default follow omits data.stream and keeps the answer text, so the snapshot fits the frame.
  const sessionId = "session-big";
  seed(sessionId, 2, 50 * 1024);
  const follow = await adapter.call("session/follow", {
    request: { address: { kind: "session", sessionId }, maxMessages: 1 },
  });
  assert.equal(follow.execution, "accepted");
  assert.equal(follow.error, undefined);
  assert.equal(record(follow).data.stream, undefined);
  assert.equal(record(follow).data.message.content[0].text, content);

  // Default page omits data.stream the same way.
  const page = await adapter.call("session/page", {
    request: {
      address: { kind: "session", sessionId },
      throughSeq: 2,
      beforeSeq: 3,
      maxMessages: 1,
    },
  });
  assert.equal(page.execution, "accepted");
  assert.equal(page.error, undefined);
  assert.equal(record(page).data.stream, undefined);
  assert.equal(record(page).data.message.content[0].text, content);

  // assistantStream: true keeps data.stream; use a smaller stream so the kept record still fits.
  const keepId = "session-keep";
  seed(keepId, 2, 20 * 1024);

  // The connector bridge top-level assistantStream keeps data.stream and is not forwarded.
  const followBridge = await adapter.call("session/follow", {
    request: {
      address: { kind: "session", sessionId: keepId },
      maxMessages: 1,
    },
    assistantStream: true,
  });
  assert.equal(followBridge.execution, "accepted");
  assert.equal(followBridge.error, undefined);
  assert.ok(Array.isArray(record(followBridge).data.stream));
  assert.equal(record(followBridge).data.message.content[0].text, content);
  const followArgs = native.calls
    .filter((c) => c.endpoint === "session/follow")
    .at(-1)!.args;
  assert.equal("assistantStream" in followArgs, false);

  const pageBridge = await adapter.call("session/page", {
    request: {
      address: { kind: "session", sessionId: keepId },
      throughSeq: 2,
      maxMessages: 1,
    },
    assistantStream: true,
  });
  assert.equal(pageBridge.execution, "accepted");
  assert.equal(pageBridge.error, undefined);
  assert.ok(Array.isArray(record(pageBridge).data.stream));
  const pageArgs = native.calls
    .filter((c) => c.endpoint === "session/page")
    .at(-1)!.args;
  assert.equal("assistantStream" in pageArgs, false);

  // The native request option assistantStream: true is forwarded as-is and keeps data.stream.
  const followRequest = await adapter.call("session/follow", {
    request: {
      address: { kind: "session", sessionId: keepId },
      maxMessages: 1,
      assistantStream: true,
    },
  });
  assert.equal(followRequest.execution, "accepted");
  assert.ok(Array.isArray(record(followRequest).data.stream));
  const requestArgs = native.calls
    .filter((c) => c.endpoint === "session/follow")
    .at(-1)!.args;
  assert.equal(requestArgs.request.assistantStream, true);
});

test("dsh connector attaches existing sessions through the workspace bridge", async (t) => {
  const dir = await mkdtemp(join(socketTempDir(), "agenvo-dsh-attach-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socket = join(dir, "native.sock");
  const native = await desktop(socket);
  t.after(native.close);
  const adapter = new DshAdapter(
    instanceConfigSchema.parse({
      id: "dsh-attach",
      label: "DSH",
      kind: "dsh",
      endpoint: "unix://" + socket,
    }),
  );
  t.after(() => adapter.close());
  await adapter.init();
  const name = "workspace/attachSession";
  const params = { path: "/work/project", sessionId: "session-cli" };

  await t.test("discovery identifies a writable non-native bridge", () => {
    const method = adapter.methods().find((m) => m.name === name);
    assert.ok(method);
    assert.equal(method.readOnly, false);
    assert.match(
      method.description,
      /Connector bridge \(not a native DSH endpoint\)/,
    );
    assert.ok(
      describe(adapter, { query: "create work context" }).items.some(
        (m: any) => m.name === name,
      ),
    );
  });
  await t.test("invalid arguments are refused before dispatch", async () => {
    const before = native.calls.length;
    for (const invalid of [
      {},
      { sessionId: "s" },
      { path: "/work" },
      { ...params, path: "relative" },
      { ...params, path: "" },
      { ...params, path: 1 },
      { ...params, sessionId: 1 },
      { ...params, sessionId: "" },
      { ...params, title: 1 },
      { ...params, extra: true },
    ])
      await assert.rejects(
        adapter.call(name, invalid),
        (e: any) =>
          e.code === "invalid_params" && e.execution === "not_started",
      );
    assert.equal(native.calls.length, before);
  });
  await t.test(
    "success preserves the workspace and created flag with optional title",
    async () => {
      for (const created of [true, false]) {
        const args = created ? { ...params, title: "Project" } : params;
        const value = {
          workspace: {
            workspaceId: "w1",
            path: params.path,
            title: "Project",
            sessionIds: [params.sessionId],
          },
          created,
        };
        native.reply(200, { ok: true, value });
        const outcome = await adapter.call(name, args);
        assert.equal(outcome.execution, "accepted");
        assert.deepEqual(outcome.result, value);
        assert.deepEqual(native.calls.at(-1), {
          endpoint: name,
          carrier: "bridge",
          method: "POST",
          args,
        });
      }
    },
  );
  await t.test(
    "plugin refusals preserve code, message and details",
    async () => {
      for (const message of [
        "its cwd resolves to /work/other",
        "session persistence holds no such session",
      ]) {
        const error = {
          code: "bridge/attach-failed",
          message,
          details: { sessionId: params.sessionId },
        };
        native.reply(200, { ok: false, error });
        const outcome = await adapter.call(name, params);
        assert.equal(outcome.execution, "rejected");
        assert.equal(outcome.error?.code, "native_error");
        assert.ok(outcome.error?.message.includes(message));
        assert.deepEqual(outcome.error?.native, error);
      }
    },
  );
  await t.test(
    "old plugins report the required upgrade and desktop restart",
    async () => {
      native.reply(404, { error: "not found" });
      const outcome = await adapter.call(name, params);
      assert.equal(outcome.execution, "not_started");
      assert.equal(outcome.error?.code, "unsupported");
      assert.match(outcome.error!.message, /agent-fleet-dsh/);
      assert.match(outcome.error!.message, /publish/i);
      assert.match(outcome.error!.message, /restart.*DSH desktop/i);
    },
  );
});
