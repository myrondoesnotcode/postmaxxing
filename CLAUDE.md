# postmaxx_

CLI tool that reads Claude Code session transcripts and generates building-in-public posts for X/Twitter. Surfaces the **reasoning** behind code decisions — not changelogs, not hype.

## Quick start

```bash
# Requires .env with ANTHROPIC_API_KEY (and optionally TYPEFULLY_API_KEY)
node postmaxx.js                              # most recent session, story mode
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

**Two-stage pipeline:** discover sessions → pre-gate → parse + chunk → Stage 1 (Haiku: extract reasoning) → Stage 2 (Sonnet: generate candidates) → display → optionally push to Typefully + record approvals to state.

### Stage 1 — Extract (Haiku)
Reads the session transcript and project state. Returns structured JSON: what decisions were made, why, what numbers were involved, what was wrong about, quotable lines. If the session has no reasoning, returns `best_output_type: "nothing"` and the tool exits cleanly.

### Stage 2 — Generate (Sonnet)
Takes the Stage 1 JSON (not the raw session — this is the hallucination firewall). Generates N candidates using mode-specific prompts. Each candidate self-selects its shape (single tweet or thread) based on what the material supports.

### Output types
The model picks one of: **story** (self-contained reasoning), **continuation** (references an active arc), **drip** (small update), or nothing (exits cleanly).

### Project state
`~/.postmaxxing/state/<project-slug>.json` — tracks active arcs and recent posts. Updated only when posts are approved for Typefully push (so rejected drafts don't pollute history).

## Modes

| Flag | What it does |
|---|---|
| `--mode story` (default) | Product/business reasoning lens |
| `--mode technical` | Engineering lens — stack choices, trade-offs, patterns |

## Conventions

- **Zero external dependencies.** Uses only Node.js built-ins + native fetch. No package.json. Keep it this way.
- **Single-file tool.** All logic lives in `postmaxx.js`.
- **Plain JavaScript.** No TypeScript, no transpilation.
- **Runs directly** via `node postmaxx.js` or as executable (has shebang).
- **Functions are plain named functions**, not classes.
- **Error handling is minimal by design** — `die()` for fatal, `warn()` for non-fatal.
- **CLI args are parsed manually** with `getArg`/`hasFlag` helpers.

## Tests

```bash
node --test tests/                          # all tests
node --test tests/smoke.test.js             # end-to-end pipeline tests
node --test tests/state.test.js             # state management
node --test tests/gate.test.js              # pre-gate quality checks
node --test tests/extract.test.js           # Stage 1 extraction
node --test tests/generate.test.js          # Stage 2 generation prompts
```

51 tests, zero npm dependencies.

## Environment variables (.env)

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key (Haiku for Stage 1, Sonnet for Stage 2) |
| `TYPEFULLY_API_KEY` | No | For `--push` to send drafts to Typefully |
| `CLAUDE_PROJECTS_DIR` | No | Override default `~/.claude/projects` path |

## Key constants

- `MIN_SESSION_BYTES = 5120` — session must be ≥5KB to pass pre-gate
- `MIN_SESSION_LINES = 8` — session must have ≥8 message lines
- `MAX_CHARS = 12000` — session chunk limit for Stage 1 prompt
- `HAIKU_MODEL = 'claude-haiku-4-5'` — Stage 1 extraction
- `SONNET_MODEL = 'claude-sonnet-4-6'` — Stage 2 generation

## What good output looks like

A tweet is good if the author would post it without editing. The bar: specific, honest, sounds like a real person who just finished a coding session — not a changelog, not a press release.

The tool should never invent details not in the session. Every claim in a generated post traces back to something the user actually said.

## Deferred (phase 2)

- LinkedIn generation
- Git diff signal (`--git`)
- Voice archetypes
- Web approval UI
- Multi-user hosted product
