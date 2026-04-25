# Devlog v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild devlog as a two-stage pipeline (Haiku-extract → Sonnet-generate) with project state, content-driven output shape, and honest "nothing today" exits.

**Architecture:** Single-file Node.js CLI, zero npm dependencies, Node 18+. Stage 1 (Haiku) extracts structured reasoning from a session transcript plus project state. Stage 2 (Sonnet) generates 3 candidate posts from the extraction alone (raw session is firewalled to prevent hallucination). Project state is a plain JSON file per project, updated only on user-confirmed approvals.

**Tech Stack:** Node 18+ built-ins (fs, path, os, readline, fetch), Anthropic Messages API (Haiku + Sonnet), Typefully API. Tests via `node --test` (built-in runner). No package.json.

**Reference:** Design doc at `docs/plans/2026-04-25-devlog-v1-design.md`.

---

## Phase 0 — Project setup

### Task 0.1: Initialize git repository

**Files:**
- Create: `.gitignore`

**Step 1: Initialize git**

```bash
cd "/Users/myrons/Claude Projects/devlog"
git init
```

**Step 2: Write `.gitignore`**

```
.env
node_modules/
.DS_Store
*.log
```

**Step 3: First commit**

```bash
git add .gitignore CLAUDE.md devlog.js docs/
git commit -m "chore: initialize repo with current devlog v0"
```

Expected: clean working tree, single commit on `main` (or `master`).

---

### Task 0.2: Create directory structure

**Files:**
- Create: `tests/fixtures/.gitkeep`
- Create: `tests/.gitkeep`

**Step 1: Make directories**

```bash
mkdir -p tests/fixtures
touch tests/.gitkeep tests/fixtures/.gitkeep
```

**Step 2: Commit**

```bash
git add tests/
git commit -m "chore: add tests directory scaffolding"
```

---

### Task 0.3: Create test fixtures

**Files:**
- Create: `tests/fixtures/session-rich.jsonl` — a session with real reasoning (decisions, why, alternatives)
- Create: `tests/fixtures/session-thin.jsonl` — a tiny session below quality gate (3 messages)
- Create: `tests/fixtures/session-grind.jsonl` — passes size gate but no reasoning (pure debugging)
- Create: `tests/fixtures/state-with-arc.json` — a state file with one active arc and two recent posts
- Create: `tests/fixtures/state-empty.json` — fresh state file

**Step 1: Write `tests/fixtures/session-rich.jsonl`**

Each line is one JSON object. Keep entries small but with the structure devlog parses (`type`, `message.content` or `role`/`content`).

```jsonl
{"type":"user","message":{"content":"I'm thinking about pricing for Clipmatic. Right now it's $19/mo Starter. But I just looked at the unit economics."}}
{"type":"assistant","message":{"content":[{"type":"text","text":"What did you find?"}]}}
{"type":"user","message":{"content":"Each scan costs me $0.16 in API. At $19, a heavy user (200 scans) costs me $32 — I'm losing $13/customer. Light users subsidize them but the ratio is wrong."}}
{"type":"assistant","message":{"content":[{"type":"text","text":"So you have a few options: raise prices, cap usage, or restructure tiers. What feels right?"}]}}
{"type":"user","message":{"content":"I think $29 Starter with a 100-scan cap. Pro at $79 unlimited. The cap matters more than the price — most users are under 50 scans anyway."}}
{"type":"assistant","message":{"content":[{"type":"text","text":"That makes sense. The cap is the real economic lever."}]}}
{"type":"user","message":{"content":"Yeah. I had been carrying the wrong unit-economics number for three weeks. Thought hosting was the main cost. It's API."}}
```

**Step 2: Write `tests/fixtures/session-thin.jsonl`**

```jsonl
{"type":"user","message":{"content":"hey"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"hi, what's up"}]}}
{"type":"user","message":{"content":"nothing actually nvm"}}
```

**Step 3: Write `tests/fixtures/session-grind.jsonl`**

Should be ≥ 5KB so it passes size gate, but contain only mechanical debugging with no decisions. Pad with realistic-looking but reasoning-free exchanges.

```jsonl
{"type":"user","message":{"content":"the test is failing again. let me check the logs."}}
{"type":"assistant","message":{"content":[{"type":"text","text":"What does the error say?"}]}}
{"type":"user","message":{"content":"TypeError: cannot read property 'name' of undefined at line 42"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Looks like the user object isn't loaded. Can you log it just before line 42?"}]}}
```

Repeat similar exchanges until the file is ≥ 5KB. No decisions, no "why", no numbers. Just symptom-chasing.

**Step 4: Write `tests/fixtures/state-with-arc.json`**

```json
{
  "active_arcs": ["pricing redesign"],
  "recent_posts": [
    {"date": "2026-04-23", "summary": "shared the unit economics realization", "type": "story"},
    {"date": "2026-04-24", "summary": "drip update on cap pricing landing", "type": "drip"}
  ],
  "last_session_summary": "explored cap-based pricing model"
}
```

**Step 5: Write `tests/fixtures/state-empty.json`**

```json
{
  "active_arcs": [],
  "recent_posts": [],
  "last_session_summary": null
}
```

**Step 6: Commit**

```bash
git add tests/fixtures/
git commit -m "test: add session and state fixtures"
```

---

## Phase 1 — Project state module

### Task 1.1: Write tests for state slug derivation

**Files:**
- Create: `tests/state.test.js`

**Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { projectSlug } = require('../devlog.js');

test('projectSlug strips leading dash and dotifies path', () => {
  assert.strictEqual(projectSlug('-Users-myrons-Claude-Projects-clipmatic'), 'clipmatic');
});

test('projectSlug returns last meaningful segment', () => {
  assert.strictEqual(projectSlug('-home-user-projects-myapp'), 'myapp');
});

test('projectSlug falls back to original if undecodable', () => {
  assert.strictEqual(projectSlug(''), '');
});
```

**Step 2: Run to confirm it fails**

```bash
node --test tests/state.test.js
```

Expected: FAIL — `projectSlug` is not exported yet.

**Step 3: Make `projectSlug` exported from devlog.js**

Replace the existing `decodeProjectDir` function with:

```javascript
function projectSlug(dir) {
  if (!dir) return dir;
  const stripped = dir.replace(/^-/, '').replace(/-/g, '/');
  const last = stripped.split('/').filter(Boolean).pop();
  return last || dir;
}
```

Update internal callers (currently `decodeProjectDir` in `findSessions`) to use `projectSlug`.

At the bottom of `devlog.js`, add a guarded export so the file still works as a CLI:

```javascript
if (require.main === module) {
  main().catch(e => die(e.message));
} else {
  module.exports = { projectSlug };
}
```

**Step 4: Re-run the test**

```bash
node --test tests/state.test.js
```

Expected: PASS, 3 tests.

**Step 5: Commit**

```bash
git add tests/state.test.js devlog.js
git commit -m "fix: clean projectSlug decoding + add tests"
```

---

### Task 1.2: Write tests for loadState/saveState

**Files:**
- Modify: `tests/state.test.js`

**Step 1: Add tests**

```javascript
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadState, saveState } = require('../devlog.js');

test('loadState returns empty default when file does not exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-state-'));
  const state = loadState('nonexistent-project', { stateDir: tmp });
  assert.deepStrictEqual(state, {
    active_arcs: [],
    recent_posts: [],
    last_session_summary: null,
  });
});

test('saveState then loadState round-trips', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-state-'));
  const slug = 'myproj';
  const written = {
    active_arcs: ['feature x'],
    recent_posts: [{ date: '2026-04-25', summary: 's', type: 'story' }],
    last_session_summary: 'did stuff',
  };
  saveState(slug, written, { stateDir: tmp });
  const read = loadState(slug, { stateDir: tmp });
  assert.deepStrictEqual(read, written);
});

test('loadState recovers from a corrupt file by returning empty default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-state-'));
  fs.writeFileSync(path.join(tmp, 'corrupt.json'), '{not json');
  const state = loadState('corrupt', { stateDir: tmp });
  assert.deepStrictEqual(state.active_arcs, []);
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/state.test.js
```

Expected: FAIL — `loadState`/`saveState` not exported.

**Step 3: Implement in devlog.js**

Add near the helpers section:

```javascript
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.devlog', 'state');

function emptyState() {
  return { active_arcs: [], recent_posts: [], last_session_summary: null };
}

function loadState(slug, opts = {}) {
  const dir = opts.stateDir || DEFAULT_STATE_DIR;
  const file = path.join(dir, `${slug}.json`);
  if (!fs.existsSync(file)) return emptyState();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    warn(`State file unreadable, starting fresh: ${file}`);
    return emptyState();
  }
}

function saveState(slug, state, opts = {}) {
  const dir = opts.stateDir || DEFAULT_STATE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
```

Update the export block:

```javascript
module.exports = { projectSlug, loadState, saveState };
```

**Step 4: Re-run tests**

```bash
node --test tests/state.test.js
```

Expected: PASS, 6 tests.

**Step 5: Commit**

```bash
git add tests/state.test.js devlog.js
git commit -m "feat: add project state load/save with tmpdir-injectable path"
```

---

### Task 1.3: Add recordApprovals + tests

**Files:**
- Modify: `tests/state.test.js`
- Modify: `devlog.js`

**Step 1: Add tests**

```javascript
const { recordApprovals } = require('../devlog.js');

test('recordApprovals appends entries and trims to last 20', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-state-'));
  const slug = 'p';
  // Seed with 19 existing posts
  const existing = {
    active_arcs: [],
    recent_posts: Array.from({ length: 19 }, (_, i) => ({
      date: '2026-04-01', summary: `old ${i}`, type: 'drip',
    })),
    last_session_summary: null,
  };
  saveState(slug, existing, { stateDir: tmp });

  recordApprovals(slug, [
    { summary: 'new one', type: 'story' },
    { summary: 'new two', type: 'continuation' },
  ], { stateDir: tmp, today: '2026-04-25' });

  const after = loadState(slug, { stateDir: tmp });
  assert.strictEqual(after.recent_posts.length, 20);
  assert.strictEqual(after.recent_posts[after.recent_posts.length - 1].summary, 'new two');
  assert.strictEqual(after.recent_posts[after.recent_posts.length - 1].date, '2026-04-25');
});

test('recordApprovals merges new active_arcs without duplicates', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-state-'));
  const slug = 'q';
  saveState(slug, { active_arcs: ['existing'], recent_posts: [], last_session_summary: null }, { stateDir: tmp });
  recordApprovals(slug, [{ summary: 'x', type: 'story', arc: 'existing' }, { summary: 'y', type: 'story', arc: 'new arc' }], { stateDir: tmp });
  const after = loadState(slug, { stateDir: tmp });
  assert.deepStrictEqual(after.active_arcs.sort(), ['existing', 'new arc']);
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/state.test.js
```

Expected: FAIL on the new two tests.

**Step 3: Implement**

```javascript
function recordApprovals(slug, approvals, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const state = loadState(slug, opts);

  for (const a of approvals) {
    state.recent_posts.push({
      date: today,
      summary: a.summary,
      type: a.type,
    });
    if (a.arc && !state.active_arcs.includes(a.arc)) {
      state.active_arcs.push(a.arc);
    }
  }

  if (state.recent_posts.length > 20) {
    state.recent_posts = state.recent_posts.slice(-20);
  }

  saveState(slug, state, opts);
}
```

Update exports.

**Step 4: Re-run**

```bash
node --test tests/state.test.js
```

Expected: PASS, 8 tests.

**Step 5: Commit**

```bash
git add tests/state.test.js devlog.js
git commit -m "feat: recordApprovals appends posts and merges arcs"
```

---

## Phase 2 — Stage 1 extraction

### Task 2.1: Write tests for pre-API quality gate

**Files:**
- Create: `tests/gate.test.js`

**Step 1: Write the failing test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { passesPreGate } = require('../devlog.js');

test('passesPreGate rejects sessions under 5KB', () => {
  const small = fs.readFileSync(path.join(__dirname, 'fixtures/session-thin.jsonl'), 'utf8');
  assert.strictEqual(passesPreGate(small).ok, false);
  assert.match(passesPreGate(small).reason, /too short/i);
});

test('passesPreGate rejects sessions with under 4 exchanges', () => {
  const tiny = '{"type":"user","message":{"content":"hi"}}\n{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n';
  assert.strictEqual(passesPreGate(tiny).ok, false);
});

test('passesPreGate accepts rich session', () => {
  const rich = fs.readFileSync(path.join(__dirname, 'fixtures/session-rich.jsonl'), 'utf8');
  assert.strictEqual(passesPreGate(rich).ok, true);
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/gate.test.js
```

Expected: FAIL.

**Step 3: Implement**

```javascript
const MIN_SESSION_BYTES = 5 * 1024;
const MIN_EXCHANGES = 4;

function passesPreGate(rawText) {
  if (rawText.length < MIN_SESSION_BYTES) {
    return { ok: false, reason: `Session too short (${rawText.length} bytes, need ${MIN_SESSION_BYTES}).` };
  }
  const lineCount = rawText.split('\n').filter(Boolean).length;
  if (lineCount < MIN_EXCHANGES * 2) {
    return { ok: false, reason: `Session has too few exchanges (${lineCount} messages).` };
  }
  return { ok: true };
}
```

Note: `passesPreGate` runs against the raw file text (cheap, before parsing). This is the size gate. The "exchanges" check uses message-line count as a proxy.

Update exports.

**Step 4: Re-run**

```bash
node --test tests/gate.test.js
```

Expected: PASS, 3 tests.

**Step 5: Commit**

```bash
git add tests/gate.test.js devlog.js
git commit -m "feat: pre-API quality gate (size and exchange minimums)"
```

---

### Task 2.2: Write tests for buildExtractionPrompt

**Files:**
- Create: `tests/extract.test.js`

**Step 1: Write the test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { buildExtractionPrompt } = require('../devlog.js');

test('extraction prompt mentions active arcs from state', () => {
  const state = { active_arcs: ['pricing redesign'], recent_posts: [], last_session_summary: null };
  const prompt = buildExtractionPrompt('SESSION TEXT HERE', state);
  assert.match(prompt, /pricing redesign/);
});

test('extraction prompt instructs strict JSON schema', () => {
  const prompt = buildExtractionPrompt('x', { active_arcs: [], recent_posts: [], last_session_summary: null });
  assert.match(prompt, /has_reasoning/);
  assert.match(prompt, /best_output_type/);
  assert.match(prompt, /decisions/);
  assert.match(prompt, /quotable_lines/);
});

test('extraction prompt embeds the session', () => {
  const prompt = buildExtractionPrompt('UNIQUE_SESSION_MARKER', { active_arcs: [], recent_posts: [], last_session_summary: null });
  assert.match(prompt, /UNIQUE_SESSION_MARKER/);
});

test('extraction prompt includes recent_posts so model can detect continuation', () => {
  const state = {
    active_arcs: [],
    recent_posts: [{ date: '2026-04-24', summary: 'pricing decision', type: 'story' }],
    last_session_summary: null,
  };
  const prompt = buildExtractionPrompt('x', state);
  assert.match(prompt, /pricing decision/);
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/extract.test.js
```

Expected: FAIL.

**Step 3: Implement `buildExtractionPrompt`**

```javascript
function buildExtractionPrompt(sessionText, state) {
  const arcsBlock = state.active_arcs.length
    ? `Active arcs in flight on this project:\n${state.active_arcs.map(a => `- ${a}`).join('\n')}`
    : 'No active arcs yet.';

  const recentBlock = state.recent_posts.length
    ? `Recently posted (last few):\n${state.recent_posts.slice(-5).map(p => `- [${p.date}] (${p.type}) ${p.summary}`).join('\n')}`
    : 'No recent posts yet.';

  return `You are extracting reasoning and decisions from a coding session for a builder who shares progress publicly.

${arcsBlock}

${recentBlock}

Read the session below and return strict JSON only. No prose, no markdown fences.

Schema:
{
  "has_reasoning": boolean,
  "best_output_type": "story" | "continuation" | "drip" | "nothing",
  "active_arc": string | null,
  "decisions": [
    { "what": string, "why": string, "alternatives": [string], "tradeoff": string }
  ],
  "key_numbers": [string],
  "wrong_about": string | null,
  "moment_of_realization": string | null,
  "quotable_lines": [string],
  "technical_specifics": { "stack": [string], "patterns": [string], "constraints": [string] }
}

Rules:
- has_reasoning is true only if the session contains an articulated decision, trade-off, or realization. Mechanical debugging without "why" is false.
- best_output_type:
  - "story" if has_reasoning and the reasoning stands alone
  - "continuation" if it extends an active arc above
  - "drip" if it's small but real (an update worth noting, no major reasoning)
  - "nothing" if there is genuinely no signal
- Only include items that are explicitly present in the session. Do NOT invent decisions, numbers, or quotes.
- quotable_lines are direct excerpts the user said in this session, copied verbatim.

Session:
${sessionText}`;
}
```

**Step 4: Re-run**

```bash
node --test tests/extract.test.js
```

Expected: PASS, 4 tests.

**Step 5: Commit**

```bash
git add tests/extract.test.js devlog.js
git commit -m "feat: Stage 1 extraction prompt builder"
```

---

### Task 2.3: Implement extractStage1 (Haiku call) with injectable fetch

**Files:**
- Modify: `tests/extract.test.js`
- Modify: `devlog.js`

**Step 1: Add tests with stub fetch**

```javascript
const { extractStage1 } = require('../devlog.js');

test('extractStage1 returns parsed extraction JSON from Haiku response', async () => {
  const fakeExtraction = {
    has_reasoning: true,
    best_output_type: 'story',
    active_arc: null,
    decisions: [{ what: 'x', why: 'y', alternatives: [], tradeoff: '' }],
    key_numbers: [],
    wrong_about: null,
    moment_of_realization: null,
    quotable_lines: [],
    technical_specifics: { stack: [], patterns: [], constraints: [] },
  };

  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(fakeExtraction) }],
    }),
  });

  const result = await extractStage1('session text', { active_arcs: [], recent_posts: [], last_session_summary: null }, {
    fetchFn: stubFetch,
    apiKey: 'test-key',
  });

  assert.deepStrictEqual(result, fakeExtraction);
});

test('extractStage1 strips markdown fences from response', async () => {
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: '```json\n{"has_reasoning":false,"best_output_type":"nothing","active_arc":null,"decisions":[],"key_numbers":[],"wrong_about":null,"moment_of_realization":null,"quotable_lines":[],"technical_specifics":{"stack":[],"patterns":[],"constraints":[]}}\n```' }],
    }),
  });

  const result = await extractStage1('s', { active_arcs: [], recent_posts: [], last_session_summary: null }, {
    fetchFn: stubFetch,
    apiKey: 'test-key',
  });

  assert.strictEqual(result.has_reasoning, false);
});

test('extractStage1 throws on API error response', async () => {
  const stubFetch = async () => ({
    ok: false,
    json: async () => ({ error: { message: 'rate limited' } }),
  });

  await assert.rejects(
    extractStage1('s', { active_arcs: [], recent_posts: [], last_session_summary: null }, { fetchFn: stubFetch, apiKey: 'k' }),
    /rate limited/
  );
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/extract.test.js
```

Expected: FAIL.

**Step 3: Implement**

```javascript
const HAIKU_MODEL = 'claude-haiku-4-5';
const SONNET_MODEL = 'claude-sonnet-4-6';

async function extractStage1(sessionText, state, opts) {
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const prompt = buildExtractionPrompt(sessionText, state);

  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Haiku API error: ${data.error?.message || res.statusText}`);
  }

  const raw = data.content?.find(b => b.type === 'text')?.text || '';
  const clean = raw.replace(/```json|```/g, '').trim();

  try { return JSON.parse(clean); }
  catch { throw new Error(`Couldn't parse Stage 1 response:\n${raw}`); }
}
```

Update exports.

**Step 4: Re-run**

```bash
node --test tests/extract.test.js
```

Expected: PASS, 7 tests.

**Step 5: Commit**

```bash
git add tests/extract.test.js devlog.js
git commit -m "feat: Stage 1 Haiku extraction with injectable fetch"
```

---

## Phase 3 — Stage 2 generation

### Task 3.1: Write tests for buildStoryPrompt

**Files:**
- Create: `tests/generate.test.js`

**Step 1: Write the test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { buildStoryPrompt, buildTechnicalPrompt } = require('../devlog.js');

const sampleExtraction = {
  has_reasoning: true,
  best_output_type: 'story',
  active_arc: 'pricing redesign',
  decisions: [{
    what: 'switched Starter from $19 to $29 with 100-scan cap',
    why: 'unit economics: $0.16/scan made $19 lose money on heavy users',
    alternatives: ['raise prices later', 'cap usage at $19'],
    tradeoff: 'fewer signups in exchange for sustainable margin',
  }],
  key_numbers: ['$0.16/scan', '$19', '$29', '100 scans'],
  wrong_about: 'thought hosting was the main cost — it is API',
  moment_of_realization: 'looked at unit economics and saw the loss',
  quotable_lines: ['I had been carrying the wrong unit-economics number for three weeks'],
  technical_specifics: { stack: [], patterns: [], constraints: [] },
};

const sampleState = { active_arcs: ['pricing redesign'], recent_posts: [], last_session_summary: null };

test('buildStoryPrompt embeds extraction decisions', () => {
  const p = buildStoryPrompt(sampleExtraction, sampleState, { count: 3, voiceExamples: null });
  assert.match(p, /\$0\.16\/scan/);
  assert.match(p, /unit economics/);
});

test('buildStoryPrompt forbids hype and em-dashes explicitly', () => {
  const p = buildStoryPrompt(sampleExtraction, sampleState, { count: 3 });
  assert.match(p, /em-dash/i);
  assert.match(p, /excited to share/i);
});

test('buildStoryPrompt requests strict JSON candidate output', () => {
  const p = buildStoryPrompt(sampleExtraction, sampleState, { count: 3 });
  assert.match(p, /candidates/i);
  assert.match(p, /"shape":\s*"single"\|"thread"/);
});

test('buildTechnicalPrompt has different framing than story', () => {
  const story = buildStoryPrompt(sampleExtraction, sampleState, { count: 3 });
  const tech = buildTechnicalPrompt(sampleExtraction, sampleState, { count: 3 });
  assert.notStrictEqual(story, tech);
  assert.match(tech, /technical|engineering|stack|trade-off/i);
});

test('story prompt embeds voice examples when provided', () => {
  const p = buildStoryPrompt(sampleExtraction, sampleState, {
    count: 3,
    voiceExamples: 'EXAMPLE_TWEET_1\n---\nEXAMPLE_TWEET_2',
  });
  assert.match(p, /EXAMPLE_TWEET_1/);
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/generate.test.js
```

Expected: FAIL.

**Step 3: Implement prompt builders**

Shared helpers first:

```javascript
function formatExtractionForPrompt(extraction) {
  return JSON.stringify(extraction, null, 2);
}

function formatStateForPrompt(state) {
  return JSON.stringify({
    active_arcs: state.active_arcs,
    recent_posts: state.recent_posts.slice(-5),
  }, null, 2);
}

const VOICE_RULES = `Voice rules:
- Specific over vague. Use real numbers and concrete details from the extraction.
- Honest over hyped. No "excited to share", no "thrilled to", no "game-changer".
- No em-dashes. Use commas, periods, or line breaks.
- 1 hashtag max, often zero.
- Lowercase opens are fine. Reads like a journal entry made public, not a press release.
- If a decision was wrong, say so plainly.`;

const OUTPUT_FORMAT = `Return strict JSON, no markdown fences:
{
  "candidates": [
    { "shape": "single"|"thread", "type": "story"|"continuation"|"drip", "label": "short label", "text": "single tweet text", "tweets": ["t1","t2"], "arc": "arc name or null", "summary_for_state": "one-line summary if approved" }
  ]
}
Use "text" for shape:single, "tweets" for shape:thread. Include the other field as null.`;
```

Then the two builders:

```javascript
function buildStoryPrompt(extraction, state, opts) {
  const { count, voiceExamples } = opts;
  const voiceBlock = voiceExamples
    ? `\nThe author's real tweets, for tone reference:\n---\n${voiceExamples.slice(0, 2000)}\n---\n`
    : '';

  return `You are ghost-writing building-in-public posts for a developer. The lens is STORY: surface the product or business reasoning behind decisions, not the engineering details.

Extraction (the only ground truth — every claim must trace to this):
${formatExtractionForPrompt(extraction)}

Project state (use to detect continuation, avoid contradicting prior posts):
${formatStateForPrompt(state)}

${voiceBlock}
${VOICE_RULES}

Generate ${count} candidate posts. Each candidate should pick its own shape based on the material:
- single (≤ 280 chars) when one tight insight lands
- thread (3-5 tweets, each ≤ 280) when reasoning needs space

Mix shapes across the candidates if the material supports it. If the extraction says best_output_type is "drip", keep candidates short and casual. If "continuation", reference the active arc explicitly.

${OUTPUT_FORMAT}`;
}

function buildTechnicalPrompt(extraction, state, opts) {
  const { count, voiceExamples } = opts;
  const voiceBlock = voiceExamples
    ? `\nThe author's real tweets, for tone reference:\n---\n${voiceExamples.slice(0, 2000)}\n---\n`
    : '';

  return `You are ghost-writing building-in-public posts for a developer. The lens is TECHNICAL: surface engineering decisions, trade-offs, stack choices, and the why behind them. Audience is other developers who want the actual details.

Extraction (the only ground truth — every claim must trace to this):
${formatExtractionForPrompt(extraction)}

Project state (use to detect continuation, avoid contradicting prior posts):
${formatStateForPrompt(state)}

${voiceBlock}
${VOICE_RULES}

Generate ${count} candidate posts. Lean into specifics: library names, patterns, constraints, the actual trade-off accepted. Don't dumb it down. Each candidate picks its own shape:
- single for one tight technical observation
- thread for a chain of decisions or a non-obvious trade-off explained

If best_output_type is "drip", keep it brief — "shipped X, switched to Y, going to test Z next". If "continuation", reference the active arc.

${OUTPUT_FORMAT}`;
}
```

Update exports.

**Step 4: Re-run**

```bash
node --test tests/generate.test.js
```

Expected: PASS, 5 tests.

**Step 5: Commit**

```bash
git add tests/generate.test.js devlog.js
git commit -m "feat: Stage 2 prompt builders for story and technical modes"
```

---

### Task 3.2: Implement generateStage2 with injectable fetch

**Files:**
- Modify: `tests/generate.test.js`
- Modify: `devlog.js`

**Step 1: Add tests**

```javascript
const { generateStage2 } = require('../devlog.js');

test('generateStage2 calls Sonnet with story prompt for mode=story', async () => {
  let capturedBody;
  const stubFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ candidates: [{ shape: 'single', type: 'story', label: 'l', text: 't', tweets: null, arc: null, summary_for_state: 's' }] }) }],
      }),
    };
  };

  const result = await generateStage2(sampleExtraction, sampleState, {
    mode: 'story', count: 1, fetchFn: stubFetch, apiKey: 'k',
  });

  assert.strictEqual(capturedBody.model, 'claude-sonnet-4-6');
  assert.match(capturedBody.messages[0].content, /STORY/);
  assert.strictEqual(result.candidates.length, 1);
});

test('generateStage2 uses technical prompt for mode=technical', async () => {
  let capturedBody;
  const stubFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ candidates: [] }) }] }),
    };
  };

  await generateStage2(sampleExtraction, sampleState, {
    mode: 'technical', count: 3, fetchFn: stubFetch, apiKey: 'k',
  });

  assert.match(capturedBody.messages[0].content, /TECHNICAL/);
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/generate.test.js
```

Expected: FAIL.

**Step 3: Implement**

```javascript
async function generateStage2(extraction, state, opts) {
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const apiKey = opts.apiKey;
  const { mode, count, voiceExamples } = opts;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const prompt = mode === 'technical'
    ? buildTechnicalPrompt(extraction, state, { count, voiceExamples })
    : buildStoryPrompt(extraction, state, { count, voiceExamples });

  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Sonnet API error: ${data.error?.message || res.statusText}`);
  }

  const raw = data.content?.find(b => b.type === 'text')?.text || '';
  const clean = raw.replace(/```json|```/g, '').trim();

  try { return JSON.parse(clean); }
  catch { throw new Error(`Couldn't parse Stage 2 response:\n${raw}`); }
}
```

Update exports.

**Step 4: Re-run**

```bash
node --test tests/generate.test.js
```

Expected: PASS, 7 tests.

**Step 5: Commit**

```bash
git add tests/generate.test.js devlog.js
git commit -m "feat: Stage 2 Sonnet generation dispatches by mode"
```

---

## Phase 4 — Wiring main()

### Task 4.1: Update CLI flag parsing

**Files:**
- Modify: `devlog.js`

**Step 1: Replace top-of-file flag parsing**

Find the existing block:

```javascript
const FORMAT  = getArg('--format') || 'mix';
const TONE    = getArg('--tone')   || 'mix';
```

Replace with:

```javascript
const MODE    = getArg('--mode')   || 'story';   // story | technical
const CONTEXT = getArg('--context');             // optional one-line manual hint
```

Validate `MODE`:

```javascript
if (!['story', 'technical'].includes(MODE)) {
  die(`Invalid --mode: ${MODE}. Use 'story' or 'technical'.`);
}
```

Remove `FORMAT` and `TONE` references throughout the file.

**Step 2: Run existing tests to confirm no regression**

```bash
node --test tests/
```

Expected: PASS, all prior tests still green.

**Step 3: Commit**

```bash
git add devlog.js
git commit -m "feat: replace --format/--tone with --mode (story|technical)"
```

---

### Task 4.2: Rewrite main() to use two-stage pipeline

**Files:**
- Modify: `devlog.js`

**Step 1: Replace the entire `main()` function**

```javascript
async function main() {
  console.log('\n  devlog v1  —  session → reasoning → posts\n');

  if (!ANTHROPIC_KEY) die('Missing ANTHROPIC_API_KEY in .env');

  process.stdout.write('  Finding sessions...');
  const sessions = findSessions();
  process.stdout.write(` found ${sessions.length}\n`);
  if (sessions.length === 0) die('No sessions found. Try --days 7.');

  const session = LIST_MODE ? await pickSession(sessions) : sessions[0];
  const slug = projectSlug(path.basename(path.dirname(session.file)));

  console.log(`\n  Project : ${session.project}  (slug: ${slug})`);
  console.log(`  Session : ${formatAge(session.mtime)}  (${(session.size/1024).toFixed(0)}kb)`);
  console.log(`  Mode    : ${MODE}  |  Count: ${COUNT}`);

  // Pre-API gate
  const rawText = fs.readFileSync(session.file, 'utf8');
  const gate = passesPreGate(rawText);
  if (!gate.ok) die(gate.reason + ' Try a longer session or --list.');

  process.stdout.write('  Parsing...');
  const messages = parseSession(session.file);
  const chunk = chunkSession(messages);
  process.stdout.write(` ${messages.length} messages, ${chunk.length} chars\n`);

  const state = loadState(slug);
  if (state.active_arcs.length) console.log(`  Arcs    : ${state.active_arcs.join(', ')}`);

  const voiceExamples = STYLE_FILE ? loadStyle(STYLE_FILE) : null;
  if (voiceExamples) console.log(`  Style   : loaded from ${path.basename(STYLE_FILE)}`);

  process.stdout.write('  Extracting (Haiku)...');
  const sessionForPrompt = CONTEXT
    ? `Manual hint from user: ${CONTEXT}\n\n---\n\n${chunk}`
    : chunk;
  const extraction = await extractStage1(sessionForPrompt, state, { apiKey: ANTHROPIC_KEY });
  process.stdout.write(' done\n');

  // Stage 1 gates
  if (extraction.best_output_type === 'nothing' && !extraction.active_arc) {
    console.log(`\n  No story today.\n  Session was real but contained no decisions or reasoning worth surfacing.\n  Try a session where you talked through a choice or trade-off.\n`);
    process.exit(0);
  }

  process.stdout.write('  Generating (Sonnet)...');
  const result = await generateStage2(extraction, state, {
    mode: MODE, count: COUNT, voiceExamples, apiKey: ANTHROPIC_KEY,
  });
  process.stdout.write(' done\n');

  printResults(result, session.project);

  if (PUSH_TO_TF) {
    await handlePushAndApproval(result, slug);
  } else if (result.candidates.length) {
    console.log(`  --push to send drafts to Typefully and record approvals to state.\n`);
  }
}
```

**Step 2: Replace `printResults` to handle the new shape**

```javascript
function printResults(result, projectName) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  devlog  ·  ${projectName}  ·  mode:${MODE}`);
  console.log(`${'─'.repeat(60)}\n`);

  if (!result.candidates || result.candidates.length === 0) {
    console.log('  (no candidates returned)\n');
    return;
  }

  result.candidates.forEach((c, i) => {
    const tag = `[${c.shape.toUpperCase()} · ${c.type.toUpperCase()}]`;
    console.log(`  ${i + 1}. ${tag} ${c.label || ''}`);
    if (c.shape === 'single') {
      const len = (c.text || '').length;
      console.log(`     ${len > 260 ? '⚠' : '✓'} ${len}/280\n`);
      console.log(`     ${c.text.replace(/\n/g, '\n     ')}\n`);
    } else {
      const tweets = c.tweets || [];
      console.log(`     ${tweets.length} tweets\n`);
      tweets.forEach((t, j) => {
        const len = t.length;
        console.log(`     ${j + 1}/${tweets.length} ${len > 260 ? '⚠' : '✓'} ${len}/280`);
        console.log(`     ${t.replace(/\n/g, '\n     ')}\n`);
      });
    }
    console.log(`  ${'·'.repeat(40)}\n`);
  });
}
```

**Step 3: Implement `handlePushAndApproval`**

```javascript
async function handlePushAndApproval(result, slug) {
  if (!TYPEFULLY_KEY) {
    console.log('  Skipping push: no TYPEFULLY_API_KEY in .env\n');
    return;
  }

  const answer = await prompt('  Which candidates to push? (e.g. "1,3" or "none"): ');
  const picks = answer.trim().toLowerCase();
  if (!picks || picks === 'none') {
    console.log('  No approvals recorded.\n');
    return;
  }

  const indices = picks.split(',')
    .map(s => parseInt(s.trim(), 10) - 1)
    .filter(i => !isNaN(i) && i >= 0 && i < result.candidates.length);

  const approvals = [];
  for (const i of indices) {
    const c = result.candidates[i];
    const content = c.shape === 'thread' ? (c.tweets || []).join('\n\n') : c.text;
    try {
      await pushToTypefully(content);
      console.log(`  ✓ pushed ${c.shape}: ${c.label}`);
      approvals.push({ summary: c.summary_for_state || c.label, type: c.type, arc: c.arc });
    } catch (e) {
      console.error(`  ✗ failed: ${e.message}`);
    }
  }

  if (approvals.length) {
    recordApprovals(slug, approvals);
    console.log(`\n  Recorded ${approvals.length} approval(s) to state.\n`);
  }
}
```

**Step 4: Run all tests**

```bash
node --test tests/
```

Expected: PASS, all prior tests still green.

**Step 5: Commit**

```bash
git add devlog.js
git commit -m "feat: rewrite main() as two-stage pipeline with state and approvals"
```

---

### Task 4.3: Remove dead code from old single-stage pipeline

**Files:**
- Modify: `devlog.js`

**Step 1: Delete obsolete functions**

Remove:
- `buildSystemPrompt` (replaced by buildStoryPrompt / buildTechnicalPrompt)
- `generateTweets` (replaced by extractStage1 + generateStage2)
- Any remaining `FORMAT` / `TONE` references

Keep:
- `chunkSession`, `scoreDecisionDensity`, `buildChunk` — still used as input to Stage 1
- `loadStyle` — still used for `--style`
- `pushToTypefully`, `pickSession`, `formatAge`, `prompt`, `die`, `warn` — unchanged

**Step 2: Run all tests**

```bash
node --test tests/
```

Expected: PASS.

**Step 3: Manual sanity check**

```bash
node devlog.js --help 2>&1 | head -20 || node devlog.js --list
```

Should show the listing. Exit with Ctrl-C without picking.

**Step 4: Commit**

```bash
git add devlog.js
git commit -m "chore: remove dead single-stage code"
```

---

## Phase 5 — End-to-end smoke tests

### Task 5.1: Smoke test on the rich fixture

**Files:**
- Create: `tests/smoke.test.js`

**Step 1: Write the smoke test**

This test uses recorded fake API responses to verify the pipeline end-to-end without hitting the real API.

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { extractStage1, generateStage2, passesPreGate, loadState, recordApprovals } = require('../devlog.js');

test('end-to-end: rich session passes gate, extracts reasoning, generates candidates', async () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures/session-rich.jsonl'), 'utf8');
  // Note: the rich fixture is small. Pad it to pass the size gate or override it for the test.
  // For the smoke test we only check the pipeline shape, not the gate, so we call the stages directly.

  const fakeExtraction = {
    has_reasoning: true,
    best_output_type: 'story',
    active_arc: null,
    decisions: [{
      what: 'switched Starter from $19 to $29 with 100-scan cap',
      why: 'unit economics: $0.16/scan made $19 lose money on heavy users',
      alternatives: ['raise prices later', 'cap usage at $19'],
      tradeoff: 'fewer signups for sustainable margin',
    }],
    key_numbers: ['$0.16/scan', '$19', '$29', '100 scans'],
    wrong_about: 'thought hosting was the main cost — it is API',
    moment_of_realization: 'looked at unit economics and saw the loss',
    quotable_lines: ['I had been carrying the wrong unit-economics number for three weeks'],
    technical_specifics: { stack: [], patterns: [], constraints: [] },
  };

  const stubFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.model.includes('haiku')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(fakeExtraction) }] }) };
    }
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          candidates: [
            { shape: 'single', type: 'story', label: 'pricing realization', text: 'I had been carrying the wrong unit-economics number for three weeks. each scan costs $0.16. at $19 starter, a heavy user lost me $13. switched to $29 with a 100-scan cap.', tweets: null, arc: 'pricing redesign', summary_for_state: 'pricing change driven by API unit cost' },
            { shape: 'thread', type: 'story', label: 'full reasoning chain', text: null, tweets: ['three weeks ago I priced Clipmatic Starter at $19/mo.', 'last night I actually looked at the unit economics. each scan costs $0.16 in API. a heavy user (200 scans) cost me $32.', 'so $19 was losing $13 on every heavy user. light users were subsidizing.', 'fix: $29 Starter with a 100-scan cap. the cap matters more than the price — most users do under 50 anyway.'], arc: 'pricing redesign', summary_for_state: 'thread on pricing reasoning' },
          ],
        }) }],
      }),
    };
  };

  const state = { active_arcs: [], recent_posts: [], last_session_summary: null };
  const extraction = await extractStage1(raw, state, { fetchFn: stubFetch, apiKey: 'k' });
  assert.strictEqual(extraction.has_reasoning, true);

  const result = await generateStage2(extraction, state, { mode: 'story', count: 2, fetchFn: stubFetch, apiKey: 'k' });
  assert.strictEqual(result.candidates.length, 2);
  assert.strictEqual(result.candidates[0].shape, 'single');
  assert.strictEqual(result.candidates[1].shape, 'thread');
  assert.match(result.candidates[0].text, /\$0\.16/);
});

test('end-to-end: grind session pre-gate accepts (size ok), extraction returns nothing', async () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures/session-grind.jsonl'), 'utf8');
  assert.strictEqual(passesPreGate(raw).ok, true);

  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        has_reasoning: false,
        best_output_type: 'nothing',
        active_arc: null,
        decisions: [], key_numbers: [], wrong_about: null, moment_of_realization: null, quotable_lines: [],
        technical_specifics: { stack: [], patterns: [], constraints: [] },
      }) }],
    }),
  });

  const extraction = await extractStage1(raw, { active_arcs: [], recent_posts: [], last_session_summary: null }, { fetchFn: stubFetch, apiKey: 'k' });
  assert.strictEqual(extraction.has_reasoning, false);
  assert.strictEqual(extraction.best_output_type, 'nothing');
});

test('end-to-end: thin session is rejected pre-gate (no API call)', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures/session-thin.jsonl'), 'utf8');
  const gate = passesPreGate(raw);
  assert.strictEqual(gate.ok, false);
});
```

**Step 2: Run**

```bash
node --test tests/smoke.test.js
```

Expected: PASS, 3 tests. If session-rich.jsonl is too small to be realistic, that's fine — the smoke test calls extractStage1 directly with stubbed responses.

**Step 3: Commit**

```bash
git add tests/smoke.test.js
git commit -m "test: end-to-end smoke tests via stubbed fetch"
```

---

### Task 5.2: Live test against a real recent session

**Files:** none (validation step)

**Step 1: Run devlog against your most recent real session**

```bash
node devlog.js --mode story --count 3
```

Watch for:
- Does the pre-gate pass or refuse?
- Does Stage 1 extraction look sensible? (errors will surface as parse failures)
- Do the Stage 2 candidates feel like the kind of post you'd actually publish?
- Is at least one candidate clearly better than what v0 produced on similar input?

**Step 2: Run again with technical mode**

```bash
node devlog.js --mode technical --count 3
```

The output should feel different in vocabulary and emphasis (more stack/pattern, less business framing).

**Step 3: Run on a known boring session**

```bash
node devlog.js --list
# pick a small/grind session
```

Should exit cleanly with "no story today" rather than producing filler.

**Step 4: If quality is meaningfully better than v0, commit a quick changelog entry**

Update CLAUDE.md "Quick start" section to reflect new flags, then:

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for v1 flags"
```

If the output is still weak, capture the specific failure mode and either:
- Tweak Stage 1 prompt rules (extraction missing important fields)
- Tweak Stage 2 voice rules (output reads wrong)
- Add a new test fixture and iterate

---

## Phase 6 — Documentation

### Task 6.1: Update CLAUDE.md for v1

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Rewrite Quick start, Architecture, Key constants sections**

Replace the existing "Architecture" section with the two-stage description from the design doc. Update CLI examples to use `--mode` instead of `--tone`/`--format`. Add a "Project state" section describing `~/.devlog/state/<slug>.json`. Note the `node --test tests/` command for running tests.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for v1 architecture"
```

---

## Acceptance criteria

- All `node --test tests/` passes (state, gate, extract, generate, smoke).
- `node devlog.js` against a rich session produces ≥ 1 candidate that clearly surfaces "the why."
- `node devlog.js` against a grind session exits with "no story today" instead of forcing output.
- `--push` followed by approval updates `~/.devlog/state/<slug>.json` with the approved post summaries.
- `--mode story` and `--mode technical` produce noticeably different framings on the same session.
- No raw session text reaches Stage 2 — verified by reading the code path, not just the tests.
- Single-file `devlog.js`, no package.json, no node_modules.

## Out of scope (do not build in this plan)

- LinkedIn output
- Git diff signal (`--git`)
- Voice archetypes
- Cross-candidate quality scoring
- Web UI
- Multi-user / hosted

## Reference

- Design doc: `docs/plans/2026-04-25-devlog-v1-design.md`
- Original CLAUDE.md context (pre-rebuild): preserved in git history at the initial commit
