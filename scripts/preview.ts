// Render web_search TUI states without starting Pi: npx tsx scripts/preview.ts [width]
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderCall, renderResult } from "../src/render";
import type { SearchDetails } from "../src/types";


const theme = getThemeByName(process.env.PI_THEME ?? "dark")!;
const width = Number(process.argv[2] ?? process.stdout.columns ?? 100);
const details: SearchDetails = {
  notes: ["no results matched `filetype:pdf`; the constraint was relaxed"],
  failures: [{ provider: "brave", error: "HTTP 429" }],
  response: {
    provider: "perplexity", model: "experimental", authMode: "oauth",
    answer: "Pi extensions are TypeScript modules loaded with jiti. They can register tools, commands, providers and custom TUI renderers.",
    sources: [
      { title: "Extensions · Documentation · Pi", url: "https://pi.dev/docs/latest/extensions", snippet: "Extensions are TypeScript modules that add executable behavior to Pi.", publishedDate: "2026-08-01" },
      { title: "pi/packages/coding-agent/docs/extensions.md at main", url: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md", snippet: "A custom tool defines a name, description, TypeBox parameter schema and execute()." },
      { title: "Terminal UI · Documentation · Pi", url: "https://pi.dev/docs/latest/tui" },
      { title: "Pi packages gallery", url: "https://pi.dev/packages" },
    ],
    relatedQuestions: ["How do I render a custom tool result?"],
  },
};
const args = { query: "pi coding agent custom tool renderer", provider: "perplexity" as const, recency: "month" as const, limit: 5 };
const state = { startedAt: Date.now() - 2300 };
const show = (label: string, lines: string[]) => console.log(`\n\x1b[2m── ${label} ──\x1b[0m\n${lines.join("\n")}`);
const content = [{ type: "text", text: "" }];
show("call", renderCall(args, theme, { state, isError: false, expanded: false, isPartial: false }).render(width));
show("partial", renderResult({ content }, theme, { state: {}, isError: false, expanded: false, isPartial: true }).render(width));
show("collapsed", renderResult({ content, details }, theme, { state, isError: false, expanded: false, isPartial: false }).render(width));
show("expanded", renderResult({ content, details }, theme, { state, isError: false, expanded: true, isPartial: false }).render(width));
show("error", renderResult({ content: [{ type: "text", text: "All web search providers failed: exa: HTTP 429; duckduckgo: bot-detection challenge; try a different provider" }] }, theme, { state: {}, isError: true, expanded: false, isPartial: false }).render(width));
