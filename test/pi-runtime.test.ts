import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension";
import { createPiAuth } from "../src/pi-auth";

it("registers all auth providers in real Pi runtime without exposing OAuth as an API key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-search-runtime-test-"));
  try {
    const authPath = join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({ perplexity: { type: "oauth", access: "fake-session", refresh: "fake-session", expires: 8.64e15 } }), { mode: 0o600 });
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    const api = {
      registerProvider: (id: string, config: Parameters<ModelRuntime["registerProvider"]>[1]) => runtime.registerProvider(id, config),
      registerTool: () => {}, registerCommand: () => {}, registerFlag: () => {},
    };
    extension(api as unknown as ExtensionAPI);
    await runtime.refresh({ allowNetwork: false });
    const registry = new ModelRegistry(runtime);
    const auth = createPiAuth({ modelRegistry: registry });
    expect(auth.oauth!.has("perplexity")).toBe(true);
    expect((await auth.oauth!.get("perplexity"))?.accessToken).toBe("fake-session");
    // Ambient env may supply an unrelated API key, so test provider metadata too.
    expect(runtime.getProvider("perplexity")?.auth.oauth?.isSubscription).toBe(true);
    expect(runtime.getProvider("brave")?.auth.apiKey?.login).toBeTypeOf("function");
    expect(runtime.getProvider("google-gemini-cli")?.auth.oauth?.login).toBeTypeOf("function");
    expect(runtime.getProvider("google-antigravity")?.auth.oauth?.refresh).toBeTypeOf("function");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
