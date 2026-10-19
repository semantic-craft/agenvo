import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";

export const executionPolicy = {
  execution: "native-session-full-access",
  approvalPolicy: "dispatch-full-access",
};
// Native ZCode mode for full access, the instance default.
export const fullAccess = "yolo";
// Source the receiver accepts that never falls back to Grok reporting.
export const defaultSource = "local";

export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("zcode"),
  endpoint: z.url().refine((value) => {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }, "Use an HTTP(S) receiver URL without credentials, query parameters or fragment"),
  keyFile: absolutePath,
  source: z.string().min(1).max(32).optional(),
});
export type DispatchConfig = z.infer<typeof instanceConfigSchema>;

export async function authorization(
  config: DispatchConfig,
): Promise<Record<string, string>> {
  const info = await stat(config.keyFile);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Fault(
      "insecure_credentials",
      "Receiver key file must have mode 0600",
    );
  const key = (await readFile(config.keyFile, "utf8")).trim();
  return { Authorization: "Bearer " + key };
}
