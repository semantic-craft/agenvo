import { randomUUID } from "node:crypto";
import { z } from "zod";
import { bytes, Fault, LIMITS, page, type Outcome } from "@agenvo/protocol";
import { accepted, type Method } from "@agenvo/connector/adapters/adapter";
import { automaticApproval } from "./codex-execution.js";
import { responseValidators, validate } from "./native-schema.js";
import schemas from "./schema/codex.json";
import type { NativePacket } from "./connection.js";
type Interaction = {
  interactionId: string;
  nativeId: string | number;
  generation: string;
  responseStatus?: "unknown";
  method: string;
  params: Record<string, any>;
};
const listInput = z.strictObject({
  cursor: z.string().optional(),
  threadId: z.string().optional(),
});
const respondInput = z.strictObject({
  interactionId: z.string(),
  response: z.unknown(),
});
export const interactionMethods: Method[] = [
  {
    name: "requests.list",
    readOnly: true,
    description:
      "List pending requests for user input and dynamic tool calls received on this connection. Reply explicitly with requests.respond using the returned responseSchema; permission approvals are answered automatically.",
    inputSchema: z.toJSONSchema(listInput),
  },
  {
    name: "requests.respond",
    readOnly: false,
    description:
      "Submit an explicit response to a current pending native user question or dynamic tool call. Validate against requests.list responseSchema. A submitted response is not confirmation of native completion; never retry an unknown send.",
    inputSchema: z.toJSONSchema(respondInput),
  },
];
/** Pending native requests belong to one connection generation. */
export class Interactions {
  private interactions = new Map<string, Interaction>();
  private interactionBytes = 0;
  constructor(
    private generation: () => string,
    private write: (packet: unknown) => void,
    private record: (
      threadId: unknown,
      type: string,
      data: Record<string, unknown>,
    ) => void,
  ) {}
  reset() {
    this.interactions.clear();
    this.interactionBytes = 0;
  }
  hasPending(threadId: string) {
    return [...this.interactions.values()].some(
      (request) => request.params.threadId === threadId,
    );
  }
  receive(packet: NativePacket) {
    if (!packet.method) return;
    if (packet.method === "item/completed") {
      // Some native request types have no serverRequest/resolved broadcast.
      // Item completion is also authoritative, including another client's answer.
      for (const [id, r] of this.interactions)
        if (
          r.params.threadId === packet.params?.threadId &&
          r.params.turnId === packet.params?.turnId &&
          (r.params.itemId === packet.params?.item?.id ||
            r.params.callId === packet.params?.item?.id)
        )
          this.interactions.delete(id);
      this.recount();
    }
    if (packet.method === "serverRequest/resolved") {
      for (const [id, r] of this.interactions)
        if (
          r.nativeId === packet.params?.requestId &&
          r.params.threadId === packet.params?.threadId
        )
          this.interactions.delete(id);
      this.recount();
    } else if (packet.method && packet.id !== undefined) {
      try {
        const result = automaticApproval(packet.method, packet.params ?? {});
        if (result) {
          validate(responseValidators.get(packet.method)!, result);
          this.write({ jsonrpc: "2.0", id: packet.id, result });
          this.record(packet.params?.threadId, "permission.submitted", {
            method: packet.method,
            threadId: packet.params?.threadId,
            automatic: true,
          });
          return;
        }
      } catch (error) {
        this.write({
          jsonrpc: "2.0",
          id: packet.id,
          error: {
            code: -32000,
            message: "Native approval could not be answered automatically",
          },
        });
        this.record(packet.params?.threadId, "permission.failed", {
          method: packet.method,
          threadId: packet.params?.threadId,
        });
        return;
      }
      // Another native client can handle requests this connector does not expose.
      if (!responseValidators.has(packet.method)) return;
      // A repeated request on this connection must not reopen an uncertain send.
      if (
        [...this.interactions.values()].some(
          (r) => r.nativeId === packet.id && r.generation === this.generation(),
        )
      )
        return;
      for (const [id, r] of this.interactions)
        if (r.nativeId === packet.id) this.interactions.delete(id);
      this.recount();
      const generation = this.generation();
      const interactionId = generation + ":" + randomUUID();
      const interaction: Interaction = {
        interactionId,
        generation,
        nativeId: packet.id,
        method: packet.method,
        params: packet.params ?? {},
      };
      const size = bytes(interaction);
      if (
        bytes({
          ...interaction,
          responseSchema:
            schemas.responses[packet.method as keyof typeof schemas.responses],
        }) >
          LIMITS.frame - 4096 ||
        this.interactionBytes + size > LIMITS.parse
      ) {
        return;
      }
      this.interactions.set(interactionId, interaction);
      this.record(packet.params?.threadId, "interaction.pending", {
        interactionId,
        method: packet.method,
        threadId: packet.params?.threadId,
      });
      this.recount();
    } else if (["thread/closed", "thread/archived"].includes(packet.method)) {
      const threadId = packet.params?.threadId;
      for (const [id, r] of this.interactions)
        if (r.params.threadId === threadId) this.interactions.delete(id);
      this.recount();
    } else if (packet.method === "turn/completed") {
      for (const [id, r] of this.interactions)
        if (
          r.params.threadId === packet.params?.threadId &&
          r.params.turnId === packet.params?.turn?.id
        )
          this.interactions.delete(id);
      this.recount();
    }
  }
  private recount() {
    this.interactionBytes = [...this.interactions.values()].reduce(
      (n, i) => n + bytes(i),
      0,
    );
  }
  call(method: string, original: Record<string, unknown>): Outcome {
    if (method === "requests.list") {
      const p = listInput.parse(original);
      return accepted(
        page(
          [...this.interactions.values()]
            .filter((i) => !p.threadId || i.params.threadId === p.threadId)
            .map((i) => ({
              ...i,
              responseSchema:
                schemas.responses[i.method as keyof typeof schemas.responses],
            })),
          p.cursor,
        ),
      );
    }
    if (method === "requests.respond") {
      const p = respondInput.parse(original);
      const request = this.interactions.get(p.interactionId);
      if (!request || request.generation !== this.generation())
        throw new Fault(
          "interaction_not_found",
          "Pending request expired or belongs to another connection",
          "rejected",
        );
      if (request.responseStatus === "unknown")
        throw new Fault(
          "execution_unknown",
          "Previous response send is unknown; inspect native state instead of retrying",
          "unknown",
        );
      const validator = responseValidators.get(request.method);
      if (!validator) throw new Fault("unsupported_method");
      validate(validator, p.response);
      // Mark before writing: a transport error can occur after bytes were accepted.
      request.responseStatus = "unknown";
      this.recount();
      try {
        this.write({
          jsonrpc: "2.0",
          id: request.nativeId,
          result: p.response,
        });
      } catch {
        throw new Fault(
          "execution_unknown",
          "Native response send could not be confirmed; do not replay",
          "unknown",
        );
      }
      this.interactions.delete(p.interactionId);
      this.recount();
      this.record(request.params.threadId, "interaction.submitted", {
        interactionId: p.interactionId,
        method: request.method,
        threadId: request.params.threadId,
      });
      return accepted({ interactionId: p.interactionId, submitted: true });
    }
    throw new Fault("unsupported_method");
  }
}
