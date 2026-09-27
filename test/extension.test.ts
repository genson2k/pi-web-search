import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension";

// Capture the actual tool definition; no model call or Pi credential access.
function load() {
  let tool: any;
  const commands: string[] = [];
  const api: Pick<ExtensionAPI, "registerTool" | "registerFlag" | "getFlag" | "registerCommand" | "registerProvider"> = {
    registerTool: definition => { tool = definition; },
    registerFlag: () => {},
    registerProvider: () => {},
    getFlag: () => "exa",
    registerCommand: name => { commands.push(name); },
  };
  extension(api as ExtensionAPI);
  return { tool, commands };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("registers the Pi tool and status command", () => {
  const { tool, commands } = load();
  expect(tool.name).toBe("web_search");
  expect(tool.parameters.properties.query.type).toBe("string");
  expect(commands).toContain("web-search");
});
it("truncates large model output and saves the full text", async () => {
  vi.stubEnv("EXA_API_KEY", "test");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [{ title: "Docs", url: "https://example.com", summary: "a".repeat(70000) }] }), { headers: { "content-type": "application/json" } }));
  const { tool } = load();
  const result = await tool.execute("test", { query: "docs" }, undefined, undefined, {} as ExtensionContext);
  const path = result.details.fullOutputPath;
  try {
    expect(path).toBeTruthy();
    expect(result.content[0].text).toContain("Output truncated");
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(52000);
    expect((await readFile(path, "utf8")).length).toBeGreaterThan(70000);
  } finally { if (path) await rm(dirname(path), { recursive: true, force: true }); }
});
it("throws provider errors so Pi marks the tool failed", async () => {
  vi.stubEnv("EXA_API_KEY", "test");
  vi.stubGlobal("fetch", async () => new Response("denied", { status: 401 }));
  const { tool } = load();
  await expect(tool.execute("test", { query: "docs" })).rejects.toThrow("401");
});
