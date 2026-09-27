import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capturePerplexitySession, untilAborted } from "./browser";
import { isRecord, text } from "./http";
import { readLimitedText } from "./providers/utils";

export interface LoginCallbacks {
  signal?: AbortSignal;
  onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
  onProgress?(message: string): void;
}
const BASE = "https://www.perplexity.ai";
const HEADERS = { "User-Agent": "Perplexity/641 CFNetwork/1568 Darwin/25.2.0", "X-App-ApiVersion": "2.18" };
export function sessionCredentials(token: string, email?: string) {
  if (!token || /[\s;]/.test(token)) throw new Error("Invalid Perplexity session cookie");
  let expires = 8.64e15;
  try { const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) expires = payload.exp * 1000 - 300000; } catch {}
  return { access: token, refresh: token, expires, email };
}
export async function validateSession(token: string, signal?: AbortSignal, fetchImpl = fetch): Promise<string> {
  sessionCredentials(token);
  const response = await fetchImpl(`${BASE}/api/auth/session`, { headers: { ...HEADERS, Cookie: `__Secure-next-auth.session-token=${token}` }, redirect: "error", signal });
  if (!response.ok) throw new Error(`Perplexity session validation failed (${response.status})`);
  const session: unknown = JSON.parse(await readLimitedText(response, "perplexity", 65536));
  const email = isRecord(session) && isRecord(session.user) ? text(session.user.email) : undefined;
  if (!email) throw new Error("Perplexity session invalid or expired. Run /login perplexity again.");
  return email;
}
export async function loginPerplexity(callbacks: LoginCallbacks, options: { fetch?: typeof fetch; capture?: typeof capturePerplexitySession } = {}) {
  const signal = AbortSignal.any([...(callbacks.signal ? [callbacks.signal] : []), AbortSignal.timeout(300000)]);
  signal.throwIfAborted();
  const prompt = (message: string, allowEmpty = false) => untilAborted(signal, () => callbacks.onPrompt({ message, allowEmpty }));
  const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  let method: string;
  let email = "";
  for (;;) {
    const input = (await prompt("Perplexity login: enter your email address, type email for OTP, or sso for browser (blank = sso)", true)).trim();
    signal.throwIfAborted();
    if (isEmail(input)) { method = "email"; email = input; break; }
    method = input.toLowerCase();
    if (!method || method === "sso" || method === "email") break;
    callbacks.onProgress?.("Enter an email address, or type email or sso. Press Escape to cancel.");
  }
  const fetchImpl = options.fetch ?? fetch;
  if (!method || method === "sso") {
    callbacks.onProgress?.("Sign in in the isolated browser window. Choose SSO for your organization. Close the window or cancel to stop.");
    const token = await untilAborted(signal, () => (options.capture ?? capturePerplexitySession)(signal));
    const email = await untilAborted(signal, () => validateSession(token, signal, fetchImpl));
    signal.throwIfAborted();
    return sessionCredentials(token, email);
  }
  while (!email) {
    const input = (await prompt("Perplexity email address (e.g. name@example.com)")).trim();
    signal.throwIfAborted();
    if (isEmail(input)) email = input;
    else callbacks.onProgress?.("Enter a valid email address. Press Escape to cancel.");
  }
  const cookies = new Map<string, string>();
  const request = async (path: string, body?: Record<string, unknown>) => {
    signal.throwIfAborted();
    const response = await fetchImpl(`${BASE}${path}`, { method: body ? "POST" : "GET", redirect: "error", signal,
      headers: { ...HEADERS, "Content-Type": "application/json", Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = /^([^=;]+)=([^;]*)/.exec(cookie);
      if (pair) { if (/max-age=0(?:;|$)/i.test(cookie)) cookies.delete(pair[1]); else cookies.set(pair[1], pair[2]); }
    }
    if (!response.ok) throw new Error(`Perplexity login request failed (${response.status})`);
    const payload: unknown = JSON.parse(await readLimitedText(response, "perplexity", 65536));
    if (!isRecord(payload)) throw new Error("Invalid Perplexity login response");
    return payload;
  };
  const csrf = await request("/api/auth/csrf");
  const csrfToken = text(csrf.csrfToken);
  if (!csrfToken) throw new Error("Missing Perplexity CSRF token");
  await request("/api/auth/signin-email", { email, csrfToken });
  const otp = (await prompt("Code sent to your email")).trim();
  if (!otp) throw new Error("Email code is required");
  let verified = await request("/api/auth/signin-otp", { email, otp, csrfToken });
  if (verified.status === "totp_challenge_required" && text(verified.challenge_token)) {
    const code = (await prompt("Authenticator app code")).trim();
    if (!code) throw new Error("Authenticator code is required");
    verified = await request("/api/auth/totp/challenge-verify", { token: verified.challenge_token, code });
  }
  if (verified.error_code || (verified.status && verified.status !== "success")) throw new Error("Perplexity login verification rejected");
  const token = text(verified.token) ?? cookies.get("__Secure-next-auth.session-token") ?? cookies.get("next-auth.session-token");
  if (!token) throw new Error("Perplexity login did not return a session token");
  await validateSession(token, signal, fetchImpl);
  return sessionCredentials(token, email);
}
export function registerPerplexityLogin(pi: ExtensionAPI) {
  // No chat models: this provider exists only for /login + Pi-managed storage.
  pi.registerProvider("perplexity", {
    baseUrl: "https://api.perplexity.ai", api: "openai-completions", apiKey: "$PERPLEXITY_API_KEY", models: [],
    oauth: {
      name: "Perplexity (web search subscription)", isSubscription: true, login: loginPerplexity,
      async refreshToken(credentials, signal) {
        const email = await validateSession(credentials.access, signal);
        return sessionCredentials(credentials.access, email);
      },
      getApiKey: credentials => credentials.access,
    },
  });
}
