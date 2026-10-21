import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { binary as executable } from "@agenvo/connector/cli/binary";
import { codexServer } from "../support/codex-server.js";
import { modelServer } from "../support/model-server.js";
import { socketTempDir, until } from "../support/environment.js";
import { CodexAdapter } from "../../apps/codex-app-server/src/codex.js";
import { CodexConnection } from "../../apps/codex-app-server/src/connection.js";

test(
  "native unsubscribe is not immediate cross-server handoff; same-server continuation preserves history",
  { timeout: 30000 },
  async (t) => {
    const home = await realpath(
      await mkdtemp(join(socketTempDir(), "agenvo-handoff-native-")),
    );
    const services: Awaited<ReturnType<typeof codexServer>>[] = [];
    const clients: CodexConnection[] = [];
    let adapter: CodexAdapter | undefined;
    let replyCount = 0;
    const model = await modelServer(() => `HANDOFF_RESULT_${++replyCount}`);
    t.after(async () => {
      for (const c of clients) c.close();
      await adapter?.close();
      for (const s of services) await s.close();
      await model.close();
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    const binary = await executable("codex", {});
    for (let i = 0; i < 2; i++) services.push(await codexServer(home, binary));
    const config = {
      id: "fixture",
      kind: "codex" as const,
      label: "fixture",
      home,
      cwd: home,
      endpoint: services[0].endpoint,
    };
    adapter = new CodexAdapter(config);
    await adapter.init();
    assert.match(
      adapter.version,
      /\b0\.163\.0\b/,
      "This explicit compatibility regression requires Codex 0.163.0 on PATH",
    );
    const call = async (method: string, params = {}) =>
      (await adapter!.call(method, params)).result as any;
    const created = await call("thread/start", {
      model: "fixture",
      modelProvider: "fixture",
      historyMode: "paginated",
      config: model.config,
    });
    const threadId = created.thread.id;
    model.hold();
    const sent = await call("turn/start", {
      threadId,
      input: [{ type: "text", text: "Return the isolated fixture result." }],
    });
    await until(
      () => model.requests.length,
      (n) => n === 1,
    );
    await assert.rejects(call("thread/unsubscribe", { threadId }), {
      code: "thread_busy",
    });
    assert.equal(
      (await call("thread/read", { threadId })).thread.status.type,
      "active",
    );
    model.release();
    await until(
      () => call("thread/read", { threadId }),
      (r) => r.thread.status.type === "idle",
    );
    assert.deepEqual(await call("thread/unsubscribe", { threadId }), {
      status: "unsubscribed",
    });
    assert.ok((await call("thread/loaded/list")).data.includes(threadId));
    for (const index of [1, 0]) {
      const c = new CodexConnection(
        { ...config, endpoint: services[index].endpoint },
        () => {},
        () => {},
      );
      clients.push(c);
      await c.open();
      await c.rpc("initialize", {
        clientInfo: { name: "handoff-fixture", version: "1" },
        capabilities: { experimentalApi: true },
      });
      c.write({ method: "initialized" });
    }
    await assert.rejects(
      clients[0].rpc("thread/resume", { threadId, config: model.config }),
      (e: any) => {
        assert.equal(e.code, "native_error");
        assert.match(e.native?.message ?? "", /already has an active writer/);
        t.diagnostic(`cross-server resume rejected: ${e.native.message}`);
        return true;
      },
    );
    const same: any = await clients[1].rpc("thread/resume", {
      threadId,
      config: model.config,
    });
    assert.equal(same.thread.id, threadId);
    await clients[1].rpc("thread/unsubscribe", { threadId });
    await call("thread/resume", { threadId, config: model.config });
    const second = await call("turn/start", {
      threadId,
      input: [{ type: "text", text: "Return the second fixture result." }],
    });
    const history = await until(
      () =>
        call("thread/turns/list", {
          threadId,
          itemsView: "summary",
          limit: 10,
        }),
      (r) =>
        r.data.some(
          (turn: any) =>
            turn.id === second.turn.id && turn.status === "completed",
        ),
    );
    assert.equal(model.requests.length, 2, "no replayed input");
    assert.ok(
      history.data.some(
        (turn: any) => turn.id === sent.turn.id && turn.status === "completed",
      ),
    );
    assert.match(JSON.stringify(history), /HANDOFF_RESULT_1/);
    assert.match(JSON.stringify(history), /HANDOFF_RESULT_2/);
    t.diagnostic(
      `native ${adapter.version}: running guard, idle unsubscribe, loaded grace, same-server resume and two mock turns verified`,
    );
  },
);
