# pi-web-search

Port [oh-my-pi web search](https://github.com/can1357/oh-my-pi) sang **Pi coding agent**, chạy Node.js, không phụ thuộc runtime/database của OMP.

- Tool `web_search`, command `/web-search`, config theo user/project.
- **25 backend ID** của OMP, gồm search APIs, hosted model search, HTML engines và Public Web aggregate.
- **`/login perplexity`**: browser SSO hoặc email OTP/TOTP; dùng session subscription, không yêu cầu API key riêng.
- `/login google-gemini-cli`, `/login google-antigravity`; reuse login có sẵn của Pi cho Anthropic/Codex/xAI.
- Query operators, native filters, sequential fallback, timeout/cancel, bounded JSON/SSE và output truncation.

**Đây là port chức năng trên API Pi, không phải nhúng nguyên OMP.** Tất cả backend đã có implementation và fixture tests; không đồng nghĩa mọi endpoint/account đã được kiểm chứng live. Những khác biệt còn lại được ghi trong [PORTING.md](PORTING.md).

## Cài đặt

Yêu cầu Node.js **22.19+**, Pi `@earendil-works/pi-coding-agent` hiện hành (đã kiểm tra 0.87.1).

```bash
cd /path/to/pi-web-search
npm ci --ignore-scripts

# Thử một phiên, không thay đổi settings:
pi -e ./src/extension.ts

# Hoặc cài package local:
pi install /absolute/path/to/pi-web-search
```

Mở lại Pi hoặc `/reload`. Chưa publish package này lên npm; không dùng `pi install npm:pi-web-search` để cài repo này vì tên đó có thể trùng package khác. Pi cũ `@mariozechner/pi-coding-agent` chưa được kiểm tra.

## Login Perplexity

Trong Pi đã load extension:

```text
/login perplexity
```

1. Chọn phương thức OAuth nếu Pi hỏi.
2. Nhập `sso` hoặc để trống để mở browser. Muốn OTP, nhập thẳng địa chỉ email (hoặc gõ chữ `email`, rồi nhập địa chỉ ở bước tiếp theo).
3. Đăng nhập trong cửa sổ Chrome riêng; chọn SSO nếu tài khoản tổ chức yêu cầu.
4. Extension lấy session cookie của **cửa sổ đó**, xác thực với Perplexity, rồi trả credential cho Pi lưu vào `auth.json`.
5. Pin provider để tránh fallback sang dịch vụ khác:

```bash
pi -e ./src/extension.ts --web-search-provider perplexity
```

Hoặc gọi tool với `provider: "perplexity"`. `/web-search` hiển thị session/config đã nhận, không hiển thị token. `/logout perplexity` xóa credential lưu trong Pi.

### Browser / headless

- Cần Chrome/Chromium cài sẵn. Tự tìm đường dẫn thông thường trên macOS/Linux/Windows.
- Đường dẫn khác: `PI_WEB_SEARCH_BROWSER_PATH=/path/to/chrome` (hoặc `PUPPETEER_EXECUTABLE_PATH`).
- Profile tạm độc lập, không dùng profile browser thường, không đọc Keychain/macOS app của bạn.
- Sandbox và TLS checks giữ nguyên. Không tải browser tự động.
- Login timeout 5 phút. Đóng cửa sổ hoặc cancel trong Pi để dừng; profile được dọn sau đó.
- Máy không có GUI: chọn **`email`** thay cho `sso`, nhập email → code email → code authenticator nếu có.
- Browser SSO là flow local, không phù hợp RPC/headless; dùng email flow ở các môi trường đó.
- Session hết hạn/bị thu hồi: `/login perplexity` lại. Không tự đổi session lỗi thành anonymous hoặc API billing nếu không có auth khác được cấu hình.

Perplexity consumer endpoints là API nội bộ của dịch vụ, có thể đổi hoặc bị chặn. SSO/OTP đã có test mocked; chưa xác nhận bằng một tài khoản thật trong phiên phát triển này.

### API-key Perplexity

```bash
export PERPLEXITY_API_KEY='...'
```

Đây là API tính phí riêng, **không phải** gói Pro/Enterprise. Thứ tự auth: `PERPLEXITY_COOKIES` → Pi session → direct API key → OpenRouter (chỉ explicit selection). Nếu không có auth và chọn Perplexity explicit, thử anonymous consumer search.

Model subscription mặc định `experimental`, đổi bằng `PI_PERPLEXITY_MODEL`. API mặc định `sonar-pro`, đổi bằng `PI_PERPLEXITY_API_MODEL`. Khi truyền `model` trực tiếp cho tool, giá trị được dùng cho đường auth đang chạy; tránh dùng ID của API cho subscription.

## Các provider

| Provider | Auth / cấu hình | Transport |
|---|---|---|
| `parallel` | `PARALLEL_API_KEY`, `/login parallel`, hoặc keyless | REST / public MCP |
| `perplexity` | `/login perplexity`, `PERPLEXITY_API_KEY`, `PERPLEXITY_COOKIES` | Consumer SSE / Sonar API |
| `gemini` | `GEMINI_API_KEY`, `/login google`, `/login google-gemini-cli`, `/login google-antigravity` | Google grounding / Cloud Code Assist SSE |
| `anthropic` | `/login anthropic`, `ANTHROPIC_SEARCH_API_KEY`, `ANTHROPIC_API_KEY` | Messages hosted web search |
| `codex` | `/login openai-codex` | Codex Responses SSE; phải có web search event |
| `xai` | `/login xai`, `XAI_API_KEY` | Responses hosted web search |
| `openrouter` | `/login openrouter`, `OPENROUTER_API_KEY` | Chat completions + web plugin |
| `zai` | `/login zai`, `ZAI_API_KEY` | Stateful MCP initialize + tools/call |
| `exa` | `/login exa`, `EXA_API_KEY`, hoặc keyless | REST / public MCP |
| `tinyfish` | `/login tinyfish`, `TINYFISH_API_KEY` | Search API + pagination |
| `jina` | `/login jina`, `JINA_API_KEY` | Jina Search |
| `kagi` | `/login kagi`, `KAGI_API_KEY` | Kagi V1 Search API |
| `tavily` | `/login tavily`, `TAVILY_API_KEY` | Search API |
| `firecrawl` | `/login firecrawl`, `FIRECRAWL_API_KEY`, hoặc keyless | V2 search |
| `brave` | `/login brave`, `BRAVE_API_KEY` | Search API |
| `kimi` | `/login kimi-coding`, `KIMI_SEARCH_API_KEY`, `MOONSHOT_SEARCH_API_KEY`, `KIMI_API_KEY` | Kimi Code search, **không dùng MOONSHOT_API_KEY** |
| `synthetic` | `/login synthetic`, `SYNTHETIC_API_KEY` | Search API |
| `ollama` | `/login ollama-cloud`, `OLLAMA_CLOUD_API_KEY` | Hosted search, không phải Ollama local |
| `searxng` | `SEARXNG_ENDPOINT` | Self-hosted JSON search |
| `startpage` | Không key | Homepage token + HTML search |
| `duckduckgo` | Không key | HTML search + pagination |
| `ecosia` | Không key | HTML; fallback Chrome |
| `google` | Không key | HTML; fallback Chrome |
| `mojeek` | Không key | HTML; fallback Chrome |
| `public` | Không key, **explicit-only** | Fan-out 5 HTML engines, dedup + consensus ranking |

Model-backed APIs có thể tiêu API credits/subscription quota. Pi sở hữu lưu trữ và refresh OAuth; extension không mở auth store riêng. Các biến search-key ưu tiên hơn auth Pi. Token usage được trả về Pi; **chi phí dollar để 0/không ước tính**, vì phí search không chỉ phụ thuộc token.

### Google OAuth

```text
/login google-gemini-cli
/login google-antigravity
```

Mở URL Google, OAuth PKCE + callback state validation, discover/provision Cloud Code Assist project. Một số tài khoản cần `GOOGLE_CLOUD_PROJECT` hoặc `GOOGLE_CLOUD_PROJECT_ID`.

Máy remote: khởi động với `PI_WEB_SEARCH_OAUTH_MANUAL=1` để paste callback URL đầy đủ. Callback ports: Gemini CLI 8085, Antigravity 51121. OAuth app IDs/public-client configuration được port từ OMP; Google có thể thay đổi quyền truy cập/điều khoản. Không đảm bảo mọi loại tài khoản được cấp quyền.

### Search-engine cấu hình thêm

- Firecrawl self-hosted: `FIRECRAWL_BASE_URL` hoặc `FIRECRAWL_API_URL` (endpoint V2).
- Kimi endpoint: `KIMI_SEARCH_BASE_URL` hoặc `MOONSHOT_SEARCH_BASE_URL`.
- SearXNG: `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`, hoặc `SEARXNG_BASIC_USERNAME` + `SEARXNG_BASIC_PASSWORD` (Basic ưu tiên); `SEARXNG_CATEGORIES`, `SEARXNG_LANGUAGE`, `SEARXNG_ENGINES`, `SEARXNG_SAFESEARCH`. Instance phải bật JSON format. Engine shortcuts được resolve qua `/config`.
- Exa pacing: `PI_WEB_SEARCH_EXA_DELAY_MS`, mặc định 1000 ms, `0` tắt.
- HTML browser fallback: mặc định bật nếu cần; `PI_WEB_SEARCH_BROWSER=0` tắt. Không tác động browser login chủ động. Không có stealth patches của OMP; challenge có thể vẫn thất bại.

## Provider chain / model configuration

Mặc định `auto`: thử các provider đã cấu hình theo thứ tự bảng trên (bỏ qua HTML/public), rồi Parallel → Exa → Startpage → DuckDuckGo → Ecosia → Google → Mojeek. Không gọi lại provider đã thất bại. Public aggregate chỉ chạy khi chọn rõ.

```bash
# Pin một provider, không fallback:
pi -e ./src/extension.ts --web-search-provider perplexity

# Chain tuần tự:
PI_WEB_SEARCH_PROVIDER=perplexity,exa,duckduckgo pi -e ./src/extension.ts

# Timeout từng provider: default 60s, cap 300s:
PI_WEB_SEARCH_TIMEOUT=90 pi -e ./src/extension.ts
```

Config persistent tại `~/.pi/agent/web-search.json` (hoặc `$PI_CODING_AGENT_DIR/web-search.json`):

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

Project override `.pi/web-search.json` chỉ được đọc **khi project đã trusted**. `models` merge, arrays replace. Config đọc lại mỗi lần gọi; không cần reload. CLI flag → env chain → config → auto. Timeout env ưu tiên config. `providers: []` hoặc exclude hết chain vô hiệu hóa search. `exclude` vẫn có hiệu lực khi model pin provider.

Model ID: tool `model` → config `models` → `PI_WEB_SEARCH_<PROVIDER>_MODEL` → mặc định. Với Gemini có thể dùng `google/...`, `google-gemini-cli/...`, `google-antigravity/...` để chọn auth path; không prefix thì thử auth có sẵn. Đây không phải fuzzy model-role resolution của OMP.

## Giao diện TUI

`web_search` có renderer riêng trong Pi TUI:

- Dòng gọi: `◎ Web Search “query”` kèm chip provider/recency/số kết quả/model.
- Đang chạy: `⋯ Searching the web…`.
- Thu gọn: provider · model · số nguồn · thời gian · auth, provider fallback bị bỏ qua (`↷`), ghi chú lọc, 2 dòng answer, top 3 nguồn kèm domain.
- Mở rộng (`ctrl+o`, theo keybinding `app.tools.expand`): answer đầy đủ, toàn bộ nguồn với URL/ngày/snippet, citations, related, queries.
- Lỗi: `✗ Search failed` với từng provider trên một dòng.
- Tiêu đề/URL là OSC 8 hyperlink khi terminal hỗ trợ; màu theo theme Pi; mọi dòng giới hạn theo độ rộng terminal (có tính ký tự rộng/emoji); ký tự điều khiển từ web bị loại bỏ.

Xem trước không cần Pi: `npx tsx scripts/preview.ts 100` (`PI_THEME=light` để đổi theme).

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

- `query`: 1–10.000 ký tự, không chỉ whitespace.
- `provider`: `auto` hoặc một ID trong bảng; ID cụ thể thay toàn chain.
- `limit`: mặc định 10, 1–40; backend có thể trả ít hơn.
- `num_search_results`: OMP-compatible breadth/count, ưu tiên `limit`.
- `recency`: `day|week|month|year`; backend không hỗ trợ sẽ bỏ qua.
- `model`: ID cho model-backed search.
- `max_tokens`: 1–32768; chỉ model-backed transports hỗ trợ, Codex bỏ qua.
- `temperature`: 0–1; backend hỗ trợ mới gửi; Anthropic/Codex bỏ qua.

Parser OMP hỗ trợ `site:`, `-site:`, date bounds, `inurl:`, `intitle:`, `filetype:`, quoted phrases, exclusions, `OR`, language directives. Native mapping theo provider + lenient post-filter: điều kiện loại hết nguồn được nới với `Note:`. **Đây không phải strict/security filtering**; answer/citations không bị viết lại khi lọc sources.

Text có provider, answer nếu có, nguồn + snippet tối đa 240 ký tự. `details` chứa response, notes, failures, model/usage, fullOutputPath nếu truncated. Quá 2.000 dòng/50 KiB: lưu toàn văn tại temp file mode 0600, cho agent đọc lại; file được giữ tới khi bạn dọn temp.

Lỗi/empty/timeout → fallback. Cancel → dừng, không fallback. Hết chain → throw để Pi đánh dấu tool failed. Byte cap response 2 MiB. Public aggregate soft deadline 5s/hard 30s. Không fetch tự động các URL nguồn.

## Riêng tư và an toàn

- Query gửi tới từng dịch vụ được thử; Public Web gửi tới 5 engines. Pin provider nếu không muốn chia sẻ query cho fallback.
- Không gửi transcript, file hay Pi session ID/model metadata tới public MCP.
- API credentials chỉ gửi tới endpoint của backend (hoặc endpoint self-hosted do bạn cấu hình). OAuth refresh do Pi quản lý.
- Browser login chỉ bắt session cookie của cửa sổ tạm được mở chủ động; không mượn desktop app session.
- Tất cả output web là dữ liệu không đáng tin, không phải chỉ dẫn. Chỉ giữ source URLs HTTP(S).
- Không tự login, cài extension, sửa settings hoặc mở browser lúc load. Browser chỉ chạy trong login/search khi cần.
- Extension có full permissions như mọi Pi extension; chỉ cài source bạn tin tưởng.

## Phát triển / kiểm tra

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:live -- parallel 'Pi coding agent documentation'
npm pack --dry-run
```

Tests mặc định không dùng mạng: query, native filters, envelopes, OAuth callback/refresh/session segregation, Perplexity OTP/TOTP, SSE, browser-independent HTML fixtures, public ranking, config trust, timeout/cancel, truncation.

Live đã kiểm tra Parallel/Exa/DDG keyless, Pi loader/runtime với auth store tạm và Chrome lifecycle. Chưa kiểm tra login subscription bằng tài khoản thật hay toàn bộ paid APIs. Xem [PORTING.md](PORTING.md) trước khi coi bản port tương đương OMP.

Upstream pin: `b1a8b875cf81ec2fdc3cc397a2d4b6a9a777543d`. MIT, xem [NOTICE](NOTICE) / [LICENSE](LICENSE).
