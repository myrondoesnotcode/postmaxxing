# Devlog Web UI — Design

Date: 2026-05-01
Status: Approved, ready for implementation

## Goal

Add a local web UI (`--ui` flag) that replaces the terminal workflow with a beautiful browser interface: session picker → generate → review/edit candidates → post to X. Doubles as the product demo for a Product Hunt launch.

## Target user

The intersection of build-in-public and vibe coding — developers building products with Claude Code who want to share the reasoning behind their decisions on X.

## Architecture

`node devlog.js --ui` starts a local HTTP server on port 3000 using Node's built-in `http` module, then opens the browser automatically. The server reuses all existing pipeline logic (findSessions, extractStage1, generateStage2). The browser communicates via a small JSON API.

```
devlog.js --ui
  └── http server (Node built-in, port 3000)
        ├── GET  /              → serves the single-page HTML app
        ├── GET  /api/sessions  → returns session list JSON
        └── POST /api/generate  → runs Stage 1 + Stage 2, returns candidates JSON
```

**Zero new npm dependencies.** Server uses Node built-in `http`. Frontend is vanilla HTML/CSS/JS, embedded as a template string in devlog.js and served from the same process.

## UI

Single page, two-panel layout. Dark theme.

### Left panel — Session browser
- All sessions listed sorted by most recent, grouped by project
- Each row: project name · time ago · session size (kb)
- Click a row to select
- Mode toggle (Story / Technical) above the list
- Count input (default 3)
- Generate button

### Right panel — Candidates
- Empty state: prompt to select a session and generate
- Loading state: spinner with "Extracting reasoning… Generating candidates…" text while AI runs
- Each candidate rendered as a card:
  - Label + shape/type badge (e.g. SINGLE · STORY)
  - Tweet text — inline editable
  - Character counter: green ≤260, yellow 261–280, red >280
  - Threads: each tweet numbered (1/3, 2/3…), each independently editable
  - "Post to X →" button — opens `https://x.com/intent/tweet?text=<encoded>` in new tab

### Header
- `devlog` wordmark (left)
- Selected project name + session age (center, appears after selection)
- Minimal — no nav, no settings

## Posting to X

No X API. "Post to X →" encodes the tweet text and opens:
```
https://x.com/intent/tweet?text=<urlencoded text>
```
Browser opens X with the tweet pre-filled. User reviews and clicks Post. Free, no API keys, no OAuth.

For threads: open one tweet composer per tweet in sequence (or open all at once — implementation detail).

## Landing page

Static page under `docs/` served via GitHub Pages.

**Content:**
- Headline: *"Turn your Claude Code sessions into posts people actually want to read"*
- Subheadline: *"Devlog finds the reasoning behind your decisions and writes the tweet. You hit Post."*
- Screenshot of the UI with a real generated candidate
- Install command: `git clone` + `node devlog.js --ui`
- 3 real example outputs (from Clipmatic and Parsha sessions)
- How it works: 3 steps (Session → Extract → Post)
- Meta-story: "Built in public using itself"
- GitHub star button

## CLI flag

```bash
node devlog.js --ui          # start server, open browser
node devlog.js --ui --port 8080   # custom port
```

`USE_UI = hasFlag('--ui')` constant at top of file alongside other flags.

## Error handling

- If port 3000 is in use, try 3001, 3002 (up to 3 attempts), then die with message
- API errors from Stage 1/2 return JSON `{ error: "..." }` — UI shows inline error message on the candidate panel
- Session with no reasoning returns `{ nothing: true, message: "..." }` — UI shows the "no story today" message in the right panel

## What's out of scope (phase 2)

- Hosted/cloud version
- User accounts / auth
- Scheduling posts
- LinkedIn generation
- Session history / saved drafts
- X API direct posting (web intent is sufficient for launch)
- Email capture / waitlist on landing page
