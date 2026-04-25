# Devlog

CLI tool that reads Claude Code session transcripts and generates building-in-public tweets for X/Twitter.

## Quick start

```bash
# Requires .env with ANTHROPIC_API_KEY (and optionally TYPEFULLY_API_KEY)
node devlog.js                         # most recent session, default settings
node devlog.js --list                  # interactive session picker
node devlog.js --project myapp --days 7 --tone story --format thread --count 3
node devlog.js --push                  # send drafts to Typefully
node devlog.js --style tweets.json     # match voice from real tweet examples
```

## Architecture

Single file (`devlog.js`), zero dependencies, vanilla Node.js.

**Flow:** discover sessions → parse .jsonl transcript → smart-chunk to 12KB → call Claude API → display tweets (optionally push to Typefully)

Key sections in `devlog.js`:
- **Session discovery** (lines ~40-71) — scans `~/.claude/projects/` for `.jsonl` files, filters by `--days` and `--project`
- **Session parsing** (lines ~75-103) — reads JSONL transcripts, handles two message formats and multimodal content blocks
- **Smart chunking** (lines ~107-147) — scores exchanges by "decision density" (pivots, realizations, metrics) and selects the most interesting parts within 12KB
- **Tweet generation** (lines ~165-234) — builds system prompt with tone/format/style settings, calls Claude Sonnet API, parses JSON response
- **Typefully push** (lines ~238-248) — sends drafts to Typefully API
- **Output formatting** (lines ~252-279) — displays tweets with character count validation

## Conventions

- **Zero external dependencies.** Uses only Node.js built-ins (`fs`, `path`, `os`, `readline`). No package.json. Keep it this way.
- **Single-file tool.** All logic lives in `devlog.js`. Don't split into modules unless the file becomes unmanageable.
- **Plain JavaScript.** No TypeScript, no transpilation, no build step.
- **Runs directly** via `node devlog.js` or as executable (has shebang).
- **Functions are plain named functions**, not classes. Keep it flat and simple.
- **Error handling is minimal by design** — `die()` for fatal errors, `warn()` for non-fatal. No try/catch wrapping everything.
- **CLI args are parsed manually** with `getArg`/`hasFlag` helpers. No arg-parsing library.

## Environment variables (.env)

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for tweet generation |
| `TYPEFULLY_API_KEY` | No | For `--push` flag to send drafts to Typefully |
| `CLAUDE_PROJECTS_DIR` | No | Override default `~/.claude/projects` path |

## Key constants

- `MAX_CHARS = 12000` — session chunk size limit sent to the API
- Tweet output validated against 280 char limit
- API response limited to 2000 max tokens
- Uses `claude-sonnet-4-6` model for generation
