import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser } from "puppeteer-core";

export async function untilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([run(), stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}
async function executable(): Promise<string> {
  const candidates = [process.env.PI_WEB_SEARCH_BROWSER_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    ...(platform() === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : platform() === "win32" ? [join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"), join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"])];
  for (const path of candidates) if (path) { try { await access(path); return path; } catch {} }
  throw new Error("Chrome/Chromium not found. Set PI_WEB_SEARCH_BROWSER_PATH to its executable. No browser is downloaded automatically.");
}
/** Own a separate temporary profile; never connect to the user's regular browser. */
export async function withBrowser<T>(headless: boolean, signal: AbortSignal, run: (browser: Browser) => Promise<T>): Promise<T> {
  const path = await executable();
  signal.throwIfAborted();
  const profile = await mkdtemp(join(tmpdir(), "pi-web-search-browser-"));
  let browser: Browser | undefined;
  try {
    const { default: puppeteer } = await import("puppeteer-core");
    signal.throwIfAborted();
    // Retain ownership across launch cancellation. Sandbox and TLS stay enabled.
    browser = await puppeteer.launch({ executablePath: path, headless, userDataDir: profile, pipe: true, timeout: 30000, defaultViewport: headless ? { width: 1440, height: 1000 } : null });
    signal.throwIfAborted();
    return await untilAborted(signal, () => run(browser!));
  } finally {
    if (browser) {
      try { await untilAborted(AbortSignal.timeout(5000), () => browser!.close()); }
      catch { browser.process()?.kill("SIGKILL"); }
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
export async function capturePerplexitySession(signal?: AbortSignal): Promise<string> {
  const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(300000)]);
  return withBrowser(false, lifetime, async browser => {
    const closed = new AbortController();
    const waiting = AbortSignal.any([lifetime, closed.signal]);
    browser.once("disconnected", () => closed.abort(new Error("Login browser closed")));
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.once("close", () => closed.abort(new Error("Login window closed")));
    const url = "https://www.perplexity.ai/auth/signin";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.bringToFront();
    const cdp = await page.createCDPSession();
    while (true) {
      const { cookies } = await untilAborted(waiting, () => cdp.send("Network.getCookies", { urls: [url] }));
      for (const name of ["__Secure-next-auth.session-token", "next-auth.session-token"]) {
        const cookie = cookies.find(c => c.name === name && c.value);
        if (cookie) return cookie.value;
      }
      await sleep(250, undefined, { signal: waiting });
    }
  });
}
