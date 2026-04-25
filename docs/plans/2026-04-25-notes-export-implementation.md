# Apple Notes Export Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--notes` flag to devlog that saves all generated candidates to a new Apple Notes note after each run.

**Architecture:** Two pure functions added to `devlog.js` — `buildNoteContent` formats the candidates string, `exportToNotes` shells out to `osascript`. Both are exported for testing. `buildNoteContent` is unit-tested directly. `exportToNotes` is tested with an injectable `execFn` to avoid shelling out in tests. Wired into `main()` after `printResults`.

**Tech Stack:** Node.js built-ins only — `child_process.execSync` for osascript. Zero new dependencies.

---

### Task 1: buildNoteContent — tests + implementation

**Files:**
- Create: `tests/notes.test.js`
- Modify: `devlog.js` (add `buildNoteContent`, update exports)

**Step 1: Write the failing test**

Create `/Users/myrons/Claude Projects/devlog/tests/notes.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { buildNoteContent } = require('../devlog.js');

const sampleResult = {
  candidates: [
    {
      shape: 'single',
      type: 'story',
      label: 'pricing realization',
      text: 'three weeks with the wrong number. $0.16/scan at $19 = losing money.',
      tweets: null,
      arc: null,
      summary_for_state: 'pricing change',
    },
    {
      shape: 'thread',
      type: 'story',
      label: 'full reasoning',
      text: null,
      tweets: [
        'priced Clipmatic at $19/mo.',
        'looked at unit economics. losing money.',
        'fix: $29 + 100-scan cap.',
      ],
      arc: null,
      summary_for_state: 'thread on pricing',
    },
  ],
};

test('buildNoteContent includes project name and date', () => {
  const content = buildNoteContent(sampleResult, 'clipmatic', 'story', '2026-04-25');
  assert.match(content, /clipmatic/i);
  assert.match(content, /2026-04-25/);
});

test('buildNoteContent includes single tweet text', () => {
  const content = buildNoteContent(sampleResult, 'clipmatic', 'story', '2026-04-25');
  assert.match(content, /\$0\.16\/scan/);
  assert.match(content, /SINGLE/);
});

test('buildNoteContent includes thread tweets numbered', () => {
  const content = buildNoteContent(sampleResult, 'clipmatic', 'story', '2026-04-25');
  assert.match(content, /THREAD/);
  assert.match(content, /1\/3/);
  assert.match(content, /priced Clipmatic at \$19\/mo\./);
});

test('buildNoteContent includes mode in header', () => {
  const content = buildNoteContent(sampleResult, 'clipmatic', 'technical', '2026-04-25');
  assert.match(content, /technical/i);
});

test('buildNoteContent handles empty candidates gracefully', () => {
  const content = buildNoteContent({ candidates: [] }, 'myproj', 'story', '2026-04-25');
  assert.ok(typeof content === 'string');
  assert.match(content, /myproj/i);
});
```

**Step 2: Run to confirm fail**

```bash
cd "/Users/myrons/Claude Projects/devlog"
node --test tests/notes.test.js
```

Expected: FAIL — `buildNoteContent` not exported.

**Step 3: Implement buildNoteContent in devlog.js**

Add a new `// ─── Notes export ──────────────────────────────────────────────────────────` section before `main()`:

```javascript
function buildNoteContent(result, projectName, mode, dateStr) {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const divider = '─'.repeat(40);
  const lines = [];

  lines.push(`MODE: ${mode}  |  ${date}`);
  lines.push('');

  const candidates = result.candidates || [];

  if (candidates.length === 0) {
    lines.push(`${projectName} — no candidates generated.`);
    return lines.join('\n');
  }

  candidates.forEach((c, i) => {
    lines.push(divider);
    lines.push('');
    const tag = `[${(c.shape || 'unknown').toUpperCase()} · ${(c.type || 'unknown').toUpperCase()}]`;
    lines.push(`${i + 1}. ${tag} ${c.label || ''}`);

    if (c.shape === 'single') {
      const len = (c.text || '').length;
      lines.push(`${len > 260 ? '⚠' : '✓'} ${len}/280`);
      lines.push('');
      lines.push(c.text || '');
    } else {
      const tweets = c.tweets || [];
      lines.push(`${tweets.length} tweets`);
      lines.push('');
      tweets.forEach((t, j) => {
        lines.push(`${j + 1}/${tweets.length}  ${t || ''}`);
      });
    }

    lines.push('');
  });

  lines.push(divider);
  return lines.join('\n');
}
```

Update the export block at the bottom to include `buildNoteContent`:

```javascript
module.exports = { projectSlug, loadState, saveState, recordApprovals, passesPreGate, buildExtractionPrompt, extractStage1, buildStoryPrompt, buildTechnicalPrompt, generateStage2, buildNoteContent };
```

**Step 4: Run to confirm pass**

```bash
node --test tests/notes.test.js
```

Expected: 5 pass, 0 fail.

Also run full suite to confirm no regression:

```bash
node --test tests/state.test.js tests/gate.test.js tests/extract.test.js tests/generate.test.js tests/smoke.test.js tests/notes.test.js
```

Expected: 45 pass, 0 fail.

**Step 5: Commit**

```bash
cd "/Users/myrons/Claude Projects/devlog"
git add tests/notes.test.js devlog.js
git commit -m "feat: buildNoteContent formats candidates for Apple Notes"
```

---

### Task 2: exportToNotes — tests + implementation

**Files:**
- Modify: `tests/notes.test.js` (add tests)
- Modify: `devlog.js` (add `exportToNotes`, update exports)

**Step 1: Write the failing tests**

Add to the END of `tests/notes.test.js`:

```javascript
const { exportToNotes } = require('../devlog.js');

test('exportToNotes calls execFn with osascript command containing title and body', () => {
  let capturedCmd = null;
  const stubExec = (cmd) => { capturedCmd = cmd; };

  exportToNotes('My Title', 'My Body', { execFn: stubExec });

  assert.ok(capturedCmd, 'execFn should have been called');
  assert.match(capturedCmd, /osascript/);
  assert.match(capturedCmd, /My Title/);
  assert.match(capturedCmd, /My Body/);
});

test('exportToNotes does not throw when execFn succeeds', () => {
  const stubExec = () => {};
  assert.doesNotThrow(() => exportToNotes('T', 'B', { execFn: stubExec }));
});

test('exportToNotes warns but does not throw when execFn throws', () => {
  const stubExec = () => { throw new Error('osascript not found'); };
  // Should warn, not throw — export failure must not break the main flow
  assert.doesNotThrow(() => exportToNotes('T', 'B', { execFn: stubExec }));
});

test('exportToNotes skips when platform is not darwin', () => {
  let called = false;
  const stubExec = () => { called = true; };
  exportToNotes('T', 'B', { execFn: stubExec, platform: 'linux' });
  assert.strictEqual(called, false, 'Should not call execFn on non-darwin');
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/notes.test.js
```

Expected: 4 new tests FAIL, 5 old tests still pass.

**Step 3: Implement exportToNotes in devlog.js**

Add `require` for child_process at the top of the file, alongside existing requires:

```javascript
const { execSync } = require('child_process');
```

Add `exportToNotes` to the Notes export section, after `buildNoteContent`:

```javascript
function exportToNotes(title, body, opts = {}) {
  const platform = opts.platform || process.platform;
  const execFn   = opts.execFn   || ((cmd) => execSync(cmd, { stdio: 'pipe' }));

  if (platform !== 'darwin') {
    warn('Apple Notes export is macOS only — skipping.');
    return;
  }

  // Escape single quotes in title and body for AppleScript
  const safeTitle = title.replace(/'/g, '\u2019');
  const safeBody  = body.replace(/'/g, '\u2019').replace(/\n/g, '\\n');

  const script = `tell application "Notes" to make new note at folder "Notes" with properties {name:"${safeTitle}", body:"${safeBody}"}`;

  try {
    execFn(`osascript -e '${script}'`);
  } catch (e) {
    warn(`Apple Notes export failed: ${e.message}`);
  }
}
```

Update exports to include `exportToNotes`:

```javascript
module.exports = { projectSlug, loadState, saveState, recordApprovals, passesPreGate, buildExtractionPrompt, extractStage1, buildStoryPrompt, buildTechnicalPrompt, generateStage2, buildNoteContent, exportToNotes };
```

**Step 4: Run to confirm pass**

```bash
node --test tests/notes.test.js
```

Expected: 9 pass, 0 fail.

Full suite:

```bash
node --test tests/state.test.js tests/gate.test.js tests/extract.test.js tests/generate.test.js tests/smoke.test.js tests/notes.test.js
```

Expected: 49 pass, 0 fail.

**Step 5: Commit**

```bash
git add tests/notes.test.js devlog.js
git commit -m "feat: exportToNotes shells to osascript with injectable execFn for testing"
```

---

### Task 3: Wire into main()

**Files:**
- Modify: `devlog.js` (add `--notes` flag constant, call in main)

**Step 1: Add CLI flag constant**

In the top-of-file flag parsing block, add:

```javascript
const SAVE_TO_NOTES = hasFlag('--notes');
```

**Step 2: Wire into main() after printResults**

In `main()`, after the `printResults(result, session.project);` call, add:

```javascript
  if (SAVE_TO_NOTES) {
    const noteTitle   = `Devlog · ${session.project} · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const noteContent = buildNoteContent(result, session.project, MODE);
    exportToNotes(noteTitle, noteContent);
    console.log(`  ✓ Saved to Apple Notes: "${noteTitle}"\n`);
  }
```

**Step 3: Update help line in printResults**

In `printResults`, find the footer line:

```javascript
console.log(`  --mode story|technical  --count N  --push`);
```

Replace with:

```javascript
console.log(`  --mode story|technical  --count N  --push  --notes`);
```

**Step 4: Verify syntax and tests**

```bash
cd "/Users/myrons/Claude Projects/devlog"
node --check devlog.js
node --test tests/state.test.js tests/gate.test.js tests/extract.test.js tests/generate.test.js tests/smoke.test.js tests/notes.test.js
```

Expected: syntax clean, 49 pass.

**Step 5: Commit**

```bash
git add devlog.js
git commit -m "feat: wire --notes flag into main() to export candidates to Apple Notes"
```

---

### Task 4: Manual smoke test

**No automated test for this — it requires a real macOS Notes app.**

**Step 1: Run with --notes**

```bash
cd "/Users/myrons/Claude Projects/devlog"
node devlog.js --notes --count 2
```

**Step 2: Verify**

- Terminal shows `✓ Saved to Apple Notes: "Devlog · <project> · Apr 25"` (or today's date)
- Open Apple Notes on Mac — a new note should appear in the Notes folder with the formatted candidates
- Note title matches what was printed

**Step 3: Run on a non-existent session to verify graceful fail**

If you have no sessions that pass the pre-gate, the tool exits before notes export — that's correct behavior.

**Step 4: Update CLAUDE.md**

The CLAUDE.md Quick start section already lists `--notes` because it's included in the footer line. No changes needed.

**Step 5: Final commit (if any cleanup needed)**

```bash
git add devlog.js
git commit -m "fix: notes export polish"
```

---

## Acceptance criteria

- `node --test tests/notes.test.js` — 9 tests pass
- Full suite — 49 tests pass
- `node devlog.js --notes` creates a new note in Apple Notes titled `Devlog · <project> · <date>`
- Note contains all candidates with formatting
- On Linux/Windows: prints warning, does not crash
- `exportToNotes` failure (Notes permissions) prints warning, does not crash or exit

## Out of scope

- Selective export (approved-only)
- Append to existing note
- Other note apps (Obsidian, Notion, Bear)
- Non-macOS support beyond the warning
