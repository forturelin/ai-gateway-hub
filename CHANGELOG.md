# Changelog

This is the single release history file for AI-Gateway-Hub. Older duplicate files
(`CHANGE.md` and `CHANGES.md`) were removed to avoid split release notes.

## 1.4.0 - 2026-07-11

### Added

- Rule-level native OpenAI Responses routing for Codex and other Responses API clients.
- Codex `additional_tools` conversion in the Responses-to-Chat fallback path, preserving tool calls for gpt-5.6-compatible upstreams.
- Interactive dependency installation prompt when the control script starts without `node_modules`.
- Technology-focused console styling with clearer provider, mapping, health-check, and routing controls.

### Changed

- Native Responses configuration moved from providers to individual mapping rules.
- API configuration actions now use larger labeled controls and consistent SVG icons.
- Provider model health results show response latency or an explicit failure state.
- Mapping rule controls distinguish the active rule, pinned rule, and available pin action.
- Default mapping context limit is raised to 1,000,000 characters for long sessions.

### Fixed

- Responses API requests carrying Codex tool declarations now return `function_call` output instead of losing tools during fallback conversion.
- Custom tool calls are emitted correctly by the Responses SSE wrapper.
- Custom tool call history survives protocol conversion.
- Imported provider and mapping configuration is reloaded without restarting the service.
- Successful Responses request logs include the actual mapped model name.

## 1.3.0 - 2026-05-20

### Added

- Prompt cache optimization for OpenAI and Anthropic-compatible requests.
- OpenAI native Responses passthrough support for providers that can handle `/responses` directly.
- Cache warmup serialization for same-prefix concurrent requests.
- Cache read/create token tracking in provider stats, usage analytics, and request logs.

### Fixed

- OpenAI cached-token billing avoids charging cache hits as full-price prompt tokens.
- Anthropic cache read and cache creation tokens are counted with Anthropic-specific fields.
- Streaming paths capture usage for billing and logs.

## 1.2.0 - 2026-05-19

### Added

- Cross-LAN host binding support with `127.0.0.1` and `0.0.0.0` modes.
- Firewall helper workflow and loopback dual-bind protection on Windows.

## 1.1.0 - 2026-05-14

### Added

- Time-window routing strategy with pinning, extension, countdown, and active-rule indicators.
- Request-log and usage-dashboard enhancements for provider aliases, reasoning effort, and token details.
- Mapping UI refresh and active-rule controls.

### Fixed

- Backup import reloads provider and mapping caches without restart.
- Request logs display cache-token metrics after index rebuild.

## 1.0.0 - 2026-05-13

### Added

- Initial multi-provider AI gateway with OpenAI and Anthropic protocol conversion.
- Mapping-based local SK authentication, routing strategies, streaming support, usage analytics, request logs, and static Web UI.
