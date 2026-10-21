import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { once } from "node:events";
import { CodexAdapter } from "../apps/codex-app-server/src/codex.js";
import { join } from "node:path";
import { socketTempDir, until } from "./support/environment.js";

test("explicit unsubscribe guards work, survives reconnect, and does not rediscover released threads", async (t) => {
  const home = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-handoff-")),
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const calls: any[] = [];
  let status = "active",
    peer: WebSocket;
  let dropUnsubscribe = false,
    holdRead = false;
  let releaseRead: (() => void) | undefined;
  server.on("connection", (ws) => {
    peer = ws;
    ws.on("message", (raw) => {
      const p = JSON.parse(raw.toString());
      calls.push(p);
      if (p.id === undefined || !p.method) return;
      if (p.method === "thread/unsubscribe" && dropUnsubscribe) {
        ws.terminate();
        return;
      }
      const result =
        p.method === "initialize"
          ? { codexHome: home, userAgent: "fixture" }
          : p.method === "thread/read"
            ? { thread: { id: "t", status: { type: status } } }
            : p.method === "thread/loaded/list"
              ? { data: ["t"], nextCursor: null }
              : p.method === "thread/resume"
                ? { thread: { id: "t" } }
                : p.method === "thread/unsubscribe"
                  ? { status: "unsubscribed" }
                  : {};
      const reply = () => ws.send(JSON.stringify({ id: p.id, result }));
      if (p.method === "thread/read" && holdRead) releaseRead = reply;
      else reply();
    });
  });
  const config = {
    kind: "codex" as const,
    id: "fixture",
    label: "fixture",
    home,
    cwd: home,
    endpoint: `ws://127.0.0.1:${(server.address() as any).port}`,
  };
  let adapter = new CodexAdapter(config);
  t.after(async () => {
    await adapter.close();
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(home, { recursive: true, force: true });
  });
  await adapter.init();
  adapter.watchEvents(() => {});
  assert.equal(
    adapter.methods().find((m) => m.name === "thread/unsubscribe")?.readOnly,
    false,
  );
  await adapter.call("thread/resume", { threadId: "t" });
  await assert.rejects(adapter.call("thread/unsubscribe", { threadId: "t" }), {
    code: "thread_busy",
  });
  assert.equal(
    calls.filter((p) => p.method === "thread/unsubscribe").length,
    0,
  );
  status = "idle";
  peer!.send(
    JSON.stringify({
      id: "question",
      method: "item/tool/requestUserInput",
      params: { threadId: "t", turnId: "turn", questions: [] },
    }),
  );
  await adapter.call("model/list", {});
  await assert.rejects(adapter.call("thread/unsubscribe", { threadId: "t" }), {
    code: "thread_busy",
  });
  const pending = (await adapter.call("requests.list", {})).result as any;
  const response = {
    interactionId: pending.items[0].interactionId,
    response: { answers: {} },
  };
  holdRead = true;
  const guardedRelease = adapter.call("thread/unsubscribe", { threadId: "t" });
  await until(() => releaseRead, Boolean);
  await assert.rejects(adapter.call("requests.respond", response), {
    code: "thread_busy",
  });
  assert.equal(calls.filter((p) => p.id === "question" && !p.method).length, 0);
  assert.equal(
    ((await adapter.call("requests.list", {})).result as any).items.length,
    1,
  );
  releaseRead!();
  await assert.rejects(guardedRelease, { code: "thread_busy" });
  holdRead = false;
  releaseRead = undefined;
  await adapter.call("requests.respond", response);
  await adapter.call("model/list", {});
  assert.equal(calls.filter((p) => p.id === "question" && !p.method).length, 1);
  await assert.rejects(adapter.call("requests.respond", response), {
    code: "interaction_not_found",
  });
  peer!.send(
    JSON.stringify({
      method: "serverRequest/resolved",
      params: { threadId: "t", requestId: "question" },
    }),
  );
  await adapter.call("model/list", {});
  holdRead = true;
  const release = adapter.call("thread/unsubscribe", { threadId: "t" });
  await until(() => releaseRead, Boolean);
  await assert.rejects(
    adapter.call("turn/start", {
      threadId: "t",
      input: [{ type: "text", text: "fixture" }],
    }),
    { code: "thread_busy" },
  );
  releaseRead!();
  holdRead = false;
  assert.deepEqual((await release).result, { status: "unsubscribed" });
  await assert.rejects(
    adapter.call("turn/start", {
      threadId: "t",
      input: [{ type: "text", text: "must resume first" }],
    }),
    { code: "thread_not_subscribed" },
  );
  const resumes = () =>
    calls.filter((p) => p.method === "thread/resume").length;
  const count = resumes();
  // Exercise the old discovery interval and transport recovery with the native
  // thread deliberately still loaded (the real server has an inactivity grace).
  await new Promise((r) => setTimeout(r, 3200));
  peer!.terminate();
  await until(
    () => adapter.available,
    (v) => !v,
  );
  await until(() => adapter.available, Boolean);
  await adapter.call("model/list", {});
  assert.equal(resumes(), count);
  await adapter.call("thread/resume", { threadId: "t" });
  assert.equal(
    resumes(),
    count + 1,
    "explicit remote continuation remains possible",
  );
  await adapter.call("turn/start", {
    threadId: "t",
    input: [{ type: "text", text: "continue" }],
  });
  dropUnsubscribe = true;
  await assert.rejects(adapter.call("thread/unsubscribe", { threadId: "t" }), {
    code: "execution_unknown",
  });
  await until(() => adapter.available, Boolean);
  await adapter.call("model/list", {});
  assert.equal(
    resumes(),
    count + 1,
    "lost unsubscribe acknowledgement cannot reacquire ownership",
  );
  await adapter.close();
  adapter = new CodexAdapter(config);
  await adapter.init();
  adapter.watchEvents(() => {});
  await adapter.call("thread/loaded/list", {});
  assert.equal(
    resumes(),
    count + 1,
    "fresh connector does not acquire loaded threads",
  );
});
