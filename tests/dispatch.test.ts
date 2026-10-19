import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchAdapter } from "../apps/dispatch/src/dispatch.js";
import { instanceConfigSchema } from "../apps/dispatch/src/config.js";
import { until } from "./support/environment.js";

// Same HTTP contract as the zcode-dispatch receiver.
async function receiver(key: string, appUp = () => true) {
  const jobs = new Map<string, any>();
  const bodies: any[] = [];
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return send(200, { ok: true, runner: "app" });
    if (req.headers.authorization !== "Bearer " + key)
      return send(401, { error: "unauthorized" });
    if (req.method === "POST" && req.url === "/v1/jobs") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      bodies.push(body);
      // Strict runner: no desktop app -> 503 before any job exists.
      if (body.runner === "app" && !appUp())
        return send(503, { error: "desktop app session services unavailable" });
      const id = "0123456789abcdef";
      jobs.set(id, {
        id,
        project: body.project,
        state: "running",
        runner: "app",
      });
      return send(202, jobs.get(id));
    }
    const m = /^\/v1\/jobs\/([0-9a-f]{16})$/.exec(req.url ?? "");
    if (m && jobs.has(m[1])) return send(200, jobs.get(m[1]));
    send(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    jobs,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("dispatch connector submits full-access tagged jobs and reports job.finished", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agenvo-dispatch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = "k".repeat(64);
  await writeFile(join(dir, "key"), key, { mode: 0o600 });
  const native = await receiver(key);
  t.after(native.close);
  for (const [kind, permission, value, source] of [
    ["zcode", "mode", "yolo", "local"],
  ] as const) {
    const adapter = new DispatchAdapter(
      instanceConfigSchema.parse({
        id: kind,
        label: kind,
        kind,
        endpoint: native.endpoint,
        keyFile: join(dir, "key"),
      }),
    );
    t.after(() => adapter.close());
    const events: any[] = [];
    adapter.watchEvents((e) => events.push(e));
    await adapter.init();
    assert.equal(adapter.available, true);
    const created: any = await adapter.call("jobs.create", {
      project: "koe",
      text: "list files",
    });
    assert.equal(created.execution, "accepted");
    assert.equal(created.nativeIds.jobId, "0123456789abcdef");
    const body = native.bodies.at(-1);
    assert.equal(body.text, "[Project: koe] list files");
    assert.equal(body[permission], value);
    assert.equal(body.source, source);
    assert.equal(body.runner, "app");
    const got: any = await adapter.call("jobs.get", { id: "0123456789abcdef" });
    assert.equal(got.result.runner, "app");
    const mismatch: any = await adapter.call("jobs.create", {
      project: "koe",
      text: "[Project: sonori] x",
    });
    assert.equal(mismatch.error.code, "invalid_params");
    native.jobs.get("0123456789abcdef").state = "completed";
    await until(
      () => events.some((e) => e.nativeType === "job.finished"),
      Boolean,
      8000,
    );
    const finished = events.find((e) => e.nativeType === "job.finished");
    assert.equal(finished.threadId, "0123456789abcdef");
    assert.equal(finished.native.state, "completed");
    assert.equal(finished.native.runner, "app");
  }
});

test("dispatch connector surfaces the receiver's strict-runner refusal as an explicit failure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agenvo-dispatch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = "k".repeat(64);
  await writeFile(join(dir, "key"), key, { mode: 0o600 });
  const native = await receiver(key, () => false);
  t.after(native.close);
  const adapter = new DispatchAdapter(
    instanceConfigSchema.parse({
      id: "zcode",
      label: "zcode",
      kind: "zcode",
      endpoint: native.endpoint,
      keyFile: join(dir, "key"),
    }),
  );
  t.after(() => adapter.close());
  await adapter.init();
  const refused: any = await adapter.call("jobs.create", {
    project: "koe",
    text: "list files",
    runner: "headless",
  });
  assert.equal(native.bodies.at(-1).runner, "app");
  assert.equal(refused.execution, "rejected");
  assert.equal(refused.error.code, "native_error");
  assert.match(
    refused.error.message,
    /HTTP 503: desktop app session services unavailable/,
  );
  assert.equal(native.jobs.size, 0);
});
