import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./http";
import { PROVIDERS, type SearchProviderId } from "./types";

export interface SearchConfig {
  providers?: SearchProviderId[];
  exclude?: SearchProviderId[];
  timeoutSeconds?: number;
  models?: Partial<Record<SearchProviderId, string>>;
}
function providerList(value: unknown, field: string): SearchProviderId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !(PROVIDERS as readonly string[]).includes(id))) throw new Error(`web-search.json: invalid ${field}`);
  return [...new Set(value)] as SearchProviderId[];
}
export function validateConfig(value: unknown): SearchConfig {
  if (!isRecord(value)) throw new Error("web-search.json must contain an object");
  for (const field of Object.keys(value)) if (!["providers", "exclude", "timeoutSeconds", "models"].includes(field)) throw new Error(`web-search.json: unknown field ${field}`);
  const providers = providerList(value.providers, "providers"), exclude = providerList(value.exclude, "exclude");
  if (value.timeoutSeconds !== undefined && (typeof value.timeoutSeconds !== "number" || !Number.isFinite(value.timeoutSeconds) || value.timeoutSeconds <= 0)) throw new Error("web-search.json: timeoutSeconds must be positive");
  const models: SearchConfig["models"] = {};
  if (value.models !== undefined) {
    if (!isRecord(value.models)) throw new Error("web-search.json: models must be an object");
    for (const [id, model] of Object.entries(value.models)) {
      if (!(PROVIDERS as readonly string[]).includes(id) || typeof model !== "string" || !model.trim()) throw new Error("web-search.json: invalid provider model");
      models[id as SearchProviderId] = model.trim();
    }
  }
  return { ...(providers ? { providers } : {}), ...(exclude ? { exclude } : {}), ...(value.timeoutSeconds !== undefined ? { timeoutSeconds: Math.min(value.timeoutSeconds as number, 300) } : {}), ...(value.models !== undefined ? { models } : {}) };
}
/** Global config plus trusted project overrides. Never load executable JS. */
export async function loadConfig(cwd?: string, projectTrusted = false): Promise<SearchConfig> {
  const global = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "web-search.json");
  const paths = [global, ...(cwd && projectTrusted ? [join(cwd, ".pi", "web-search.json")] : [])];
  let result: SearchConfig = {};
  for (const path of paths) {
    let raw: string;
    try { raw = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error(`Cannot read ${path}`); }
    if (Buffer.byteLength(raw) > 65536) throw new Error(`Config too large: ${path}`);
    let config: SearchConfig;
    try { config = validateConfig(JSON.parse(raw)); } catch (error) { throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`); }
    result = { ...result, ...config, models: { ...result.models, ...config.models } };
  }
  return result;
}
