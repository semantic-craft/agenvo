import { randomUUID } from "node:crypto";
import { Fault, LIMITS, bytes, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import type { Adapter, Method } from "@agenvo/connector/adapters/adapter";
import {
  authorization,
  defaultSource,
  fullAccess,
  type DispatchConfig,
} from "./config.js";

const JOB = /^[0-9a-f]{16}$/;
const TAG = /^\s*\[Project: ([^\]\n]+)\]/;
const POLL_MS = 5000;
const HEALTH_MS = 15000;
const app = "ZCode desktop";

function methodsFor(): Method[] {
  const name = app;
  const permission = {
    mode: {
      type: "string",
      enum: ["plan", "edit", "build", "guarded", "yolo"],
      description: "Native ZCode session mode. Default yolo (no approvals).",
    },
    model: {
      type: "string",
      description:
        "Native ZCode model id, e.g. account:bigmodel-individual-coding-plan/GLM-5.3. Default is the receiver's dispatch model.",
    },
  };
  return [
    {
      name: "health",
      readOnly: true,
      description: `Read ${name} dispatch receiver health: whether it accepts work, running job count, runner and configuration checks. Healthy does not mean the desktop app is idle.`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "jobs.create",
      readOnly: false,
      description: `Create a work context and submit input: starts a new visible ${name} session (left sidebar) in ~/Projects/<project> on this computer, with full access by default, and queues text as its first prompt. Strict: when the desktop app is not running or does not take the job, the call or the job fails explicitly; it never falls back to a hidden headless run. The text is prefixed with "[Project: <project>]" when missing. Returns the native job id at once (HTTP 202); acceptance is not task completion. Read output with jobs.get, or subscribe to runtime.changed for job.finished. The user can continue the same session by hand in the desktop app; there is no remote follow-up input.`,
      inputSchema: {
        type: "object",
        required: ["project", "text"],
        additionalProperties: false,
        properties: {
          project: {
            type: "string",
            description: "Folder name directly under ~/Projects, e.g. koe.",
          },
          text: { type: "string", minLength: 1, description: "Task prompt." },
          timeout_seconds: {
            type: "integer",
            minimum: 10,
            description: "Native job timeout. Default is the receiver's.",
          },
          ...permission,
        },
      },
    },
    {
      name: "jobs.get",
      readOnly: true,
      description: `Read output and state of one ${name} job by native job id: running, completed or failed, runner (the path that actually ran it; "app" = visible desktop session), the session id, exit code, final assistant text (result) and error. A completed native turn does not establish that the business goal is met. Long results are truncated; open the session in the desktop app for the full transcript.`,
      inputSchema: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: { id: { type: "string", pattern: JOB.source } },
      },
    },
  ];
}

export class DispatchAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;
  private stopped = false;
  private headers: Record<string, string> = {};
  private generation = randomUUID();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private tracked = new Map<string, string>();
  private poll?: NodeJS.Timeout;
  private health?: NodeJS.Timeout;
  private readonly list: Method[];

  constructor(readonly config: DispatchConfig) {
    this.list = methodsFor();
  }
  methods() {
    return this.list;
  }
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }
  private emit(
    type: string,
    native: Record<string, unknown>,
    threadId?: string,
  ) {
    const event: RuntimeEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: this.config.id,
      generation: this.generation,
      nativeType: type,
      native,
      ...(threadId ? { threadId } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }
  private async request(verb: string, path: string, body?: unknown) {
    if (this.stopped) throw new Fault("runtime_unavailable");
    try {
      const response = await fetch(
        this.config.endpoint.replace(/\/$/, "") + path,
        {
          method: verb,
          headers: { ...this.headers, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        },
      );
      const text = await response.text();
      let value: unknown = text;
      try {
        value = text ? JSON.parse(text) : null;
      } catch {}
      if (!response.ok) {
        const reason =
          typeof (value as any)?.error === "string"
            ? `: ${(value as any).error}`
            : "";
        // 503 is the receivers' explicit refusal before any job exists (desktop app unavailable).
        throw new Fault(
          "native_error",
          `${app} receiver HTTP ${response.status}${reason}`,
          response.status >= 500 && response.status !== 503
            ? "unknown"
            : "rejected",
          { status: response.status, body: value },
        );
      }
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Fault) throw error;
      // A lost response cannot prove that a dispatched job did not start.
      throw new Fault(
        "native_transport_error",
        "Receiver response unavailable; inspect native state before retrying",
        verb === "GET" ? "not_started" : "unknown",
      );
    }
  }
  async call(name: string, params: Record<string, unknown>): Promise<Outcome> {
    if (!this.list.some((m) => m.name === name))
      throw new Fault("unknown_method", name);
    if (this.stopped) throw new Fault("runtime_unavailable");
    try {
      if (name === "health")
        return {
          execution: "accepted",
          result: await this.request("GET", "/health"),
        };
      if (name === "jobs.get") {
        const id = String(params.id ?? "");
        if (!JOB.test(id))
          throw new Fault(
            "invalid_params",
            "id must be 16 lowercase hex chars",
          );
        const job = await this.request("GET", `/v1/jobs/${id}`);
        return fit({
          execution: "accepted",
          result: job,
          nativeIds: { jobId: id },
        });
      }
      const body = this.jobBody(params);
      const job = await this.request("POST", "/v1/jobs", body);
      const id = String(job?.id ?? "");
      if (JOB.test(id)) {
        this.tracked.set(id, String(job.state ?? "running"));
        this.emit(
          "job.started",
          { id, project: body.project, state: job.state, runner: job.runner },
          id,
        );
      }
      return {
        execution: "accepted",
        result: job,
        ...(id ? { nativeIds: { jobId: id } } : {}),
      };
    } catch (error) {
      if (error instanceof Fault) return error.outcome();
      throw error;
    }
  }
  private jobBody(params: Record<string, unknown>) {
    const { project, text, ...rest } = params as Record<string, any>;
    if (
      typeof project !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)
    )
      throw new Fault(
        "invalid_params",
        "project must be a folder name under ~/Projects",
      );
    if (typeof text !== "string" || !text.trim())
      throw new Fault("invalid_params", "text is required");
    const tag = TAG.exec(text);
    if (tag && tag[1] !== project)
      throw new Fault(
        "invalid_params",
        `text is tagged for project ${tag[1]}, not ${project}`,
      );
    return {
      ...rest,
      project,
      text: tag ? text : `[Project: ${project}] ${text}`,
      source: this.config.source ?? defaultSource,
      mode: rest.mode ?? fullAccess,
      // Visible desktop session or explicit failure; receivers never fall back to headless for "app".
      runner: "app",
    };
  }
  async init() {
    this.headers = await authorization(this.config);
    this.health = setInterval(
      () => void this.checkHealth().catch(() => {}),
      HEALTH_MS,
    );
    this.poll = setInterval(() => void this.pollJobs(), POLL_MS);
    await this.checkHealth();
  }
  private async checkHealth() {
    let ok = false;
    try {
      const health = await this.request("GET", "/health");
      ok = health?.ok === true;
      this.version = String(health?.runner ?? "unknown");
    } catch {}
    if (ok !== this.available) {
      this.available = ok;
      this.onAvailabilityChange?.();
      if (ok)
        this.emit("agenvo.resync_required", {
          reason: "native_connected",
          replay: false,
        });
    }
    if (!ok)
      throw new Fault("runtime_unavailable", "Receiver health check failed");
  }
  private async pollJobs() {
    for (const [id, state] of this.tracked) {
      let job: Record<string, unknown>;
      try {
        job = await this.request("GET", `/v1/jobs/${id}`);
      } catch {
        continue;
      }
      const next = String(job.state ?? state);
      if (next === state) continue;
      if (next === "running" || next === "queued") {
        this.tracked.set(id, next);
        continue;
      }
      this.tracked.delete(id);
      this.emit(
        "job.finished",
        {
          id,
          state: next,
          project: job.project,
          runner: job.runner,
          session_id: job.session_id,
          exit_code: job.exit_code,
          error:
            typeof job.error === "string" ? job.error.slice(0, 500) : job.error,
        },
        id,
      );
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.poll);
    clearInterval(this.health);
  }
}

// Keep the native job but shorten the final text so the frame stays under the relay limit.
function fit(outcome: Outcome): Outcome {
  if (bytes(outcome) < LIMITS.frame - 2048) return outcome;
  const job = { ...(outcome.result as Record<string, unknown>) };
  const text = typeof job.result === "string" ? job.result : "";
  const keep = Math.max(
    0,
    text.length - (bytes(outcome) - (LIMITS.frame - 4096)),
  );
  job.result = "…" + text.slice(text.length - keep);
  job.result_truncated = true;
  return { ...outcome, result: job };
}
