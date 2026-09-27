// TUI rendering for web_search. Pure functions of (state, width, theme) so
// output always fits the terminal and follows theme changes.
import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth as truncate, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { SearchDetails, SearchToolParams } from "./types";
import { SEARCH_PROVIDER_LABELS } from "./types";

export interface RenderState { startedAt?: number; endedAt?: number }
type Ctx = { state: RenderState; isError: boolean; expanded: boolean; isPartial: boolean };

const truncateToWidth = (text: string, width: number, ellipsis = "…") => truncate(text, Math.max(1, width), ellipsis);
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
export const domain = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const expandKey = () => { try { return keyText("app.tools.expand") || "ctrl+o"; } catch { return "ctrl+o"; } };
const seconds = (s: RenderState) => s.startedAt !== undefined && s.endedAt !== undefined ? `${((s.endedAt - s.startedAt) / 1000).toFixed(1)}s` : "";

/** Lines rendered lazily with the real width. */
class Lines implements Component {
  constructor(private build: (width: number) => string[]) {}
  render(width: number) { return this.build(Math.max(1, width)).map(l => truncateToWidth(l, Math.max(1, width))); }
  invalidate() {}
}
function wrap(text: string, width: number, indent: string, style: (s: string) => string, maxLines = Infinity): string[] {
  const avail = Math.max(10, width - visibleWidth(indent));
  const out = wrapTextWithAnsi(text, avail);
  const kept = out.slice(0, maxLines).map(l => indent + style(l));
  if (out.length > maxLines && kept.length) kept[kept.length - 1] = truncateToWidth(kept[kept.length - 1], width - 1, "") + "…";
  return kept;
}

export function renderCall(args: Partial<SearchToolParams>, theme: Theme, ctx: Ctx): Component {
  ctx.state.startedAt ??= Date.now();
  return new Lines(width => {
    const chips: string[] = [];
    if (args.provider && args.provider !== "auto") chips.push(SEARCH_PROVIDER_LABELS[args.provider] ?? args.provider);
    if (args.recency) chips.push(`past ${args.recency}`);
    const n = args.num_search_results ?? args.limit;
    if (n) chips.push(`${n} results`);
    if (args.model) chips.push(args.model);
    const head = `${theme.fg("accent", "◎")} ${theme.fg("toolTitle", theme.bold("Web Search"))} `;
    const chipText = chips.length ? " " + chips.map(c => theme.fg("dim", `[${c}]`)).join(" ") : "";
    const room = width - visibleWidth(head) - visibleWidth(chipText);
    const query = clean(args.query ?? "");
    return [head + theme.fg("text", truncateToWidth(`“${query}”`, Math.max(8, room))) + chipText];
  });
}

export function renderResult(result: { content: { type: string; text?: string }[]; details?: SearchDetails }, theme: Theme, ctx: Ctx): Component {
  const d = result.details;
  if (ctx.isPartial) {
    return new Lines(() => [`  ${theme.fg("warning", "⋯")} ${theme.fg("muted", "Searching the web…")}`]);
  }
  ctx.state.endedAt ??= Date.now();
  if (ctx.isError || !d?.response) {
    const message = clean(result.content.find(c => c.type === "text")?.text ?? "Search failed");
    return new Lines(width => {
      const parts = message.replace(/^All web search providers failed:\s*/, "").split(/;\s*(?=[a-z]+:)/);
      const lines = [`  ${theme.fg("error", "✗ Search failed")}`];
      if (parts.length > 1 || /providers failed/.test(message)) for (const p of parts.slice(0, ctx.expanded ? 30 : 4)) lines.push(...wrap(p, width, "    ", s => theme.fg("dim", s), 1));
      else lines.push(...wrap(message, width, "    ", s => theme.fg("dim", s), ctx.expanded ? 20 : 2));
      return lines;
    });
  }
  const r = d.response;
  return new Lines(width => {
    const label = SEARCH_PROVIDER_LABELS[r.provider] ?? r.provider;
    const meta = [label, r.model, `${r.sources.length} source${r.sources.length === 1 ? "" : "s"}`, seconds(ctx.state), r.authMode].filter(Boolean).join(" · ");
    const lines = [`  ${theme.fg("success", "✓")} ${theme.fg("muted", meta)}`];
    for (const f of d.failures) lines.push(`  ${theme.fg("warning", "↷")} ${theme.fg("dim", truncateToWidth(`${f.provider}: ${f.error}`, width - 4))}`);
    for (const note of d.notes) lines.push(...wrap(`! ${note}`, width, "  ", s => theme.fg("warning", s), 2));
    if (!ctx.expanded) {
      if (r.answer) lines.push(...wrap(clean(r.answer), width, "  ", s => theme.fg("toolOutput", s), 2));
      const top = r.sources.slice(0, 3);
      top.forEach((s, i) => {
        const dom = theme.fg("dim", ` — ${domain(s.url)}`);
        const title = truncateToWidth(clean(s.title), Math.max(8, width - 7 - visibleWidth(dom)));
        lines.push(`  ${theme.fg("accent", `${i + 1}.`)} ${hyperlink(theme.fg("text", title), s.url)}${dom}`);
      });
      const more = r.sources.length - top.length;
      lines.push(`  ${theme.fg("dim", `${more > 0 ? `+${more} more · ` : ""}${expandKey()} to expand`)}`);
      return lines;
    }
    if (r.answer) {
      lines.push("", `  ${theme.fg("mdHeading", theme.bold("Answer"))}`);
      for (const para of r.answer.split(/\n+/).map(clean).filter(Boolean)) lines.push(...wrap(para, width, "  ", s => theme.fg("toolOutput", s)));
    }
    if (r.sources.length) lines.push("", `  ${theme.fg("mdHeading", theme.bold("Sources"))}`);
    const numWidth = String(r.sources.length).length;
    r.sources.forEach((s, i) => {
      const num = theme.fg("accent", `${String(i + 1).padStart(numWidth)}.`);
      const date = s.publishedDate ? theme.fg("dim", ` · ${clean(s.publishedDate).slice(0, 24)}`) : "";
      const indent = " ".repeat(numWidth + 4);
      lines.push(`  ${num} ${hyperlink(theme.fg("text", theme.bold(truncateToWidth(clean(s.title), Math.max(8, width - indent.length - visibleWidth(date))))), s.url)}${date}`);
      lines.push(indent + hyperlink(theme.fg("mdLinkUrl", truncateToWidth(s.url, width - indent.length)), s.url));
      if (s.snippet) lines.push(...wrap(clean(s.snippet), width, indent, t => theme.fg("dim", t), 3));
    });
    if (r.citations?.length) {
      lines.push("", `  ${theme.fg("mdHeading", theme.bold("Citations"))}`);
      for (const c of r.citations) lines.push(`  ${theme.fg("mdQuoteBorder", "│")} ${hyperlink(theme.fg("text", truncateToWidth(clean(c.title), width - 4)), c.url)}`);
    }
    if (r.relatedQuestions?.length) {
      lines.push("", `  ${theme.fg("mdHeading", theme.bold("Related"))}`);
      for (const q of r.relatedQuestions.slice(0, 8)) lines.push(...wrap(`• ${clean(q)}`, width, "  ", s => theme.fg("muted", s), 2));
    }
    if (r.searchQueries?.length) lines.push("", `  ${theme.fg("dim", `Queries: ${r.searchQueries.slice(0, 3).map(clean).join(" · ")}`)}`);
    if (d.fullOutputPath) lines.push(`  ${theme.fg("warning", "Output truncated for the model; full text:")} ${theme.fg("dim", d.fullOutputPath)}`);
    return lines;
  });
}
