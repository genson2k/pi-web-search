# pi-web-search

Web search for the [Pi coding agent](https://pi.dev), ported from the web search in **[oh-my-pi](https://github.com/can1357/oh-my-pi) by Can Bölük**. It runs on Node.js and doesn't need the OMP runtime or database.

- `web_search` tool, `/web-search` status command, user and project config.
- **All 25 OMP backend IDs**: search APIs, hosted model search, HTML engines and the Public Web aggregate.
- **`/login perplexity`**: browser SSO or email OTP/TOTP. It uses your Perplexity subscription session, so you don't need a separate API key.
- `/login google-gemini-cli` and `/login google-antigravity`. Also reuses Pi's existing Anthropic, Codex and xAI logins.
- Query operators, native filters, sequential fallback, timeouts and cancellation, size-limited JSON/SSE, and output truncation.
- A custom TUI renderer with a compact summary and an expandable result view.

**This is a functional port built on Pi's extension API, not an embedded copy of OMP.** Every backend has an implementation and fixture tests, but not every endpoint or account type has been checked against the live service. [PORTING.md](PORTING.md) lists the remaining differences.

## Install

Requires Node.js **22.19+** and a current Pi (`@earendil-works/pi-coding-agent`; tested with 0.87.1).

```bash
pi install git:github.com/genson2k/pi-web-search@v0.2.0
```

Or from a local clone:

```bash
git clone https://github.com/genson2k/pi-web-search
cd pi-web-search
npm ci --ignore-scripts

# Try it for one session without changing settings:
pi -e ./src/extension.ts

# Or install the clone:
pi install /absolute/path/to/pi-web-search
```

Restart Pi or run `/reload` afterwards. The package is not on npm, and `npm:pi-web-search` may be an unrelated package. The older `@mariozechner/pi-coding-agent` has not been tested.

## Perplexity login

With the extension loaded:

```text
/login perplexity
```

1. If Pi asks for a method, choose OAuth.
2. Enter `sso` or leave it blank to open a browser. For email OTP, type your email address directly, or type `email` and enter the address at the next prompt.
3. Sign in in the separate Chrome window. Choose SSO if your organization requires it.
4. The extension reads the session cookie from **that window only**, validates it with Perplexity, and hands the credential to Pi, which stores it in `auth.json`.
5. To keep searches on Perplexity instead of falling back to other services, pin the provider:

```bash
pi -e ./src/extension.ts --web-search-provider perplexity
```

You can also pass `provider: "perplexity"` to the tool. `/web-search` shows the detected sessions and config but never shows tokens. `/logout perplexity` removes the stored credential.

### Browser and headless use

- Requires an installed Chrome or Chromium. Common install paths on macOS, Linux and Windows are detected automatically.
- For a different path, set `PI_WEB_SEARCH_BROWSER_PATH=/path/to/chrome` (or `PUPPETEER_EXECUTABLE_PATH`).
- Login uses a temporary, isolated profile. It does not touch your normal browser profile, the Keychain, or the Perplexity desktop app.
- Sandbox and TLS checks stay enabled. No browser is downloaded automatically.
- Login times out after 5 minutes. Close the window or cancel in Pi to stop; the profile is cleaned up afterwards.
- On machines without a GUI, choose **email** instead of `sso`: enter your address, then the email code, then an authenticator code if your account has one.
- Browser SSO needs a local graphical session, so use the email flow for RPC and headless setups.
- If the session expires or is revoked, run `/login perplexity` again. The extension won't quietly switch to anonymous search or API billing unless other auth is configured.

The Perplexity consumer endpoints are internal service APIs and may change or be blocked. The SSO and OTP flows are covered by mocked tests but have not been checked with a real account.

### Perplexity API key

```bash
export PERPLEXITY_API_KEY='...'
```

This is Perplexity's separately billed API, **not** the Pro/Enterprise subscription. Auth order: `PERPLEXITY_COOKIES` → Pi session → direct API key → OpenRouter (only when Perplexity is selected explicitly). If Perplexity is selected explicitly and no auth is configured, anonymous consumer search is tried.

The subscription model defaults to `experimental` (`PI_PERPLEXITY_MODEL`). The API model defaults to `sonar-pro` (`PI_PERPLEXITY_API_MODEL`). A `model` passed to the tool applies to whichever auth path runs, so don't pass an API model ID when using the subscription.

## Providers

| Provider | Auth / config | Transport |
|---|---|---|
| `parallel` | `PARALLEL_API_KEY`, `/login parallel`, or keyless | REST / public MCP |
| `perplexity` | `/login perplexity`, `PERPLEXITY_API_KEY`, `PERPLEXITY_COOKIES` | Consumer SSE / Sonar API |
| `gemini` | `GEMINI_API_KEY`, `/login google`, `/login google-gemini-cli`, `/login google-antigravity` | Google Search grounding / Cloud Code Assist SSE |
| `anthropic` | `/login anthropic`, `ANTHROPIC_SEARCH_API_KEY`, `ANTHROPIC_API_KEY` | Messages API hosted web search |
| `codex` | `/login openai-codex` | Codex Responses SSE; requires a web search event |
| `xai` | `/login xai`, `XAI_API_KEY` | Responses API hosted web search |
| `openrouter` | `/login openrouter`, `OPENROUTER_API_KEY` | Chat completions + web plugin |
| `zai` | `/login zai`, `ZAI_API_KEY` | Stateful MCP (initialize + tools/call) |
| `exa` | `/login exa`, `EXA_API_KEY`, or keyless | REST / public MCP |
| `tinyfish` | `/login tinyfish`, `TINYFISH_API_KEY` | Search API with pagination |
| `jina` | `/login jina`, `JINA_API_KEY` | Jina Search |
| `kagi` | `/login kagi`, `KAGI_API_KEY` | Kagi V1 Search API |
| `tavily` | `/login tavily`, `TAVILY_API_KEY` | Search API |
| `firecrawl` | `/login firecrawl`, `FIRECRAWL_API_KEY`, or keyless | V2 search |
| `brave` | `/login brave`, `BRAVE_API_KEY` | Search API |
| `kimi` | `/login kimi-coding`, `KIMI_SEARCH_API_KEY`, `MOONSHOT_SEARCH_API_KEY`, `KIMI_API_KEY` | Kimi Code search; **`MOONSHOT_API_KEY` is not accepted** |
| `synthetic` | `/login synthetic`, `SYNTHETIC_API_KEY` | Search API |
| `ollama` | `/login ollama-cloud`, `OLLAMA_CLOUD_API_KEY` | Hosted search, not local Ollama |
| `searxng` | `SEARXNG_ENDPOINT` | Self-hosted JSON search |
| `startpage` | None | Homepage token + HTML search |
| `duckduckgo` | None | HTML search with pagination |
| `ecosia` | None | HTML; Chrome fallback |
| `google` | None | HTML; Chrome fallback |
| `mojeek` | None | HTML; Chrome fallback |
| `public` | None, **explicit only** | Fans out to 5 HTML engines, deduplicates and ranks by consensus |

Model-backed providers can use API credits or subscription quota. Pi owns OAuth storage and refresh; the extension never opens its own auth store. Search-specific key variables take priority over Pi auth. Token usage is reported to Pi, but **dollar cost is left at 0** because search billing isn't purely token-based.

### Google OAuth

```text
/login google-gemini-cli
/login google-antigravity
```

Opens a Google sign-in URL using OAuth with PKCE and callback state validation, then discovers or provisions a Cloud Code Assist project. Some accounts need `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID`.

On a remote machine, start Pi with `PI_WEB_SEARCH_OAUTH_MANUAL=1` and paste the full callback URL when asked. Callback ports: 8085 for Gemini CLI, 51121 for Antigravity. The OAuth client configuration is taken from OMP and belongs to Google's Gemini CLI and Antigravity public installed-app clients; Google can change or revoke access at any time. Not every account type is guaranteed to be granted access.

### Extra engine settings

- Self-hosted Firecrawl: `FIRECRAWL_BASE_URL` or `FIRECRAWL_API_URL` (V2 endpoint).
- Kimi endpoint: `KIMI_SEARCH_BASE_URL` or `MOONSHOT_SEARCH_BASE_URL`.
- SearXNG: `SEARXNG_ENDPOINT`; auth via `SEARXNG_TOKEN` or `SEARXNG_BASIC_USERNAME` + `SEARXNG_BASIC_PASSWORD` (Basic wins if both are set); optional `SEARXNG_CATEGORIES`, `SEARXNG_LANGUAGE`, `SEARXNG_ENGINES`, `SEARXNG_SAFESEARCH`. The instance must have JSON output enabled. Engine shortcuts are resolved through `/config`.
- Exa pacing: `PI_WEB_SEARCH_EXA_DELAY_MS`, default 1000 ms; `0` disables it.
- HTML browser fallback: on by default when needed; `PI_WEB_SEARCH_BROWSER=0` turns it off (the Perplexity browser login is unaffected). OMP's stealth patches are not included, so bot challenges can still fail.

## Provider chain and models

In `auto` mode, configured providers are tried in table order (skipping HTML engines and Public Web), then Parallel → Exa → Startpage → DuckDuckGo → Ecosia → Google → Mojeek. A provider that already failed isn't retried, and Public Web only runs when selected explicitly.

```bash
# Pin one provider, no fallback:
pi -e ./src/extension.ts --web-search-provider perplexity

# Sequential chain:
PI_WEB_SEARCH_PROVIDER=perplexity,exa,duckduckgo pi -e ./src/extension.ts

# Per-provider timeout (default 60s, max 300s):
PI_WEB_SEARCH_TIMEOUT=90 pi -e ./src/extension.ts
```

Persistent config lives in `~/.pi/agent/web-search.json` (or `$PI_CODING_AGENT_DIR/web-search.json`):

```json
{
  "providers": ["perplexity", "exa", "duckduckgo"],
  "exclude": ["public"],
  "timeoutSeconds": 60,
  "models": {
    "gemini": "google-gemini-cli/gemini-2.5-flash",
    "codex": "gpt-5.5",
    "xai": "grok-4.5",
    "openrouter": "openai/gpt-4.1-mini"
  }
}
```

A project `.pi/web-search.json` is read **only after the project is trusted**. `models` entries are merged; arrays replace. Config is re-read on every call, so no reload is needed.

- Chain precedence: CLI flag → env chain → config → auto.
- The timeout env var takes precedence over config.
- `providers: []`, or excluding the whole chain, disables search.
- `exclude` still applies when the model pins a provider.

Model ID precedence: tool `model` → config `models` → `PI_WEB_SEARCH_<PROVIDER>_MODEL` → default. For Gemini, a `google/...`, `google-gemini-cli/...` or `google-antigravity/...` prefix selects the auth path; without a prefix, the available auth paths are tried. This is exact matching, not OMP's fuzzy model-role resolution.

## TUI

`web_search` has its own renderer in the Pi TUI:

- Call line: `◎ Web Search “query”` with chips for provider, recency, result count and model.
- While running: `⋯ Searching the web…`.
- Collapsed: provider · model · source count · duration · auth; skipped fallback providers (`↷`); filter notes; 2 lines of the answer; top 3 sources with domains.
- Expanded (`ctrl+o`, or whatever `app.tools.expand` is bound to): full answer, all sources with URL, date and snippet, citations, related questions and queries.
- Errors: `✗ Search failed`, one line per provider.
- Titles and URLs are clickable (OSC 8) in terminals that support it. Colors follow the Pi theme, every line fits the terminal width (wide characters and emoji included), and control characters from web content are stripped.

Preview without Pi: `npx tsx scripts/preview.ts 100` (`PI_THEME=light` for the light theme).

## Tool schema

```json
{
  "query": "Node.js permissions site:nodejs.org after:2025-01-01",
  "provider": "perplexity",
  "limit": 5,
  "recency": "month",
  "max_tokens": 4096
}
```

- `query`: 1–10,000 characters, not whitespace only.
- `provider`: `auto` or an ID from the table. A specific ID replaces the whole chain.
- `limit`: default 10, range 1–40; backends may return fewer.
- `num_search_results`: OMP-compatible result count; takes precedence over `limit`.
- `recency`: `day`, `week`, `month` or `year`; ignored by backends that don't support it.
- `model`: model ID for model-backed search.
- `max_tokens`: 1–32,768; only model-backed providers use it (Codex ignores it).
- `temperature`: 0–1; sent only where supported (Anthropic and Codex ignore it).

The OMP parser supports `site:`, `-site:`, date bounds, `inurl:`, `intitle:`, `filetype:`, quoted phrases, exclusions, `OR` and language directives. Constraints are mapped to each provider's native filters, then applied as a lenient post-filter: if a constraint would remove every source, it is relaxed and reported in a `Note:`. **This is not strict or security filtering**, and the answer and citations are not rewritten when sources are filtered.

The text output includes the provider, the answer if any, and sources with snippets of up to 240 characters. `details` holds the response, notes, failures, model and usage, and `fullOutputPath` when truncated. Output over 2,000 lines or 50 KiB is saved in full to a temp file (mode 0600) that the agent can read; the file stays until you clear your temp directory.

- Errors, empty results and timeouts move on to the next provider in the chain.
- Cancellation stops immediately without falling back.
- When the whole chain fails, the tool throws so Pi marks it as failed.
- Responses are capped at 2 MiB; Public Web has a 5 s soft and 30 s hard deadline.
- Source URLs are never fetched automatically.

## Privacy and safety

- Your query is sent to every service the chain tries, and Public Web sends it to 5 engines. Pin a provider if you don't want it shared with fallbacks.
- Transcripts, files, Pi session IDs and model metadata are never sent to public MCP services.
- API credentials are only sent to their own backend (or a self-hosted endpoint you configure). Pi manages OAuth refresh.
- Browser login only reads the session cookie from the temporary window it opened; it never borrows desktop app sessions.
- All web output is treated as untrusted data, not instructions. Only HTTP(S) source URLs are kept.
- Loading the extension doesn't log in, install anything, change settings or open a browser. The browser runs only for login or when an HTML search needs it.
- Like every Pi extension, this one runs with full permissions. Only install sources you trust.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:live -- parallel 'Pi coding agent documentation'
npm pack --dry-run
```

The default tests need no network. They cover query parsing, native filters, response envelopes, OAuth callbacks and refresh, session segregation, Perplexity OTP/TOTP, SSE, HTML fixtures (no browser), Public Web ranking, config trust, timeouts and cancellation, truncation, and TUI rendering.

Checked live: keyless Parallel, Exa and DuckDuckGo; the Pi loader and runtime with a temporary auth store; the Chrome lifecycle. Not yet checked live: subscription logins with real accounts and the paid APIs. Read [PORTING.md](PORTING.md) before treating this as equivalent to OMP.

## Credits

Based on the web search in [oh-my-pi](https://github.com/can1357/oh-my-pi) by Can Bölük (upstream revision `b1a8b875cf81ec2fdc3cc397a2d4b6a9a777543d`). MIT licensed; see [NOTICE](NOTICE) and [LICENSE](LICENSE).
