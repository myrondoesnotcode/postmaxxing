# Devlog v1 — Design

Date: 2026-04-25
Status: Approved, ready for implementation plan

## Goal

Devlog turns Claude Code sessions into building-in-public posts that **surface the reasoning** behind code decisions. The reasoning lives in the session transcript — the user and Claude talk through choices. The tool's job is to make that reasoning visible to an external audience.

Not viral chasing. Not changelogs. Story-shaped output that a human builder would actually want to read.

Primary platform: X. LinkedIn deferred to phase 2.

## Why this reframe

The current single-stage tool produces output like:

> "fixed mobile console layout + 3 a11y issues on e2b635. added lg:pt-8. 2 commits, pushed to main."

That is a changelog, not a tweet. It captures the "what" but loses the "why." The why is the only part outsiders care about.

The reasoning is captured in the session because the user articulates it to Claude in natural language. Git diffs do not have it. This is devlog's unfair advantage and the entire reason the product can exist.

## Output catalog

The model picks output type and shape based on what the session contains plus what is in flight on the project.

| Session contains | Output type | Typical shape |
|---|---|---|
| Self-contained reasoning | **Story** | Thread or single |
| Continuation of a known arc | **Continuation** | Single, sometimes thread |
| Small incremental work | **Drip update** | Short single |
| No real reasoning | "Nothing today" message | — |

The user picks `--mode`:

- **Story mode** — product or business reasoning lens. Example: "pricing was wrong because unit economics didn't work."
- **Technical mode** — engineering reasoning lens. Example: "dropped Redux because of re-render cost on lists."

Two orthogonal axes: the user picks the lens, the content picks the shape.

## Architecture: two-stage pipeline

### Stage 1 — Extract (Haiku)

Input: session transcript plus project state.
Output: structured JSON describing what reasoning was actually present.

```json
{
  "has_reasoning": true,
  "best_output_type": "story | continuation | drip | nothing",
  "active_arc": "pricing redesign",
  "decisions": [
    {
      "what": "switched from $19 to $29 starter tier",
      "why": "unit economics broke at scale on $19",
      "alternatives": ["raise prices later", "drop the feature"],
      "tradeoff": "fewer signups in exchange for sustainable margin"
    }
  ],
  "key_numbers": ["$0.16/scan", "4x cheaper"],
  "wrong_about": "thought hosting was the main cost — it's actually the API",
  "moment_of_realization": "...",
  "quotable_lines": ["..."],
  "technical_specifics": {
    "stack": ["Next.js", "Postgres"],
    "patterns": ["queue worker"],
    "constraints": ["Railway free tier limits"]
  }
}
```

Quality gate inside Stage 1: if `has_reasoning: false` AND no `active_arc` to continue, exit cleanly with "nothing tweet-worthy today." Do not call Stage 2.

### Stage 2 — Generate (Sonnet)

Input: Stage 1 JSON, project state, `--mode` flag, voice profile, count.
Output: N candidate posts. Each candidate is whatever output type and shape the underlying material supports.

Two separate prompts: `STORY_PROMPT` and `TECHNICAL_PROMPT`. Same input shape, different framing rules.

**Critical design decision:** Stage 2 sees the structured Stage 1 JSON, **not** the raw session. This is the hallucination firewall. Every claim in output traces to either extracted facts or state. The model cannot invent a "decision" the user did not actually make because the raw text is gone by the time generation runs.

## Project state

Stored at `~/.devlog/state/<project-slug>.json`:

```json
{
  "active_arcs": ["pricing redesign", "auth flow rebuild"],
  "recent_posts": [
    {
      "date": "2026-04-24",
      "summary": "explained $19→$29 pricing decision and unit economics",
      "type": "story"
    }
  ],
  "last_session_summary": "fixed mobile layout, no major decisions"
}
```

**Update rule:** state updates only when the user actually approves output for posting (via `--push` or a post-run approval prompt). Raw runs do not auto-mutate state. This prevents pollution from rejected drafts.

The file is plain JSON and hand-editable. If the model loses track of an arc, the user fixes it directly.

If the file does not exist, the first run creates it.

## Quality gates

Cheap gates run before any API call:

- Session must have ≥ 4 message exchanges
- Session file must be ≥ 5KB

Below those thresholds, exit with a message — no API spend.

Stage 1 gates:

- If `has_reasoning: false` AND no active arc → exit with "nothing today"
- If `has_reasoning: false` BUT active arc exists → still generate a drip update referencing the arc

Stage 2 gates: none beyond input narrowing. The grounding constraint is structural (no raw session passed in).

## Voice (v1)

Single default voice baked into Stage 2 prompts:

- Specific over vague
- Honest over hyped
- No em-dashes
- No "excited to share" / "thrilled to" / "game-changer"
- 1 hashtag max, often zero
- Reads like a journal entry made public

`--style <archive>` remains as user override (loads X archive, includes excerpts in prompt).

Not in v1: archetype menus, named-person voice mimicry. The default voice plus optional archive is sufficient for the single-user prototype phase.

## CLI surface

```bash
node devlog.js                            # last session, story mode
node devlog.js --mode technical           # technical lens
node devlog.js --list                     # interactive session picker
node devlog.js --project clipmatic        # filter
node devlog.js --days 7                   # lookback window
node devlog.js --count 3                  # candidates to generate
node devlog.js --style ~/tweets.json      # voice override (X archive)
node devlog.js --context "..."            # one-line manual hint
node devlog.js --push                     # send approved to Typefully
```

Removed from current/planned:

- `--format single|thread|mix` → killed (content drives shape)
- `--tone story|technical|mix` → renamed to `--mode`, no "mix" option

## Output and approval flow

1. Tool prints N candidates to terminal with character counts (current behavior).
2. If `--push`: prompt the user "which to push? (numbers, comma-separated, or 'none')" and send those to Typefully drafts.
3. Approved items update `recent_posts` in the project state file.

Approval is the source of truth for what counts as posted. Generated-but-rejected drafts never enter state.

## Code structure

Single file `devlog.js`, zero npm dependencies, Node 18+ (native fetch).

New functions to add:

- `loadState(slug)` / `saveState(slug, state)` — JSON read/write under `~/.devlog/state/`
- `extractStage1(session, state)` — Haiku call returning extraction JSON
- `generateStage2(extracted, state, mode, count, voice)` — Sonnet call returning candidates
- `recordApprovals(slug, approvedItems)` — appends to `recent_posts`, updates `active_arcs`

Existing functions to revise:

- Project slug decoding — currently shows hashes instead of real names. Fix during this work.
- `chunkSession` — keep, but Stage 1 prompt expects the chunked transcript.

Existing functions to retire:

- The single-stage `generateTweets` — replaced by the two-stage pipeline.

## Hallucination handling

Three layers:

1. **Structural** — Stage 2 cannot see raw session. It can only narrate from extracted facts.
2. **Schema** — Stage 1 fields are factual (decisions, numbers, quotable lines). No "vibe" fields the model can pad.
3. **Honest empty output** — when there is nothing real, the tool says so. No fallback content.

If a generated tweet contains a number or claim that does not appear in Stage 1 JSON or state, that is a bug, not a feature.

## What is deferred

- LinkedIn generation (phase 2 — separate prompt module, separate length and tone rules)
- Git diff signal (`--git` flag) — sessions have enough material; revisit if extraction quality plateaus
- Cross-candidate quality scoring — current "generate N, user picks" works
- Web approval UI
- Multi-user / hosted product
- Voice archetypes
- Performance feedback loop from Typefully analytics

## Open questions for implementation

- Exact Haiku model id and pricing budget per run
- Maximum state file size before pruning `recent_posts` (likely keep last 20)
- Whether the post-run approval prompt should be opt-out or opt-in (lean opt-in via `--push` only for v1)

These are decided in the implementation plan, not here.
