import test from "node:test";
import assert from "node:assert/strict";
import { Interactions } from "../apps/codex-app-server/src/interactions.js";

function fixture(
  questions = [{ id: "q", header: "Question", question: "Your answer?" }],
) {
  let generation = "one",
    fail = false;
  const sent: any[] = [];
  const interactions = new Interactions(
    () => generation,
    (p) => {
      sent.push(p);
      if (fail) throw Error("disconnected after write");
    },
    () => {},
  );
  const packet = {
    id: "native",
    method: "item/tool/requestUserInput",
    params: { threadId: "t", turnId: "turn", itemId: "item", questions },
  };
  const receive = () => interactions.receive(packet);
  const list = () =>
    (interactions.call("requests.list", {}).result as any).items;
  const answer = (
    interactionId: string,
    response: unknown = { answers: { q: { answers: ["Explicit answer"] } } },
  ) => interactions.call("requests.respond", { interactionId, response });
  receive();
  return {
    interactions,
    sent,
    receive,
    list,
    answer,
    generation: () => {
      generation = "two";
    },
    fail: () => {
      fail = true;
    },
  };
}

test("response uses original native id and schema, submits once without claiming completion", () => {
  const f = fixture(),
    id = f.list()[0].interactionId;
  assert.throws(() => f.answer(id, {}), { code: "invalid_params" });
  assert.equal(f.sent.length, 0);
  assert.equal(f.list().length, 1);
  assert.equal((f.answer(id).result as any).submitted, true);
  assert.deepEqual(f.sent, [
    {
      jsonrpc: "2.0",
      id: "native",
      result: { answers: { q: { answers: ["Explicit answer"] } } },
    },
  ]);
  assert.equal(f.list().length, 0);
  assert.throws(() => f.answer(id), { code: "interaction_not_found" });
  assert.equal(f.sent.length, 1);
});

test("unknown, generation-stale and resolved requests reject without sending", () => {
  const f = fixture(),
    id = f.list()[0].interactionId;
  assert.throws(() => f.answer("missing"), { code: "interaction_not_found" });
  f.generation();
  assert.throws(() => f.answer(id), { code: "interaction_not_found" });
  assert.equal(f.sent.length, 0);
  const g = fixture(),
    resolved = g.list()[0].interactionId;
  g.interactions.receive({
    method: "serverRequest/resolved",
    params: { threadId: "t", requestId: "native" },
  });
  assert.throws(() => g.answer(resolved), { code: "interaction_not_found" });
  assert.equal(g.sent.length, 0);
});

test("uncertain transport send retains unknown status and cannot be replayed", () => {
  const f = fixture(),
    id = f.list()[0].interactionId;
  f.fail();
  assert.throws(() => f.answer(id), { code: "execution_unknown" });
  assert.equal(f.list()[0].responseStatus, "unknown");
  f.receive();
  assert.equal(f.list()[0].interactionId, id);
  assert.throws(() => f.answer(id), { code: "execution_unknown" });
  assert.equal(f.sent.length, 1);
  f.interactions.reset();
  assert.throws(() => f.answer(id), { code: "interaction_not_found" });
});

test("dynamic tool responses validate against their own native response contract", () => {
  const f = fixture();
  f.interactions.receive({
    id: 7,
    method: "item/tool/call",
    params: { threadId: "t", callId: "tool" },
  });
  const id = f.list().find((i: any) => i.nativeId === 7).interactionId;
  assert.throws(() => f.answer(id, { answers: {} }), {
    code: "invalid_params",
  });
  f.answer(id, {
    contentItems: [{ type: "inputText", text: "Explicit tool result" }],
    success: true,
  });
  assert.equal(f.sent[0].id, 7);
  assert.equal(f.list().length, 1);
});

test("question answer keys are complete and exact; invalid maps do not consume or send", () => {
  const f = fixture([
    { id: "first", header: "First", question: "First?" },
    { id: "second", header: "Second", question: "Second?" },
  ]);
  const id = f.list()[0].interactionId;
  for (const answers of [
    {},
    { first: { answers: ["A"] } },
    { wrong: { answers: ["A"] }, second: { answers: ["B"] } },
    {
      first: { answers: ["A"] },
      second: { answers: ["B"] },
      extra: { answers: ["C"] },
    },
  ]) {
    assert.throws(() => f.answer(id, { answers }), { code: "invalid_params" });
    assert.equal(f.sent.length, 0);
    assert.equal(f.list()[0].interactionId, id);
    assert.equal(f.list()[0].responseStatus, undefined);
  }
  const answers = { second: { answers: [] }, first: { answers: ["A"] } };
  f.answer(id, { answers });
  assert.deepEqual(f.sent[0].result, { answers });
  assert.equal(f.list().length, 0);
});

test("an empty question set permits only an empty answer map", () => {
  const f = fixture([]),
    id = f.list()[0].interactionId;
  assert.throws(() => f.answer(id, { answers: { extra: { answers: [] } } }), {
    code: "invalid_params",
  });
  assert.equal(f.sent.length, 0);
  f.answer(id, { answers: {} });
  assert.equal(f.sent.length, 1);
});

test("ambiguous or missing question IDs fail closed without consuming the request", () => {
  for (const questions of [
    [
      { id: "q", header: "Q", question: "One?" },
      { id: "q", header: "Q", question: "Two?" },
    ],
    [{ header: "Q", question: "Missing ID?" }],
  ]) {
    const f = fixture(questions as any),
      id = f.list()[0].interactionId;
    assert.throws(() => f.answer(id), { code: "invalid_params" });
    assert.equal(f.sent.length, 0);
    assert.equal(f.list()[0].interactionId, id);
    assert.equal(f.list()[0].responseStatus, undefined);
  }
});
