import { afterEach, describe, expect, it, vi } from "vitest";
import { loginPerplexity, sessionCredentials, validateSession } from "../src/perplexity-login";
import { discoverGoogleProject, googleOAuth, validateGoogleCallback } from "../src/google-login";
import { createPiAuth } from "../src/pi-auth";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", ...headers } });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("Perplexity login", () => {
  it("captures only the session cookie and validates before returning credentials", async () => {
    const result = await loginPerplexity({ onPrompt: async () => "sso" }, {
      capture: async () => "session-token", fetch: async (input, init) => {
        expect(String(input)).toBe("https://www.perplexity.ai/api/auth/session");
        expect(new Headers(init?.headers).get("Cookie")).toBe("__Secure-next-auth.session-token=session-token");
        expect(init?.redirect).toBe("error");
        return json({ user: { email: "test@example.com" } });
      },
    });
    expect(result.access).toBe("session-token");
    expect(result.email).toBe("test@example.com");
    expect(result.expires).toBe(8.64e15);
  });
  it("does email OTP then TOTP with a cookie jar", async () => {
    const prompts = ["email", "test@example.com", "123456", "654321"];
    const calls: string[] = [];
    const result = await loginPerplexity({ onPrompt: async () => prompts.shift()! }, { fetch: async (input, init) => {
      const path = new URL(String(input)).pathname; calls.push(path);
      if (path.endsWith("csrf")) return json({ csrfToken: "csrf" }, { "set-cookie": "csrf-cookie=value; Secure; HttpOnly" });
      expect(new Headers(init?.headers).get("Cookie")).toBe(path.endsWith("session") ? "__Secure-next-auth.session-token=session" : "csrf-cookie=value");
      if (path.endsWith("signin-email")) { expect(JSON.parse(String(init?.body)).email).toBe("test@example.com"); return json({}); }
      if (path.endsWith("signin-otp")) return json({ status: "totp_challenge_required", challenge_token: "challenge" });
      if (path.endsWith("challenge-verify")) { expect(JSON.parse(String(init?.body))).toEqual({ token: "challenge", code: "654321" }); return json({ status: "success", token: "session" }); }
      return json({ user: { email: "test@example.com" } });
    } });
    expect(result.access).toBe("session");
    expect(calls).toHaveLength(5);
  });
  it.each([
    ["direct address", ["  User+test@Example.com  ", "123456"]],
    ["literal email method", [" EMAIL ", "User+test@Example.com", "123456"]],
    ["retry after an unknown method", ["otp", "User+test@Example.com", "123456"]],
    ["retry after an invalid address", ["email", "not-an-address", "User+test@Example.com", "123456"]],
  ])("accepts %s without lowercasing the email", async (_label, inputs) => {
    const prompts = [...inputs];
    const capture = vi.fn();
    const result = await loginPerplexity({ onPrompt: async () => {
      const input = prompts.shift();
      if (input === undefined) throw new Error("Unexpected extra prompt");
      return input;
    } }, { capture, fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("csrf")) return json({ csrfToken: "csrf" });
      if (path.endsWith("signin-email") || path.endsWith("signin-otp")) {
        expect(JSON.parse(String(init?.body)).email).toBe("User+test@Example.com");
        return json(path.endsWith("signin-email") ? {} : { status: "success", token: "session" });
      }
      return json({ user: { email: "User+test@Example.com" } });
    } });
    expect(result.email).toBe("User+test@Example.com");
    expect(prompts).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
  });
  it("allows cancellation while retrying an invalid login method", async () => {
    const controller = new AbortController();
    const fetch = vi.fn();
    let prompts = 0;
    await expect(loginPerplexity({ signal: controller.signal, onPrompt: async () => {
      if (++prompts === 1) return "unknown";
      controller.abort(new Error("cancel"));
      return "email";
    } }, { fetch })).rejects.toThrow("cancel");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid/expired sessions and does not echo server bodies", async () => {
    await expect(validateSession("token", undefined, async () => json({}))).rejects.toThrow("invalid or expired");
    await expect(validateSession("token", undefined, async () => new Response("secret", { status: 401 }))).rejects.toThrow("401");
    expect(() => sessionCredentials("a;other=cookie")).toThrow("Invalid");
  });
  it("rejects a TOTP challenge token as a finished credential", async () => {
    const prompts = ["email", "a@example.com", "123", "456"];
    await expect(loginPerplexity({ onPrompt: async () => prompts.shift()! }, { fetch: async input => {
      const path = String(input);
      if (path.endsWith("csrf")) return json({ csrfToken: "csrf" });
      if (path.endsWith("signin-email")) return json({});
      return json({ status: "totp_challenge_required", challenge_token: "not-a-session" });
    } })).rejects.toThrow("rejected");
  });
  it("honors cancellation before opening a browser", async () => {
    const capture = vi.fn();
    await expect(loginPerplexity({ signal: AbortSignal.abort(new Error("cancel")), onPrompt: async () => "sso" }, { capture })).rejects.toThrow("cancel");
    expect(capture).not.toHaveBeenCalled();
  });
});
describe("Google OAuth", () => {
  it("checks callback state, origin, path and code", () => {
    const redirect = "http://127.0.0.1:8085/oauth2callback";
    expect(validateGoogleCallback(`${redirect}?state=expected&code=ok`, redirect, "expected")).toBe("ok");
    expect(() => validateGoogleCallback(`${redirect}?state=wrong&code=ok`, redirect, "expected")).toThrow("mismatch");
    expect(() => validateGoogleCallback("http://evil.example/oauth2callback?state=expected&code=ok", redirect, "expected")).toThrow("mismatch");
  });
  it("discovers existing Cloud Code Assist project", async () => {
    const project = await discoverGoogleProject("google-gemini-cli", "token", new AbortController().signal, async (_input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
      return json({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "project-1" });
    });
    expect(project).toBe("project-1");
  });
  it("provisions the free tier", async () => {
    let calls = 0;
    const project = await discoverGoogleProject("google-gemini-cli", "token", new AbortController().signal, async () => {
      return ++calls === 1 ? json({ allowedTiers: [{ id: "free-tier", isDefault: true }] }) : json({ done: true, response: { cloudaicompanionProject: { id: "new-project" } } });
    });
    expect(project).toBe("new-project");
  });
  it("preserves project and refresh token across token refresh", async () => {
    vi.stubGlobal("fetch", async () => json({ access_token: "new", expires_in: 3600 }));
    const result = await googleOAuth("google-gemini-cli").refreshToken({ access: "old", refresh: "refresh", expires: 0, projectId: "project" }, new AbortController().signal);
    expect(result.projectId).toBe("project");
    expect(result.refresh).toBe("refresh");
    expect(JSON.parse(googleOAuth("google-gemini-cli").getApiKey(result))).toEqual({ token: "new", projectId: "project" });
  });
});
it("keeps Pi OAuth sessions out of API-key transports, including search-only providers", async () => {
  const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: "session" } }));
  const registry = {
    getAll: () => [], isUsingOAuth: (model: { provider: string }) => model.provider === "perplexity",
    getProviderAuthStatus: () => ({ configured: true }), getProviderAuth,
    getApiKeyForProvider: vi.fn(async () => "api-key"),
  };
  vi.stubEnv("PERPLEXITY_API_KEY", "");
  const auth = createPiAuth({ modelRegistry: registry as unknown as ExtensionContext["modelRegistry"] });
  expect(auth.keys.source("perplexity")).toBeUndefined();
  expect(await auth.keys.get("perplexity")).toBeUndefined();
  expect(auth.oauth!.has("perplexity")).toBe(true);
  expect((await auth.oauth!.get("perplexity"))?.accessToken).toBe("session");
  expect(registry.getApiKeyForProvider).not.toHaveBeenCalled();
});
