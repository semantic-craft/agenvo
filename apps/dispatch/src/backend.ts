import { resolve } from "node:path";
import { Fault } from "@agenvo/protocol";
import type { Backend } from "@agenvo/connector/backend";
import {
  instanceConfigSchema,
  executionPolicy,
  type DispatchConfig,
} from "./config.js";
import { DispatchAdapter } from "./dispatch.js";

export const backend: Backend<DispatchConfig> = {
  name: "dispatch",
  command: "agenvo-dispatch",
  schema: instanceConfigSchema,
  executionPolicy,
  options: ["endpoint", "key-file", "source"],
  help: "--endpoint http://HOST:7791 --key-file PATH [--source NAME] (attach to a running zcode-dispatch receiver)",
  revision: () => "dispatch-v1-native",
  async configure(options) {
    if (options.binary || options.cwd)
      throw new Fault(
        "invalid_arguments",
        "Dispatch attachment uses an endpoint and key file",
      );
    const config = instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "zcode",
      endpoint: options.endpoint,
      keyFile: options["key-file"]
        ? resolve(String(options["key-file"]))
        : undefined,
      ...(options.source ? { source: options.source } : {}),
    });
    const adapter = new DispatchAdapter(config);
    try {
      await adapter.init();
      return config;
    } finally {
      await adapter.close();
    }
  },
  async create(config) {
    const adapter = new DispatchAdapter(config);
    try {
      await adapter.init();
    } catch {
      /* Availability recovers with the next health check. */
    }
    return adapter;
  },
  async doctor(config) {
    const adapter = new DispatchAdapter(config);
    try {
      await adapter.init();
      return [
        {
          check: config.id + ":receiver",
          ok: true,
          detail: `runner ${adapter.version}`,
        },
      ];
    } catch (error) {
      return [
        {
          check: config.id + ":receiver",
          ok: false,
          detail:
            "Check the receiver endpoint, key file (0600) and the receiver's allowedIps",
        },
      ];
    } finally {
      await adapter.close();
    }
  },
};
