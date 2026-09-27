import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAuthStorage, type OAuthAccess } from "./auth";
import { isRecord, text } from "./http";

/** Resolve through the active Pi registry, preserving its refresh serialization.
 * Only provider-scoped auth is used. No custom model endpoint receives these keys. */
export function createPiAuth(ctx: Pick<ExtensionContext, "modelRegistry">) {
  const registry = ctx.modelRegistry;
  const alias = (id: string) => id === "kimi-code" ? "kimi-coding" : id;
  const isOAuth = (id: string) => {
    const provider = alias(id);
    const model = registry.getAll().find(model => model.provider === provider);
    // Pi's documented compatibility method reads only model.provider. Search-only
    // auth providers intentionally have no chat models, so supply the same field.
    return registry.isUsingOAuth(model ?? { provider } as Parameters<typeof registry.isUsingOAuth>[0]);
  };
  return createAuthStorage({
    hasKey: id => !isOAuth(id) && registry.getProviderAuthStatus(alias(id)).configured,
    getKey: async id => isOAuth(id) ? undefined : registry.getApiKeyForProvider(alias(id)),
    oauth: {
      has: id => isOAuth(id),
      async get(id, signal): Promise<OAuthAccess | undefined> {
        signal?.throwIfAborted();
        const resolved = await registry.getProviderAuth(alias(id));
        signal?.throwIfAborted();
        if (!resolved) return undefined;
        const headers = Object.fromEntries(Object.entries(resolved.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        let accessToken = resolved.auth.apiKey ?? headers.Authorization?.replace(/^Bearer\s+/i, "");
        if (!accessToken) return undefined;
        let projectId: string | undefined;
        // Older Pi Gemini OAuth uses a JSON API-key envelope.
        if (accessToken.startsWith("{")) {
          const envelope: unknown = JSON.parse(accessToken);
          if (isRecord(envelope)) { projectId = text(envelope.projectId); accessToken = text(envelope.token) ?? text(envelope.accessToken) ?? accessToken; }
        }
        projectId ??= resolved.env?.GOOGLE_CLOUD_PROJECT ?? resolved.env?.GOOGLE_CLOUD_PROJECT_ID;
        let accountId = headers["ChatGPT-Account-Id"] ?? headers["chatgpt-account-id"];
        if (id === "openai-codex" && !accountId) {
          try { const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString()); accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id; } catch {}
        }
        return { accessToken, accountId, projectId, headers };
      },
    },
  });
}
