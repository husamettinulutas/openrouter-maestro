# Changelog

All notable changes to **OpenRouter Maestro** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] — First public release

Run any OpenRouter model in **GitHub Copilot Chat**, **Claude Code** and **OpenAI Codex**, from one panel.

- **Browse 500+ models** with live pricing, capability badges, context and max-output limits; search, filter by vision / tools / free, and sort by price or context.
- **Copilot Chat** — a native language-model provider: agent-mode tool calling, vision, thinking display, prompt caching, base64 guardrail sanitization, retry/backoff and a token-cost status bar. Enable as many models as you like at once.
- **Claude Code** — manages the `env` block in its own settings against OpenRouter's native Anthropic-compatible endpoint. No proxy, no Anthropic login.
- **Codex** — manages an `openrouter` provider plus the model selection in `~/.codex/config.toml`, semantically, preserving the rest of the file byte-for-byte. No ChatGPT sign-in.
- **A saved model list per agent.** Keep as many models as you like; activate one at a time for Claude Code and Codex, and switch back to the agent's own model whenever you want.
- **Reversible by design** — a one-time backup, a snapshot of exactly the keys that get touched, and an exact restore. Your API key lives in VS Code SecretStorage.

The entries below are the development history leading up to this release.

## [0.3.4]

- **All Maestro traffic now reports as one app on the OpenRouter dashboard.** Requests carry `HTTP-Referer: https://github.com/husamettinulutas/openrouter-maestro` and `X-OpenRouter-Title: OpenRouter Maestro`, so Activity → Apps shows a single named entry linking to the repo instead of unattributed usage.
  - Copilot requests and catalog syncs send the headers directly.
  - Claude Code gets them through `ANTHROPIC_CUSTOM_HEADERS`.
  - Codex gets them through `[model_providers.openrouter.http_headers]`.
- The app name and URL now live in one module (`src/utils/branding.ts`), so they cannot drift apart between the four places that send them.
- The catalog request no longer reports a hardcoded `0.1.0` user agent; it reads the real extension version.

## [0.3.3]

- Screenshots and a rewritten README for the Marketplace listing.
- Free models now read `Input: Free` instead of `Free/M`.
- The green "this agent is live" tab badge keeps its colour on the selected tab.

## [0.3.2]

- **All three agent tabs now render the same model card.** Claude Code and Codex entries show exactly what Copilot's did: capability badges, input/output price per million tokens, context window and max output.
- Each card carries **Activate** (or a green `✓ ACTIVE` marker) and a **Remove from Claude Code / Remove from Codex** button — the old `✕` icon is gone.
- Clicking a card no longer activates it; only the buttons act, so a model can't be swapped by a stray click.

## [0.3.1]

- **"I switched to the default but the agent still answers as the old model."** Both agents read their config *at start-up*, so a running session keeps it. Every activate/deactivate now shows a **Restart needed** banner with a **Reload Window** button, and notes that a CLI in a terminal must be restarted separately.
- Switching Codex back to its own model now also removes the `OPENROUTER_API_KEY` user environment variable (or restores its previous value) — no live API key is left behind after a restore.
- Stopped writing `model_supports_reasoning_summaries`: the key no longer exists in Codex 26.x. It is still stripped from configs written by earlier versions.
- Documented, with measurements, why Codex hides thinking steps for most OpenRouter models — see the README.

## [0.3.0]

- **Per-agent model lists.** Claude Code and Codex each keep a saved list, like Copilot: adding a model no longer replaces the previous one.
- Being in a list writes nothing to disk — only **Activate** touches an agent's config.
- A default entry at the end of each list puts the agent back on its own provider while keeping the list.
- Removing the active model restores the agent's defaults first.
- A model activated from the command palette (or wired in by an older version) is adopted into the list automatically, so the list can never disagree with the config on disk.

## [0.2.3]

- Writes `CLAUDE_CODE_MAX_OUTPUT_TOKENS` so OpenRouter's pre-flight credit reservation stays small — large defaults could fail with HTTP 402 even when the request itself was affordable.

## [0.2.2]

- **Fixed rolling-alias model ids.** Ids such as `~deepseek/deepseek-v4-flash-latest` legitimately start with `~`; 0.2.1 stripped the tilde and broke every apply that used one. Ids are now validated and written verbatim.
- Codex: writes the reasoning keys (`show_raw_agent_reasoning`, `model_reasoning_effort`, `model_reasoning_summary`) for reasoning-capable models.
- Claude Code: adds `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, plus context and auto-compact limits derived from the model's real metadata.

## [0.2.1]

- Never enables `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`: models picked from Claude Code's own `/model` list persist as a top-level `model` key that silently shadows the selection and goes stale.
- UI and README warn that uninstalling the extension does not undo agent configs.

## [0.2.0]

- **Claude Code integration** — manages the `env` block in Claude Code's settings against OpenRouter's native Anthropic-compatible endpoint, with a one-time backup and exact restore.
- **Codex integration** — manages a `[model_providers.openrouter]` section plus the top-level model selection in `~/.codex/config.toml`, semantically (never comment-based), preserving everything else byte-for-byte.
- Agent tabs with live status, and per-agent buttons on every model card.

## [0.1.0]

- Initial release: native OpenRouter provider for GitHub Copilot Chat, with catalog browsing, filters, pricing, tool calling, vision, reasoning display, prompt caching and a token/cost status bar.
