# Changelog

All notable changes to **OpenRouter Maestro** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.3.1]

- **Web fetch works while you are signed in without a Copilot plan.** Models often picked Copilot's own `fetch_webpage` tool, which fails with *"Your subscription has ended"* for a signed-in account whose plan has lapsed, so signing out of GitHub was the only fix. When **Fetch Web Page (Maestro)** is available, Copilot's fetch tool is now left out of requests to Maestro's models. Turn this off with `openrouterMaestro.replaceCopilotFetch`.
- **The utility model offer appears once.** It used to come back in every window and every new project until you clicked **Don't ask again**, because a notification closed or left unanswered did not count. It is now shown once per install, and only once you use Maestro's models in Copilot. **OpenRouter Maestro: Choose Utility Model for Copilot** sets it any time.

## [1.3.0]

**Copilot without a Copilot subscription.** Several Copilot features call GitHub's own services and fail, or are missing, without a paid plan. Maestro now provides each of them through OpenRouter. These changes come from OpenRouter Copilot Model Manager 1.2.1–1.3.0; the README has a table of what is covered.

- **Web fetch.** A **Fetch Web Page (Maestro)** tool (`#maestroFetch`) reads pages itself. Copilot's own fetch fails with *"Your subscription has ended"* once a plan has lapsed.
- **Web search.** **OpenRouter Maestro: Toggle Web Search** lets Copilot models that call tools search the web through OpenRouter, with the sources listed under the answer. Exa by default (about $0.007 per search); Parallel is cheaper but returned results months old in tests. If a provider refuses web search, the request goes through without it.
- **Semantic code search.** A **Codebase Search (Maestro)** tool (`#maestroCodebase`) finds code by meaning, which Copilot's `#codebase` no longer offers to OpenRouter models. It asks before the first index, keeps the index on your machine and never sends `.env` or key files.
- **Chat titles, commit messages and edit repair.** **OpenRouter Maestro: Choose Utility Model for Copilot** points Copilot's utility models at a small OpenRouter model. Maestro offers this once and never replaces a utility model you chose yourself without asking.
- **Inline suggestions.** **OpenRouter Maestro: Toggle Inline Completions** turns on ghost-text suggestions from an OpenRouter model (Codestral by default). Off by default: every suggestion is a paid request.
- **See which model answered.** With a router such as `openrouter/auto`, the status bar names the model that answered and its provider, and the cost shown is the one OpenRouter billed.
- **Routers show "Varies"** instead of a broken negative price, and sort last by price.
- **Tool results reach the model intact.** Structured (prompt-tsx) tool output no longer arrives as `[object Object]`, and images returned by tools go to vision models.
- **API key from the environment.** When no key is stored, Maestro uses `OPENROUTER_API_KEY`.
- Claude Code and Codex are unchanged: their own web search and fetch already work through OpenRouter as Maestro configures them.

## [1.2.1]

- Ships the 1.2.0 redesign together with the 1.1.1 fixes: 402 auto-recovery on a low balance, the `openrouterMaestro.claudeCode.maxOutputTokens` and `openrouterMaestro.enableStreamUsage` settings, tool-argument validation and the 900K `maxInputTokens` clamp. No other changes.

## [1.2.0]

**A redesigned panel.** The Model Browser was rebuilt from scratch. Every feature and the extension's message protocol stay the same; only the webview changed.

- **The panel follows your VS Code theme.** It now works in light themes too; before, it was always dark. Surfaces, text and focus rings are derived from the active theme, and high-contrast themes drop the glows and gradients.
- **See what every agent is running from any tab.** The tab bar is now an agent dock that stays on screen. Each tile shows the agent's state: `3 live` for Copilot, the active model for Claude Code and Codex, or `Default`, `Reload` and `Missing`. In wider panels the tiles also list the live model names.
- **New model cards.** Each card has a provider monogram, labeled capability chips (Vision, Tools, Reasoning, Image Out) styled like the filter chips, and a metric strip with input and output price per million tokens, context window and max output. Small log-scaled meters under each value let you compare models while scanning.
- **Clearer agent buttons.** On each card the Copilot / Claude Code / Codex buttons form one group with three states: add, in list, and running. In wider panels they spell out `In Copilot` or `Running in Claude Code`.
- **Reworked Claude Code and Codex tabs:**
  - A **Now running** card shows the active model, its price and limits, and a context ring.
  - **Activate** buttons use the agent's color.
  - The "own model" default row and the restart banner are kept.
- **Saved models show the same metric strip as Browse cards** on all three agent tabs: input and output price, context and max output, each with its meter. Removing a model is a clearly marked red trash button.
- **A single title for the sidebar.** The view header reads just *OpenRouter Maestro* instead of *OpenRouter Maestro: Model Browser*. Its duplicate refresh button is gone; sync from the panel's own header or the `OpenRouter Maestro: Sync Models from API` command.
- **Copilot tab:**
  - **Thinking effort** is a segmented control that wraps on narrow panels.
  - Wide panels use two columns.
- **Search and filters:**
  - Press `/` to focus search.
  - The provider menu shows readable names (`Meta` instead of `meta-llama`) and supports the keyboard.
  - Sort is a compact menu button.
- **Works in a narrow sidebar.** Nothing clips or wraps at 300px.
- **Keyboard and screen readers:**
  - Arrow keys move between tabs.
  - Every control has a visible focus ring.
  - Icon-only buttons and dock tiles have full labels.
  - Click targets are at least 24px.
  - Text meets WCAG AA contrast in both Dark Modern and Light Modern.
- **Icons are inline SVG** instead of emoji, so they look the same on every platform.
- **Calmer feedback:**
  - Only one toast shows at a time, and it no longer covers the control you just pressed. You can dismiss it with a click or Escape.
  - Loading animations stop when hidden, and every animation respects *reduce motion*.

## [1.1.1]

- **HTTP 402 on a low balance is now recovered automatically.** OpenRouter reserves `max_tokens × completion price` before generating anything, and defaults that reservation to the model's full output limit when no `max_tokens` is sent — so a small balance is rejected before a single token is spent. Copilot requests that hit this now parse the affordable budget out of the 402 body and retry once with a `max_tokens` that fits; the error is only surfaced if that retry also fails.
- New `openrouterMaestro.claudeCode.maxOutputTokens` setting (default `32000`) to lower the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` ceiling for the same reason — Claude Code cannot refit its own request the way the Copilot provider can.
- New `openrouterMaestro.enableStreamUsage` setting to turn off `stream_options.include_usage`, which some backend providers reject with an `invalid_json` error.
- Tool call arguments are validated as JSON before being sent, so a malformed argument string from VS Code can no longer make the whole request body unparseable.
- `maxInputTokens` is now clamped to 900K. Million-token models previously reported their full window, so VS Code never triggered compaction and request bodies grew until the backend rejected them.

## [1.1.0]

- **Thinking effort control for Copilot.** Reasoning models now expose a **Thinking Effort** submenu in the Copilot model picker; the chosen value is sent to OpenRouter as `reasoning.effort`. Previously reasoning output was displayed but never controlled.
- Per-model effort default on the Copilot tab card, plus a global `openrouterMaestro.defaultReasoningEffort` fallback.
- New 🧠 **Reasoning** filter chip in the Browse tab.
- Model-picker tooltips now list each model's real capabilities (tools / vision / thinking efforts).
- Effort support is read from OpenRouter's catalog metadata only — never guessed from the model id.
- Model cache version bumped to `2`; the old cache is discarded once so reasoning metadata is picked up.

Adapted from [@Irvingouj](https://github.com/Irvingouj)'s fork of the predecessor project, without enabling proposed APIs.

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
