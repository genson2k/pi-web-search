# Port status

Source: can1357/oh-my-pi, revision b1a8b875cf81ec2fdc3cc397a2d4b6a9a777543d.

## Implemented

All 25 upstream provider IDs are implemented and covered by registration/request/parser fixtures:

- Parallel, Perplexity, Gemini, Anthropic, Codex, xAI, OpenRouter, Z.AI
- Exa, TinyFish, Jina, Kagi, Tavily, Firecrawl, Brave, Kimi, Synthetic, Ollama, SearXNG
- Startpage, DuckDuckGo, Ecosia, Google, Mojeek, Public Web

Authentication:

- Perplexity isolated-browser session capture + validation; email OTP/TOTP with cookie jar.
- Perplexity session/API key segregation. Cookies, subscription, direct API, explicit OpenRouter and anonymous request paths.
- Google Gemini CLI / Antigravity PKCE login, loopback callback validation, manual callback mode, project discovery/onboarding and refresh.
- Pi-owned existing Anthropic/Codex/xAI OAuth. No sibling auth-file writer or manual refresh races.
- Search API-key providers registered for Pi /login; environment keys remain supported.

Core:

- OMP query parser and lenient filters; output source/citation formatting.
- Lazy loading; sequential configured fallback; explicit-only public fan-out with deterministic dedup/ranking.
- Provider deadlines, cancellation propagation, bounded bodies, incremental SSE, output truncation.
- Persistent provider/model/exclude/timeout config; project config requires trust.
- Chrome lifecycle for login and HTML fallback (isolated temporary profile, sandbox/TLS enabled, bounded close).
- Exa process-local request pacing.

## Deliberate platform differences

- Pi extension API and TypeBox instead of OMP built-in tool/omptype.
- Pi auth.json/provider registry instead of OMP agent.db/auth broker.
- No copying credentials from macOS Perplexity app, Keychain, or other apps.
- Uses an installed Chrome/Chromium, does not auto-download a browser.
- No OMP shared browser daemon, stealth patches or randomized browser-fingerprint package.
- No OMP model catalog/role resolver, fuzzy selection or OMP config migrations. Exact provider/model config is supported instead.
- Uses Pi's normal tool rendering instead of the OMP-specific TUI component.
- No separate `omp q` replacement executable; script smoke runner and Pi tool cover one-shot use.
- Max tool result count 40; individual providers may cap lower (OMP Firecrawl permits 100).
- Failure throws under Pi's tool contract rather than returning a successful Error-text result.
- No extra model/session attribution sent to public search services.
- Nested token usage reported; dollar costs left zero because actual search billing is unknown.

## Remaining parity gaps / limitations

Provider coverage is not a claim of byte-for-byte behavioral parity. In particular:

- Grounded adapters use fixed official service endpoints. OMP per-model proxy/baseUrl/header resolution, Anthropic Foundry/CCH attestation and Codex regional routing are not ported. OAuth endpoints can change; live account validation is still needed.
- Gemini does not yet replicate OMP's multi-endpoint retry/backoff budget or resolve grounding redirect URLs. Google account eligibility/provisioning error variants may need more fixtures.
- Perplexity API-key transport uses non-streaming Chat Completions, not OMP's optional Responses API. Consumer transport keeps OMP's SSE merge/parser. No native-app session borrowing.
- No custom credential pool rotation/force-refresh-on-401 beyond Pi's normal expiry-based OAuth refresh.
- SearXNG supports common answer text, but not every upstream weather/translation answer plugin shape. No process-lifetime engine shortcut cache.
- No automatic migration of OMP settings files or auth databases.

These are actual gaps, not features claimed complete. The user-facing login/search paths are implemented, but full OMP parity still requires resolving the above and real-account verification.

## Verification

Automated: TypeScript check; fixture tests for every provider, core filters/fallback/abort/timeouts, bounded SSE, OAuth login/refresh and trusted config loading.

Live verified without user-account login:

- Parallel public MCP, Exa public MCP, DuckDuckGo HTML (explicit empty environment).
- Pi extension loader and isolated Pi startup.
- Pi ModelRuntime with a temporary fake Perplexity OAuth credential: OAuth detected, session resolved, API-key path empty.
- Local Chrome launch/navigation/close with a temporary profile.

Not yet live verified: Perplexity SSO/OTP with a real account; Google OAuth with a real account; model-backed search/subscription endpoints; all paid APIs; reliability of the remaining HTML engines across egress networks.
