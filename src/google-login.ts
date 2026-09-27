// Google desktop OAuth + Cloud Code Assist project discovery adapted from OMP.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { isRecord, text } from "./http";
import { readLimitedText } from "./providers/utils";
import { untilAborted } from "./browser";

type GoogleId = "google-gemini-cli" | "google-antigravity";
type OAuth = NonNullable<ProviderConfig["oauth"]>;
const CONFIG = {
  "google-gemini-cli": {
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    clientSecret: "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", port: 8085, path: "/oauth2callback",
    endpoint: "https://cloudcode-pa.googleapis.com",
  },
  "google-antigravity": {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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", port: 51121, path: "/oauth-callback",
    endpoint: "https://daily-cloudcode-pa.googleapis.com",
  },
} as const;
async function payload(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Google authentication request failed (${response.status})`);
  const value: unknown = JSON.parse(await readLimitedText(response, "gemini", 256 * 1024));
  if (!isRecord(value)) throw new Error("Invalid Google authentication response");
  return value;
}
export function validateGoogleCallback(raw: string, redirect: string, state: string): string {
  const url = new URL(raw);
  const expected = new URL(redirect);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("state") !== state) throw new Error("OAuth callback state/origin mismatch");
  if (url.searchParams.has("error")) throw new Error("Google authorization denied");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Google callback missing authorization code");
  return code;
}
export async function discoverGoogleProject(id: GoogleId, accessToken: string, signal: AbortSignal, fetchImpl = fetch): Promise<string> {
  const config = CONFIG[id];
  const antigravity = id === "google-antigravity";
  const envProject = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID;
  const metadata = antigravity ? { ideType: "ANTIGRAVITY" } : { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI", duetProject: envProject };
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": antigravity ? "antigravity/1.20.5" : "GeminiCLI/0.31.0" };
  const call = async (path: string, body?: unknown) => payload(await fetchImpl(`${config.endpoint}${path}`, { headers, signal, redirect: "error", method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) }));
  let loaded = await call("/v1internal:loadCodeAssist", { metadata, ...(envProject ? { cloudaicompanionProject: envProject } : {}) });
  if (antigravity && !loaded.paidTier && text(loaded.cloudaicompanionProject)) loaded = await call("/v1internal:loadCodeAssist", { metadata, cloudaicompanionProject: loaded.cloudaicompanionProject });
  if (loaded.currentTier) {
    const project = text(loaded.cloudaicompanionProject) ?? envProject;
    if (project) return project;
    throw new Error("Set GOOGLE_CLOUD_PROJECT for this Cloud Code Assist account");
  }
  const tiers = Array.isArray(loaded.allowedTiers) ? loaded.allowedTiers.filter(isRecord) : [];
  const tier = antigravity ? "free-tier" : text(tiers.find(t => t.isDefault)?.id) ?? "legacy-tier";
  if (antigravity && !tiers.some(t => t.id === "free-tier") && Array.isArray(loaded.ineligibleTiers) && loaded.ineligibleTiers.length) throw new Error("Account is not eligible for Antigravity free tier; verify eligibility in the official client");
  if (!antigravity && tier !== "free-tier" && !envProject) throw new Error("Set GOOGLE_CLOUD_PROJECT for this Cloud Code Assist account");
  let operation = await call("/v1internal:onboardUser", { tierId: tier, metadata, ...(tier !== "free-tier" && envProject ? { cloudaicompanionProject: envProject } : {}) });
  for (let i = 0; !operation.done && i < 24; i++) {
    const name = text(operation.name);
    if (!name || name.includes("..") || !/^operations\/[\w./-]+$/.test(name)) throw new Error("Invalid Google operation name");
    await sleep(antigravity ? 1000 : 5000, undefined, { signal });
    operation = await call(`/v1internal/${name}`);
  }
  if (!operation.done || operation.error) throw new Error("Google project provisioning failed or timed out");
  if (antigravity) loaded = await call("/v1internal:loadCodeAssist", { metadata });
  const response = isRecord(operation.response) ? operation.response : {};
  const project = antigravity ? text(loaded.cloudaicompanionProject)
    : isRecord(response.cloudaicompanionProject) ? text(response.cloudaicompanionProject.id) : text(response.cloudaicompanionProject);
  if (!project && !envProject) throw new Error("Google did not return a project ID");
  return project ?? envProject!;
}
export function googleOAuth(id: GoogleId): OAuth {
  const config = CONFIG[id];
  const exchange = async (fields: Record<string, string>, signal: AbortSignal) => payload(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
  }));
  return {
    name: id === "google-gemini-cli" ? "Google Cloud Code Assist (web search)" : "Google Antigravity (web search)",
    async login(callbacks) {
      const signal = AbortSignal.any([...(callbacks.signal ? [callbacks.signal] : []), AbortSignal.timeout(300000)]);
      signal.throwIfAborted();
      const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
      const redirect = `http://127.0.0.1:${config.port}${config.path}`;
      let resolveCode!: (code: string) => void;
      const result = new Promise<string>(resolve => { resolveCode = resolve; });
      const server = createServer((req, res) => {
        try { const code = validateGoogleCallback(new URL(req.url ?? "", redirect).href, redirect, state); res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Signed in. Return to Pi."); resolveCode(code); }
        catch { res.writeHead(400); res.end("Invalid callback"); }
      });
      let listening = false;
      try {
        try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", () => { listening = true; resolve(); }); }); } catch { /* Manual callback paste on occupied/headless hosts. */ }
        const scopes = ["cloud-platform", "userinfo.email", "userinfo.profile", ...(id === "google-antigravity" ? ["cclog", "experimentsandconfigs"] : [])].map(s => `https://www.googleapis.com/auth/${s}`);
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirect, response_type: "code", scope: scopes.join(" "), state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", access_type: "offline", prompt: "consent" }).toString();
        callbacks.onAuth({ url: url.href, instructions: "Complete Google sign-in. On a remote machine, paste the complete callback URL when prompted." });
        const manual = () => callbacks.onPrompt({ message: "Paste complete Google callback URL (remote/headless login)" }).then(raw => validateGoogleCallback(raw, redirect, state));
        const code = await untilAborted(signal, () => listening && process.env.PI_WEB_SEARCH_OAUTH_MANUAL !== "1" ? result : manual());
        const token = await exchange({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }, signal);
        const access = text(token.access_token), refresh = text(token.refresh_token);
        if (!access || !refresh) throw new Error("Google did not return access and refresh tokens");
        callbacks.onProgress?.("Discovering Cloud Code Assist project...");
        const projectId = await discoverGoogleProject(id, access, signal);
        return { access, refresh, expires: Date.now() + (Number(token.expires_in) || 3600) * 1000 - 300000, projectId };
      } finally { server.closeAllConnections(); if (listening) await new Promise<void>(resolve => server.close(() => resolve())); }
    },
    async refreshToken(credentials, signal) {
      const token = await exchange({ grant_type: "refresh_token", refresh_token: credentials.refresh }, signal);
      const access = text(token.access_token);
      if (!access) throw new Error("Google refresh did not return an access token");
      return { ...credentials, access, refresh: text(token.refresh_token) ?? credentials.refresh, expires: Date.now() + (Number(token.expires_in) || 3600) * 1000 - 300000 };
    },
    getApiKey: credentials => JSON.stringify({ token: credentials.access, projectId: credentials.projectId }),
  };
}
export function registerGoogleLogin(pi: ExtensionAPI) {
  for (const id of ["google-gemini-cli", "google-antigravity"] as const) pi.registerProvider(id, { api: "google-generative-ai", baseUrl: CONFIG[id].endpoint, models: [], oauth: googleOAuth(id) });
}
