# AGENTS.md

## What this repo is

AI-Gateway-Hub is a Node 18+ ES module service that exposes a local unified gateway for OpenAI-style and Anthropic-style clients, plus a static Web UI. There is no build step, database, TypeScript, or framework bundler: backend code runs directly from `src/`, frontend assets are served directly from `public/`.

## Essential commands

### Install and run

```bash
npm install
npm start
```

`npm start` runs `node src/index.js` in the foreground.

### Service management

```bash
npm run start:bg
npm run stop
npm run restart
npm run status
npm run logs
```

These call `bin/ctl.mjs`, but the `bin/` directory is not present in this checkout even though `package.json` and `README.md` reference it. Verify the scripts actually exist before relying on any background-control or firewall workflow.

### Tests

There is no `npm test` script. The observable test entrypoints are standalone Node test files in the repo root:

```bash
node --test test-cache-anthropic.mjs
node --test test-cache-injection.mjs
node --test test-cache-optimizer.mjs
node --test test-routing-ui.mjs
```

Run targeted files with `node --test <file>`; do not assume a repo-wide scripted test runner exists.

## Architecture

### High-level flow

- `src/index.js` is a minimal bootstrap that calls `startServer()`.
- `src/server.js` creates the Express app, applies JSON parsing and CORS, wires routes, and starts the HTTP server.
- `src/routes/api-routes.js` is the route registry for both gateway endpoints and admin/UI endpoints.
- `src/sk-auth.js` resolves inbound local API keys (`Authorization: Bearer` or `x-api-key`) to a configured mapping.
- `src/gateway-router.js` and `src/route-mappings.js` choose which upstream provider/rule should handle a request.
- Route handlers own protocol conversion and streaming because they control the outgoing HTTP response.

### Runtime data model

The core runtime objects are:

- provider: an upstream credential/config, instantiated as `OpenAIProvider` or `AnthropicProvider`
- mapping: a local exposed endpoint secured by `localSk`
- rule: one row inside a mapping tying `inputModel` to `(providerId, mappedModel)`

Control flow for `/v1/messages`, `/v1/responses`, and `/v1/chat/completions` is:

1. authenticate local SK to a mapping
2. pick up to 3 candidate rules/providers via `buildCandidates()`
3. attempt each provider in order until one succeeds
4. convert protocol/stream shape when client protocol differs from provider protocol
5. record provider stats, usage history, and request logs

### Storage and persistence

All persistent state is file-backed JSON under `CONFIG_DIR`, which defaults to `~/.ai-gateway-hub` and is loaded from `config.json` or `AGH_CONFIG`.

Observed persisted files:

- `api-providers.json`
- `route-mappings.json`
- `pricing.json`
- `settings.json`
- `usage-stats.json`
- `usage-history.json`
- `request-logs/YYYY-MM-DD.jsonl`
- `request-logs/.index.json`

Important: several source comments still mention the old path `~/.proxypool-hub`, but the active code uses `~/.ai-gateway-hub` via `src/config.js`. Trust code, not stale comments.

### Backend module boundaries

- `src/api-providers.js`: in-memory cache + persistence for providers, plus live instance lifecycle
- `src/route-mappings.js`: mapping persistence, local SK uniqueness, strategy selection, pinning/time-window logic
- `src/providers/*.js`: upstream adapters
- `src/providers/format-bridge.js`: protocol translation layer between OpenAI and Anthropic request/response formats
- `src/prompt-cache-utils.js`: prompt-cache key derivation, Anthropic cache breakpoint injection, warmup de-duplication
- `src/request-logger.js`: append-only request/response audit logging plus date index
- `src/usage-tracker.js`: aggregated usage/cost history for dashboard analytics
- `src/routes/*`: HTTP surface area and orchestration
- `src/utils/logger.js`: in-memory evented system logger used by the syslog page/SSE

### Frontend shape

- `public/index.html` is the single-page shell
- `public/js/app.js` contains the Alpine.js state machine for all 8 UI tabs
- `public/js/i18n.js` holds translations
- `public/css/style.css` styles the whole app

There is no frontend compilation step. If UI behavior changes, update raw HTML/CSS/JS directly.

## Non-obvious implementation details

### Route handlers intentionally duplicate some orchestration

`src/gateway-router.js` only returns ordered candidates. The actual forwarding, SSE adaptation, usage extraction, and response writing stay in each route handler (`messages-route.js`, `responses-route.js`, `chat-route.js`). If you try to “centralize” response forwarding, be careful not to break stream ownership.

### Mapping type is not always enforced

`authenticateAndResolve()` supports `expectedType`, but `/v1/messages` and `/v1/responses` deliberately authenticate “any mapping type” and rely on conversion logic later. Do not assume endpoint path and mapping type are always identical.

### `least-used` is not truly least-used today

In `src/route-mappings.js`, `selectRuleForMapping()` groups `least-used` with the cursor-based branch; there is no usage-aware scoring. Treat current behavior as sequential rotation unless you first verify a real least-used implementation was added.

### Native OpenAI Responses passthrough is opt-in per provider

`/v1/responses` only goes straight to upstream `/responses` when a provider has `supportsNativeResponses` enabled. Otherwise the route falls back to Responses -> Chat Completions -> Responses transformation.

This distinction matters for preserving fields like:

- `previous_response_id`
- `store`
- reasoning blocks
- tool-call IDs

### Prompt caching logic is a major cross-cutting concern

Before changing request shaping, read `src/prompt-cache-utils.js` and the cache tests.

Observed behavior:

- OpenAI-compatible upstreams may receive auto-derived `prompt_cache_key` and `prompt_cache_retention`
- unsupported cache-hint errors trigger retries without those fields
- Anthropic requests may get injected `cache_control` breakpoints on system and recent user content
- same-prefix requests can be briefly serialized with `withPromptCacheWarmup()` to avoid duplicate cold-cache misses

Seemingly harmless changes to tool ordering, system prompt structure, or request field placement can change cache-key stability and cost accounting.

### Streaming paths are custom and format-sensitive

The repo manually translates SSE payloads rather than using a shared library.

Examples:

- OpenAI chat SSE -> Responses API SSE in `src/routes/responses-route.js`
- Anthropic JSON -> Anthropic SSE wrapper in `src/routes/messages-route.js`
- native Anthropic SSE tapping in `src/middleware/sse.js`

When editing stream code, preserve both client-visible event framing and side-channel usage extraction for billing/logging.

### Import/backup must reload caches

Provider and mapping managers cache data in memory. `src/routes/settings-route.js` explicitly calls `reloadProviders()` and `reloadMappings()` after backup import so imported data becomes visible without restart. Any future direct file import/migration path must do the same.

### Logging and usage writes are debounced/asynchronous

- request logs are buffered and flushed on timers
- usage stats/history are debounced before disk writes
- process exit/SIGINT/SIGTERM handlers flush these buffers

If a test reads persisted files immediately after a request, it may need to account for delayed flushes.

### Config edits can require restart

`PUT /api/settings` can write `host` back into project-level `config.json`, but `PORT`/`HOST` are imported constants from `src/config.js`. The route returns `needsRestart` when host changes because the current process does not hot-rebind.

### Current checked-in config opens the service to the LAN

Observed root `config.json` sets `"host": "0.0.0.0"`. Combined with firewall rules, this exposes the gateway beyond localhost. Agents should be careful when testing auth/network behavior and should not assume loopback-only defaults.

## Conventions and patterns

### Code style

- ES modules everywhere (`"type": "module"`)
- 4-space indentation in backend JS
- plain functions and classes, no TypeScript/JSDoc-heavy typing
- route modules export named handlers plus a default object
- persistence modules commonly keep module-level caches and expose `reload()`

### Error handling pattern

Common route behavior:

- return `404` for “no mapping rule matches model”
- iterate multiple providers and only surface `503` after all candidates fail
- mark provider rate-limit state on upstream `429`
- log upstream response text snippets for non-OK responses

### Security-sensitive patterns

- local gateway auth is mapping-based, not provider-based
- `localSk` must be unique across mappings
- provider `apiKey` is masked in safe JSON but persisted in config storage
- config/log directories are created with restrictive modes where supported

## Testing guidance

### What is actually covered

Observed tests focus on:

- prompt cache key derivation/injection/warmup behavior
- cost math for cache-aware billing
- mapping rule selection and pin/time-window UI wiring
- source-level regression checks by reading files as text

This means many tests are brittle-by-design string assertions. If you refactor function names, literal snippets, or UI hook names, update tests accordingly.

### How to test safely

Prefer targeted runs first:

```bash
node --test test-cache-optimizer.mjs
node --test test-routing-ui.mjs
```

Then run the other root test files if your changes touch conversion, caching, or routing.

## Repo gotchas

- `package.json` references `bin/cli.js`, and npm scripts/readme reference `bin/ctl.mjs` and firewall/setup scripts, but no `bin/` files are present in this checkout.
- `docs/` exists but is empty.
- `view` failed on `src/providers/format-bridge.js` with invalid UTF-8, so be cautious editing that file; verify encoding first if you need to touch it.
- Comments in several modules still reference the old project name/path `proxypool-hub`; treat those as stale unless code matches them.
- CORS allowlist is localhost/127.0.0.1-centric in `src/server.js` even though runtime host may be `0.0.0.0`.

## Good starting points for future work

- protocol/routing bugs: start with `src/routes/messages-route.js`, `src/routes/responses-route.js`, `src/routes/chat-route.js`, `src/gateway-router.js`, `src/route-mappings.js`
- provider config issues: start with `src/api-providers.js`, `src/providers/openai.js`, `src/providers/anthropic.js`
- cache/cost issues: start with `src/prompt-cache-utils.js`, `src/pricing-registry.js`, `test-cache-optimizer.mjs`
- dashboard/logging issues: start with `src/request-logger.js`, `src/usage-tracker.js`, `src/routes/usage-route.js`, `public/js/app.js`
- settings/network/import issues: start with `src/routes/settings-route.js`, `src/config.js`, root `config.json`
