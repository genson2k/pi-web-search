import type { FetchImpl } from "../auth";
import type { Page } from "puppeteer-core";
import { untilAborted, withBrowser } from "../browser";
import { setTimeout as sleep } from "node:timers/promises";
import { readLimitedText, withHardTimeout } from "./utils";
export interface LoadedHtmlPage { html: string; status: number; url: string }
export const productionFetches = new WeakSet<FetchImpl>();
export async function browserFetch(url: string, options: {
  fetch?: FetchImpl; signal?: AbortSignal; timeoutMs?: number; referer?: string;
  init?: RequestInit; headers?: Readonly<Record<string, string>>; randomizeHeaders?: boolean;
  browser?: { homeUrl?: string; ready?: { selector: string; timeoutMs: number }; shouldFallback(page: LoadedHtmlPage): boolean;
    afterNavigation?: (page: Page, signal: AbortSignal) => Promise<void>; attempts?: number; retryDelayMs?: number };
}): Promise<LoadedHtmlPage> {
  const signal = withHardTimeout(options.signal, options.timeoutMs);
  const canBrowse = options.browser && process.env.PI_WEB_SEARCH_BROWSER !== "0" && (!options.fetch || productionFetches.has(options.fetch));
  let loaded: LoadedHtmlPage | undefined;
  try {
    const response = await (options.fetch ?? fetch)(url, {
      ...options.init, headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9",
        ...(options.referer ? { Referer: options.referer } : {}), ...options.headers,
      }, signal,
    });
    loaded = { html: await readLimitedText(response, "google", 2 * 1024 * 1024), status: response.status, url: response.url || url };
  } catch (error) { signal.throwIfAborted(); if (!canBrowse) throw error; }
  if (loaded && (!canBrowse || (loaded.status >= 200 && loaded.status < 300 && !options.browser!.shouldFallback(loaded)))) return loaded;
  if (!canBrowse) throw new Error("HTML fetch failed");
  return withBrowser(true, signal, async browser => {
    const page = await browser.newPage();
    const config = options.browser!;
    if (config.homeUrl) await page.goto(config.homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    for (let attempt = 0; attempt < (config.attempts ?? 1); attempt++) {
      if (attempt) await sleep(config.retryDelayMs ?? 1000, undefined, { signal });
      const response = await untilAborted(signal, () => page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 60000 }));
      if (config.afterNavigation) await config.afterNavigation(page, signal);
      if (config.ready) await untilAborted(signal, () => page.waitForSelector(config.ready!.selector, { timeout: config.ready!.timeoutMs }).catch(() => null));
      const html = await untilAborted(signal, () => page.content());
      if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new Error("HTML response exceeds size limit");
      loaded = { html, status: response?.status() ?? 200, url: page.url() };
      if (!config.shouldFallback(loaded)) break;
    }
    return loaded!;
  });
}
