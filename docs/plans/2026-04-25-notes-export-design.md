# Apple Notes Export — Design

Date: 2026-04-25
Status: Approved, ready for implementation

## Goal

Add `--notes` flag to devlog that saves all generated candidates to a new Apple Notes note after each run.

## Trigger

`--notes` CLI flag. Runs after `printResults` — note is created regardless of whether `--push` is also used.

## Note format

**Title:** `Devlog · <project> · <date>` — e.g. `Devlog · clipmatic · Apr 25`

**Body:** All candidates formatted as plain text:

```
MODE: story  |  Apr 25, 2026

───────────────────────────────

1. [SINGLE · STORY] pricing realization
✓ 118/280

three weeks with the wrong number. $0.16/scan at $19 = losing money.

───────────────────────────────

2. [THREAD · STORY] full pricing reasoning
3 tweets

1/3 priced Clipmatic Starter at $19/mo. seemed fine.
2/3 then I looked at unit economics. $0.16/scan. heavy user = $32 cost.
3/3 fix: $29 Starter, 100-scan cap. most users do under 50 anyway.

───────────────────────────────
```

## Implementation

`osascript` via Node's built-in `child_process.execSync`. Zero new dependencies.

The note body is built as a plain string, then passed to AppleScript:

```applescript
tell application "Notes"
  make new note at folder "Notes" with properties {name:"<title>", body:"<body>"}
end tell
```

macOS only — if `process.platform !== 'darwin'`, print a warning and skip silently.

## New functions

- `buildNoteContent(result, projectName, mode)` — pure function, returns formatted string
- `exportToNotes(title, body)` — calls `osascript`, throws on failure

## CLI

```bash
node devlog.js --notes              # generate + save to Notes
node devlog.js --notes --push       # generate + save + push to Typefully
```

`SAVE_TO_NOTES = hasFlag('--notes')` constant at top of file.

## Error handling

If `osascript` fails (Notes not available, permission denied): `warn()` and continue — do not `die()`. The notes export is supplementary; a failure should not break the main flow.

## What it does not do

- No selective export (approved-only) — `--notes` always saves all candidates
- No append to existing note — always creates a new note per run
- No non-macOS support
