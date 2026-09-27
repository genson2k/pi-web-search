import { expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderCall, renderResult } from "../src/render";
import type { SearchDetails } from "../src/types";

const theme = getThemeByName("dark")!;
const strip = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
const long = "宽字符 emoji 🚀 ".repeat(20);
const details: SearchDetails = { notes: [long], failures: [{ provider: "brave", error: long }], response: {
  provider: "exa", answer: long, sources: Array.from({ length: 6 }, (_, i) => ({ title: `${long}${i}`, url: `https://example.com/${"x".repeat(200)}${i}`, snippet: long, publishedDate: "2026-01-01" })),
  citations: [{ title: long, url: "https://example.com" }], relatedQuestions: [long], searchQueries: [long] } };
const ctx = (expanded: boolean, isError = false) => ({ state: { startedAt: 0, endedAt: 1500 }, expanded, isError, isPartial: false });

it.each([20, 40, 80, 160])("every line fits width %i in all states", width => {
  const outputs = [
    renderCall({ query: long, provider: "perplexity", recency: "week", limit: 5, model: "m" }, theme, ctx(false)),
    renderResult({ content: [], details }, theme, ctx(false)),
    renderResult({ content: [], details }, theme, ctx(true)),
    renderResult({ content: [{ type: "text", text: `All web search providers failed: exa: ${long}; brave: HTTP 429` }] }, theme, ctx(false, true)),
    renderResult({ content: [] }, theme, { ...ctx(false), isPartial: true }),
  ];
  for (const c of outputs) for (const line of c.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});
it("collapsed shows top 3 with domains and expand hint; expanded shows all + links", () => {
  const collapsed = renderResult({ content: [], details }, theme, ctx(false)).render(100).map(strip);
  expect(collapsed[0]).toContain("Exa · 6 sources · 1.5s");
  expect(collapsed.filter(l => /^\s+\d\. /.test(l))).toHaveLength(3);
  expect(collapsed.join("\n")).toContain("+3 more");
  const raw = renderResult({ content: [], details }, theme, ctx(true)).render(100).join("\n");
  expect(raw).toContain("\x1b]8;;https://example.com/");
  expect(strip(raw)).toContain("Sources");
  expect(strip(raw)).toContain("Citations");
});
it("strips remote control sequences from titles", () => {
  const evil: SearchDetails = { notes: [], failures: [], response: { provider: "exa", sources: [{ title: "ok\x1b[2Jbad\x07", url: "https://e.com" }] } };
  const out = renderResult({ content: [], details: evil }, theme, ctx(false)).render(80).join("");
  expect(out).not.toContain("\x1b[2J");
});
