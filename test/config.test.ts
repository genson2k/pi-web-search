import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig, validateConfig } from "../src/config";
import { createAuthStorage } from "../src/auth";
import { runSearchQuery } from "../src/search";
afterEach(() => vi.unstubAllEnvs());
it("loads project config only after trust and merges model settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-search-config-test-"));
  try {
    const global = join(directory, "agent"), project = join(directory, "project");
    await mkdir(global); await mkdir(join(project, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", global);
    await writeFile(join(global, "web-search.json"), JSON.stringify({ providers: ["exa"], models: { gemini: "model-a" } }));
    await writeFile(join(project, ".pi", "web-search.json"), JSON.stringify({ providers: ["perplexity"], models: { codex: "model-b" } }));
    expect((await loadConfig(project, false)).providers).toEqual(["exa"]);
    const trusted = await loadConfig(project, true);
    expect(trusted.providers).toEqual(["perplexity"]);
    expect(trusted.models).toEqual({ gemini: "model-a", codex: "model-b" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("rejects invalid config and clamps timeout", () => {
  expect(() => validateConfig({ providers: ["typo"] })).toThrow();
  expect(() => validateConfig({ apiKey: "not-allowed" })).toThrow();
  expect(validateConfig({ timeoutSeconds: 1000 }).timeoutSeconds).toBe(300);
});
it("excludes providers even when pinned and forwards configured model", async () => {
  let calls = 0;
  await expect(runSearchQuery({ query: "x", provider: "exa" }, { exclude: ["exa"], fetch: async () => { calls++; throw new Error("unexpected"); } })).rejects.toThrow("No web search");
  expect(calls).toBe(0);
  const authStorage = createAuthStorage({ env: { OPENROUTER_API_KEY: "test" } });
  await runSearchQuery({ query: "x", provider: "openrouter" }, { models: { openrouter: "test/model" }, authStorage, fetch: async (_input, init) => {
    expect(JSON.parse(String(init?.body)).model).toBe("test/model");
    return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }));
  } });
});
