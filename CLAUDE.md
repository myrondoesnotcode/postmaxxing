# postmaxx_

CLI + web UI that reads coding session transcripts (Claude Code, opencode, Codex) and generates building-in-public posts for X/Twitter. Surfaces the **reasoning** behind decisions — not changelogs, not hype.

## Quick start

```bash
# Requires ANTHROPIC_API_KEY — place in .env, ~/.postmaxxing/config, or any parent .env
node postmaxx.js --ui                         # open web UI (recommended)
node postmaxx.js                              # most recent session, story mode, terminal
node postmaxx.js --mode technical             # engineering reasoning lens
node postmaxx.js --list                       # interactive session picker
node postmaxx.js --project clipmatic          # filter by project name
node postmaxx.js --days 7                     # look back N days
node postmaxx.js --count 3                    # number of candidates to generate
node postmaxx.js --context "text"             # one-line manual hint prepended to session
node postmaxx.js --style ~/tweets.json        # match voice from X archive
node postmaxx.js --push                       # send approved drafts to Typefully
```

## Architecture

Single file (`postmaxx.js`), zero dependencies, vanilla Node.js (18+).

**Two-stage pipeline:** discover sessions → pre-gate → parse + chunk → Stage 1 (Haiku: extract reasoning) → Stage 2 (Sonnet/model: generate candidates) → display → optionally push to Typefully + record approvals to state.

### Stage 1 — Extract (always Haiku)
Reads the session transcript and project state. Returns structured JSON: decisions made, why, numbers involved, what was wrong, quotable lines. Returns `best_output_type: "nothing"` and exits cleanly if no reasoning found.

### Stage 2 — Generate (Sonnet by default; Haiku/Opus selectable in UI)
Takes the Stage 1 JSON — not the raw session. This is the hallucination firewall. Generates N candidates using mode-specific prompts. Each candidate self-selects its shape (single tweet or thread).

### Output types
The model picks one of: **story** (self-contained reasoning), **continuation** (references an active arc), **drip** (small update), or nothing (exits cleanly).

### Project state
`~/.postmaxxing/state/<project-slug>.json` — tracks active arcs and recent posts. Updated only when posts are approved for Typefully push (rejected drafts don't pollute history).

## Session sources

| Source | How discovered | Parser |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | Direct JSONL parse |
| opencode | `opencode session list --json` + `opencode session export <id>` | Shells to CLI |
| Codex | `~/.codex/sessions/**/*.jsonl` | Direct JSONL parse (event format) |

All three sources are optional — sources not installed are silently skipped. The UI shows source tabs (CC / OC / CX) only for sources that have sessions.

Content format differences handled by `extractContent()`:
- Claude Code: `{ type: 'text', text }` blocks
- Codex: `{ type: 'input_text'|'output_text', text }` blocks

## Modes

| Flag | What it does |
|---|---|
| `--mode story` (default) | Product/business reasoning lens |
| `--mode technical` | Engineering lens — stack choices, trade-offs, patterns |

Story and technical modes use **separate prompt constants** (`VOICE_RULES` vs `TECHNICAL_VOICE_RULES`, etc.) so the outputs are genuinely different registers.

## Web UI (`--ui`)

Serves an embedded SPA at `http://127.0.0.1:3000` (bound to IPv4 loopback — avoids macOS IPv6/localhost resolution issues).

UI features:
- Session list with source badges, age, size, and excerpt preview
- Source tab filter (ALL / CC / OC / CX) — client-side, no extra API call
- Model picker (Haiku ~$0.001 / Sonnet ~$0.003 / Opus ~$0.015 per run)
- Context textarea persisted in localStorage
- Preview panel on session select
- Per-candidate regenerate
- Copy and post buttons

API routes: `GET /api/sessions`, `POST /api/generate`, `GET /api/preview`, `POST /api/push`.

## Conventions

- **Zero external dependencies.** Node.js built-ins + native fetch only. Keep it this way.
- **Single-file tool.** All logic in `postmaxx.js`. The HTML_APP const is the embedded SPA.
- **Plain JavaScript.** No TypeScript, no transpilation.
- **Runs directly** via `node postmaxx.js` or as executable (shebang line).
- **Named functions**, not classes.
- **Minimal error handling** — `die()` for fatal, `warn()` for non-fatal.
- **CLI args** parsed manually with `getArg`/`hasFlag`.

## Tests

```bash
node --test tests/*.test.js                 # all 60 tests
node --test tests/smoke.test.js             # end-to-end pipeline
node --test tests/state.test.js             # state management
node --test tests/gate.test.js              # pre-gate quality checks
node --test tests/extract.test.js           # Stage 1 extraction
node --test tests/generate.test.js          # Stage 2 generation prompts
node --test tests/ui.test.js                # HTTP server + API routes
```

60 tests, zero npm dependencies.

## Environment variables

Loaded from `~/.postmaxxing/config` first, then walks up from `__dirname` looking for `.env` (handles running from git worktrees where `.env` is in the repo root, not the worktree).

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `TYPEFULLY_API_KEY` | No | For `--push` to Typefully |
| `CLAUDE_PROJECTS_DIR` | No | Override default `~/.claude/projects` |

## Key constants

- `MIN_SESSION_BYTES = 5120` — Claude Code sessions must be ≥5KB
- `MIN_SESSION_LINES = 8` — Claude Code sessions must have ≥8 lines
- `MAX_CHARS = 12000` — session chunk limit for Stage 1 prompt
- `HAIKU_MODEL = 'claude-haiku-4-5'` — Stage 1 (always)
- `SONNET_MODEL = 'claude-sonnet-4-6'` — Stage 2 default
- `OPUS_MODEL = 'claude-opus-4-7'` — Stage 2 optional (selectable in UI)

## What good output looks like

A tweet is good if the author would post it without editing. Specific, honest, sounds like a real person who just finished a coding session — not a changelog, not a press release. Every claim traces back to something the user actually said.

## Deferred

- LinkedIn generation
- Git diff signal (`--git`)
- Voice archetypes
- Multi-user hosted product
