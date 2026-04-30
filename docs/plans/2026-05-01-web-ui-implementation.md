# Devlog Web UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--ui` flag to devlog that starts a local web server at localhost:3000, opens the browser, and serves a two-panel dark-theme UI: session picker → generate → review/edit candidates → post to X.

**Architecture:** Node's built-in `http` module serves a single-page app embedded as a template string in `devlog.js`. The pipeline logic is extracted into a `runPipeline()` function used by both CLI `main()` and the HTTP API. Zero new npm dependencies. Five additions to `devlog.js`: `--ui` flag constants, `runPipeline`, `handleGetSessions`, `handlePostGenerate`, `serveUi`. The HTML app is a `const HTML_APP` template string.

**Tech Stack:** Node.js built-ins only — `http`, `child_process.exec` (to open browser). Vanilla HTML/CSS/JS for the frontend. GitHub Pages for landing page.

---

### Task 1: `--ui` flag constants + `runPipeline` + `findSessions` refactor

**Files:**
- Modify: `devlog.js` (add constants, refactor findSessions, add runPipeline, update exports)
- Create: `tests/ui.test.js`

**Context:**
The current `main()` function runs the full pipeline inline. We need to extract it into a reusable `runPipeline(sessionFile, mode, count, opts)` so both the CLI and the HTTP API can call it. `findSessions()` currently reads the module-level `DAYS_FILTER` constant; we need it to accept an optional `opts.days` override so the UI can show 90 days of sessions regardless of `--days` flag.

**Step 1: Add constants to the flag block**

In `devlog.js`, after line 38 (`const SAVE_TO_NOTES = hasFlag('--notes');`), add:

```javascript
const USE_UI    = hasFlag('--ui');
const UI_PORT   = parseInt(getArg('--port') || '3000');
```

Also add `http` and `exec` to the requires at the top of the file (after the existing requires):

```javascript
const http           = require('http');
const { exec }       = require('child_process');
```

**Step 2: Refactor `findSessions` to accept opts**

Find the line:
```javascript
const cutoff   = Date.now() - DAYS_FILTER * 24 * 60 * 60 * 1000;
```

Change `findSessions()` signature and that line to:
```javascript
function findSessions(opts = {}) {
```
and:
```javascript
  const days   = (opts.days !== undefined) ? opts.days : DAYS_FILTER;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
```

The existing call in `main()` — `findSessions()` — still works because `opts` defaults to `{}`.

**Step 3: Add `readBody` helper**

Add this before `main()`, in the Notes export section or just before it:

```javascript
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
```

**Step 4: Add `runPipeline` function**

Add after `readBody`, before `main()`:

```javascript
async function runPipeline(sessionFile, mode, count, opts = {}) {
  const apiKey = opts.apiKey || ANTHROPIC_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  if (!fs.existsSync(sessionFile)) return { gateError: 'Session file not found.' };

  const rawText = fs.readFileSync(sessionFile, 'utf8');
  const gate    = passesPreGate(rawText);
  if (!gate.ok) return { gateError: gate.reason };

  const messages         = parseSession(sessionFile);
  const chunk            = chunkSession(messages);
  const slug             = projectSlug(path.basename(path.dirname(sessionFile)));
  const state            = loadState(slug, opts);
  const voiceExamples    = STYLE_FILE ? loadStyle(STYLE_FILE) : null;
  const sessionForPrompt = CONTEXT ? `Manual context from author: ${CONTEXT}\n\n---\n\n${chunk}` : chunk;

  const extraction = await extractStage1(sessionForPrompt, state, { apiKey, fetchFn: opts.fetchFn });

  if (extraction.best_output_type === 'nothing' && !extraction.active_arc) {
    return { nothing: true, message: 'Session had no articulated decisions or reasoning worth sharing.' };
  }

  return generateStage2(extraction, state, {
    mode: mode || 'story',
    count: count || 3,
    voiceExamples,
    apiKey,
    fetchFn: opts.fetchFn,
  });
}
```

**Step 5: Update exports**

Find the `module.exports` line at the bottom of the file and add `runPipeline`:

```javascript
module.exports = { projectSlug, loadState, saveState, recordApprovals, passesPreGate, buildExtractionPrompt, extractStage1, buildStoryPrompt, buildTechnicalPrompt, generateStage2, buildNoteContent, exportToNotes, runPipeline };
```

**Step 6: Write tests**

Create `tests/ui.test.js`:

```javascript
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const { runPipeline } = require('../devlog.js');

const RICH_SESSION = path.join(__dirname, 'fixtures', 'session-rich.jsonl');
const THIN_SESSION = path.join(__dirname, 'fixtures', 'session-thin.jsonl');

const FAKE_EXTRACTION = {
  has_reasoning: true,
  best_output_type: 'story',
  active_arc: null,
  decisions: [{ what: 'switched pricing', why: 'unit economics', alternatives: [], tradeoff: 'fewer signups' }],
  key_numbers: ['$0.16/scan'],
  wrong_about: null,
  moment_of_realization: 'looked at unit economics',
  quotable_lines: ['$0.16/scan at $19 = losing money'],
  technical_specifics: { stack: [], patterns: [], constraints: [] },
};

const FAKE_RESULT = {
  candidates: [{
    shape: 'single', type: 'story', label: 'pricing realization',
    text: 'three weeks with the wrong number.', tweets: null, arc: null, summary_for_state: 'pricing',
  }],
};

function makeFetchFn() {
  let call = 0;
  return async () => {
    call++;
    const body = call === 1
      ? JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(FAKE_EXTRACTION) }] })
      : JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(FAKE_RESULT) }] });
    return { ok: true, json: async () => JSON.parse(body) };
  };
}

test('runPipeline returns candidates for a rich session', async () => {
  const result = await runPipeline(RICH_SESSION, 'story', 2, {
    apiKey: 'test-key',
    fetchFn: makeFetchFn(),
  });
  assert.ok(Array.isArray(result.candidates), 'should have candidates array');
  assert.ok(result.candidates.length > 0);
});

test('runPipeline returns gateError for a thin session', async () => {
  const result = await runPipeline(THIN_SESSION, 'story', 2, {
    apiKey: 'test-key',
    fetchFn: makeFetchFn(),
  });
  assert.ok(result.gateError, 'should return gateError for thin session');
});

test('runPipeline returns gateError for non-existent file', async () => {
  const result = await runPipeline('/nonexistent/file.jsonl', 'story', 2, {
    apiKey: 'test-key',
    fetchFn: makeFetchFn(),
  });
  assert.ok(result.gateError);
});

test('runPipeline returns nothing:true when extraction has no reasoning', async () => {
  const noReasoningFetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        has_reasoning: false, best_output_type: 'nothing',
        active_arc: null, decisions: [], key_numbers: [],
        wrong_about: null, moment_of_realization: null,
        quotable_lines: [], technical_specifics: { stack: [], patterns: [], constraints: [] },
      }) }],
    }),
  });
  const result = await runPipeline(RICH_SESSION, 'story', 2, {
    apiKey: 'test-key',
    fetchFn: noReasoningFetch,
  });
  assert.strictEqual(result.nothing, true);
});
```

**Step 7: Run tests to confirm pass**

```bash
cd "/Users/myrons/Claude Projects/devlog"
node --check devlog.js
node --test tests/ui.test.js
```

Expected: 4 pass, 0 fail.

Run full suite:
```bash
node --test tests/state.test.js tests/gate.test.js tests/extract.test.js tests/generate.test.js tests/smoke.test.js tests/notes.test.js tests/ui.test.js
```

Expected: 55 pass, 0 fail.

**Step 8: Commit**

```bash
cd "/Users/myrons/Claude Projects/devlog"
git add devlog.js tests/ui.test.js
git commit -m "feat: add runPipeline, --ui flag constants, findSessions opts refactor"
```

---

### Task 2: HTTP server — `serveUi`, `handleRequest`, `handleGetSessions`, placeholder HTML

**Files:**
- Modify: `devlog.js` (add HTML_APP, serveUi, handleRequest, handleGetSessions, update entry point, update exports)

**Context:**
Build the HTTP server that serves the single-page app. `serveUi(opts)` starts a Node `http` server and opens the browser. `handleRequest` routes to the right handler. `handleGetSessions` returns session list JSON. The HTML is a placeholder for now (full UI comes in Task 4). `serveUi` accepts injectable `opts.skipOpen` and `opts.port` for testing. Export `serveUi` so tests can start it.

**Step 1: Add `HTML_APP` placeholder constant**

Add after the `VOICE_RULES` / `OUTPUT_FORMAT` constants (around line 170, before `formatExtraction`):

```javascript
// ─── Web UI ────────────────────────────────────────────────────────────────

const HTML_APP = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>devlog</title></head>
<body style="background:#0d0d0d;color:#e8e8e8;font-family:sans-serif;padding:40px">
  <h1>devlog</h1>
  <p style="color:#666">UI coming soon — placeholder</p>
</body>
</html>`;
```

**Step 2: Add `handleGetSessions` function**

Add after the `HTML_APP` constant:

```javascript
async function handleGetSessions(req, res) {
  const sessions = findSessions({ days: 90 });
  const data = sessions.map(s => ({
    project: s.project,
    file:    s.file,
    mtime:   s.mtime.toISOString(),
    sizeKb:  Math.round(s.size / 1024),
    age:     formatAge(s.mtime),
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
```

**Step 3: Add `handleRequest` function**

```javascript
async function handleRequest(req, res) {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'GET' && urlPath === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_APP);
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/sessions') {
    await handleGetSessions(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/generate') {
    await handlePostGenerate(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
```

Note: `handlePostGenerate` will be added in Task 3. Put a stub for now:

```javascript
async function handlePostGenerate(req, res) {
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not implemented yet' }));
}
```

**Step 4: Add `serveUi` function**

```javascript
async function serveUi(opts = {}) {
  const port     = opts.port !== undefined ? opts.port : UI_PORT;
  const skipOpen = opts.skipOpen || false;

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  const actualPort = server.address().port;
  console.log(`\n  devlog UI  →  http://localhost:${actualPort}\n`);
  if (!skipOpen) exec(`open http://localhost:${actualPort}`);

  return server;
}
```

**Step 5: Update entry point**

Find:
```javascript
if (require.main === module) {
  main().catch(e => die(e.message));
}
```

Replace with:
```javascript
if (require.main === module) {
  if (USE_UI) serveUi().catch(e => die(e.message));
  else main().catch(e => die(e.message));
}
```

**Step 6: Update exports**

Add `serveUi` to the exports:
```javascript
module.exports = { projectSlug, loadState, saveState, recordApprovals, passesPreGate, buildExtractionPrompt, extractStage1, buildStoryPrompt, buildTechnicalPrompt, generateStage2, buildNoteContent, exportToNotes, runPipeline, serveUi };
```

**Step 7: Write failing tests**

Add to `tests/ui.test.js`:

```javascript
const http = require('http');
const { serveUi } = require('../devlog.js');

async function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

test('GET / returns 200 with HTML content-type', async () => {
  const server = await serveUi({ port: 0, skipOpen: true });
  try {
    const port = server.address().port;
    const res  = await get(port, '/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('devlog'));
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('GET /unknown returns 404', async () => {
  const server = await serveUi({ port: 0, skipOpen: true });
  try {
    const port = server.address().port;
    const res  = await get(port, '/not-a-real-path');
    assert.strictEqual(res.status, 404);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('GET /api/sessions returns 200 with JSON array', async () => {
  const server = await serveUi({ port: 0, skipOpen: true });
  try {
    const port     = server.address().port;
    const res      = await get(port, '/api/sessions');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    const sessions = JSON.parse(res.body);
    assert.ok(Array.isArray(sessions));
    if (sessions.length > 0) {
      const s = sessions[0];
      assert.ok(typeof s.project === 'string');
      assert.ok(typeof s.file    === 'string');
      assert.ok(typeof s.sizeKb  === 'number');
      assert.ok(typeof s.age     === 'string');
    }
  } finally {
    await new Promise(r => server.close(r));
  }
});
```

**Step 8: Run tests**

```bash
node --check devlog.js
node --test tests/ui.test.js
```

Expected: 7 pass, 0 fail (4 from Task 1 + 3 new).

Full suite:
```bash
node --test tests/state.test.js tests/gate.test.js tests/extract.test.js tests/generate.test.js tests/smoke.test.js tests/notes.test.js tests/ui.test.js
```

Expected: 58 pass, 0 fail.

**Step 9: Commit**

```bash
git add devlog.js tests/ui.test.js
git commit -m "feat: HTTP server with session API and placeholder UI"
```

---

### Task 3: `handlePostGenerate` — generate API endpoint

**Files:**
- Modify: `devlog.js` (replace stub handlePostGenerate with real implementation)

**Context:**
Replace the `handlePostGenerate` stub from Task 2 with the real implementation. It reads `{sessionFile, mode, count}` from the POST body, calls `runPipeline`, and returns JSON. Handles validation errors (missing params, file not found) as 400 responses.

**Step 1: Write failing test**

Add to `tests/ui.test.js`:

```javascript
async function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = http.request({
      hostname: '127.0.0.1', port, path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('POST /api/generate without sessionFile returns 400', async () => {
  const server = await serveUi({ port: 0, skipOpen: true });
  try {
    const port = server.address().port;
    const res  = await post(port, '/api/generate', { mode: 'story', count: 2 });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('POST /api/generate with non-existent file returns gateError in body', async () => {
  const server = await serveUi({ port: 0, skipOpen: true });
  try {
    const port = server.address().port;
    const res  = await post(port, '/api/generate', { sessionFile: '/tmp/nonexistent.jsonl', mode: 'story', count: 2 });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.gateError);
  } finally {
    await new Promise(r => server.close(r));
  }
});
```

**Step 2: Run to confirm fail**

```bash
node --test tests/ui.test.js
```

Expected: 2 new tests fail (handlePostGenerate still returns 501).

**Step 3: Implement `handlePostGenerate`**

Replace the stub in `devlog.js`:

```javascript
async function handlePostGenerate(req, res) {
  let params;
  try {
    const body = await readBody(req);
    params = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const { sessionFile, mode, count } = params;
  if (!sessionFile) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'sessionFile is required' }));
    return;
  }

  try {
    const result = await runPipeline(sessionFile, mode || 'story', count || 3, {
      apiKey: ANTHROPIC_KEY,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
```

**Step 4: Run tests to confirm pass**

```bash
node --check devlog.js
node --test tests/ui.test.js
```

Expected: 9 pass, 0 fail.

Full suite:
```bash
node --test tests/state.test.js tests/gate.test.js tests/extract.test.js tests/generate.test.js tests/smoke.test.js tests/notes.test.js tests/ui.test.js
```

Expected: 60 pass, 0 fail.

**Step 5: Commit**

```bash
git add devlog.js tests/ui.test.js
git commit -m "feat: POST /api/generate endpoint calls runPipeline and returns candidates"
```

---

### Task 4: Full frontend HTML (replace placeholder `HTML_APP`)

**Files:**
- Modify: `devlog.js` (replace `HTML_APP` placeholder with full dark-theme single-page app)

**Context:**
Replace the placeholder `HTML_APP` string with the full two-panel dark UI. No new tests — manual verification. The HTML is a template literal assigned to `HTML_APP`. All JavaScript is inline. The UI fetches `/api/sessions` on load, shows a session list in the left panel, and POSTs to `/api/generate` when Generate is clicked. "Post to X →" opens `x.com/intent/tweet?text=...` in a new tab.

**Step 1: Replace `HTML_APP`**

Find and replace the entire `HTML_APP` constant (the placeholder set in Task 2) with:

```javascript
const HTML_APP = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>devlog</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d0d0d; --bg2: #141414; --bg3: #1a1a1a;
      --border: #222; --border2: #2a2a2a;
      --text: #e8e8e8; --text2: #888; --text3: #555;
      --blue: #1d6bf3; --blue2: #1a5fd4;
      --green: #4caf50; --yellow: #ff9800; --red: #f44336;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    header { height: 52px; padding: 0 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
    .logo { font-size: 16px; font-weight: 700; letter-spacing: -0.3px; }
    .logo em { color: var(--text3); font-style: normal; font-weight: 400; }
    #session-info { font-size: 13px; color: var(--text2); }
    .layout { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 260px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
    .controls { padding: 14px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
    .mode-row { display: flex; gap: 6px; }
    .mode-btn { flex: 1; padding: 6px 0; background: transparent; border: 1px solid var(--border2); border-radius: 5px; color: var(--text3); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
    .mode-btn.active { background: var(--bg3); border-color: #444; color: var(--text); }
    .count-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--text2); }
    .count-input { width: 44px; background: var(--bg3); border: 1px solid var(--border2); border-radius: 4px; color: var(--text); font-size: 12px; padding: 4px 8px; text-align: center; }
    .gen-btn { padding: 9px; background: var(--blue); color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s; }
    .gen-btn:hover:not(:disabled) { background: var(--blue2); }
    .gen-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .session-list { flex: 1; overflow-y: auto; }
    .session-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #111; transition: background 0.1s; }
    .session-item:hover { background: #111; }
    .session-item.selected { background: rgba(29,107,243,0.08); border-left: 2px solid var(--blue); padding-left: 12px; }
    .s-project { font-size: 13px; font-weight: 500; }
    .s-meta { font-size: 11px; color: var(--text3); margin-top: 2px; }
    .main { flex: 1; overflow-y: auto; padding: 24px; }
    .empty-state { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text3); font-size: 14px; text-align: center; flex-direction: column; gap: 12px; }
    .empty-icon { font-size: 36px; opacity: 0.3; }
    .loading { display: flex; align-items: center; justify-content: center; height: 200px; gap: 12px; color: var(--text2); font-size: 14px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { width: 18px; height: 18px; border: 2px solid var(--border2); border-top-color: var(--blue); border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
    .candidate { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 18px; margin-bottom: 14px; }
    .cand-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .badge { font-size: 10px; font-weight: 600; letter-spacing: 0.5px; padding: 2px 7px; border-radius: 4px; background: var(--bg3); border: 1px solid var(--border2); color: var(--text2); }
    .cand-label { font-size: 13px; color: var(--text2); }
    .tweet-box { font-family: 'SF Mono', 'Fira Code', Monaco, monospace; font-size: 13px; line-height: 1.65; color: var(--text); background: var(--bg); border: 1px solid var(--border2); border-radius: 6px; padding: 12px; width: 100%; resize: vertical; min-height: 72px; }
    .tweet-box:focus { outline: none; border-color: #383838; }
    .tweet-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
    .char-ok { color: var(--green); font-size: 12px; }
    .char-warn { color: var(--yellow); font-size: 12px; }
    .char-over { color: var(--red); font-size: 12px; }
    .post-btn { padding: 6px 14px; background: #000; color: var(--text); border: 1px solid var(--border2); border-radius: 5px; font-size: 12px; font-weight: 500; cursor: pointer; transition: border-color 0.15s; }
    .post-btn:hover { border-color: #555; }
    .thread-tweet { margin-bottom: 12px; }
    .thread-num { font-size: 11px; color: var(--text3); margin-bottom: 4px; }
    .msg-box { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 20px; font-size: 14px; line-height: 1.6; color: var(--text2); }
    .error-box { background: #1a0a0a; border: 1px solid #3a1515; border-radius: 8px; padding: 16px; font-size: 13px; color: #e57373; }
  </style>
</head>
<body>
  <header>
    <div class="logo">devlog<em> ✦</em></div>
    <div id="session-info"></div>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <div class="controls">
        <div class="mode-row">
          <button class="mode-btn active" id="btn-story" onclick="setMode('story')">Story</button>
          <button class="mode-btn" id="btn-technical" onclick="setMode('technical')">Technical</button>
        </div>
        <div class="count-row">
          <span>Candidates</span>
          <input class="count-input" id="count" type="number" min="1" max="10" value="3">
        </div>
        <button class="gen-btn" id="gen-btn" onclick="generate()" disabled>Generate</button>
      </div>
      <div class="session-list" id="session-list">
        <div class="s-meta" style="padding:14px">Loading…</div>
      </div>
    </aside>
    <main class="main" id="main">
      <div class="empty-state">
        <div class="empty-icon">✦</div>
        <div>Select a session and hit Generate</div>
      </div>
    </main>
  </div>
  <script>
    var selected = null, mode = 'story';
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function charHtml(text) {
      var n = (text||'').length, cls = n<=260?'char-ok':n<=280?'char-warn':'char-over', icon = n<=260?'✓':n<=280?'⚠':'✗';
      return '<span class="'+cls+'">'+icon+' '+n+'/280</span>';
    }
    function updateChar(el, cid) { document.getElementById(cid).innerHTML = charHtml(el.value); }
    function postToX(tid) { window.open('https://x.com/intent/tweet?text='+encodeURIComponent(document.getElementById(tid).value),'_blank'); }
    function setMode(m) {
      mode = m;
      document.getElementById('btn-story').classList.toggle('active', m==='story');
      document.getElementById('btn-technical').classList.toggle('active', m==='technical');
    }
    function pick(i) {
      document.querySelectorAll('.session-item').forEach(function(el){el.classList.remove('selected');});
      document.getElementById('si'+i).classList.add('selected');
      selected = window.__sessions[i];
      document.getElementById('session-info').textContent = selected.project+' · '+selected.age;
      document.getElementById('gen-btn').disabled = false;
    }
    async function init() {
      try {
        var res = await fetch('/api/sessions'), sessions = await res.json();
        window.__sessions = sessions;
        var list = document.getElementById('session-list');
        if (!sessions.length) { list.innerHTML='<div class="s-meta" style="padding:14px">No sessions. Run with --days 30.</div>'; return; }
        list.innerHTML = sessions.map(function(s,i){ return '<div class="session-item" id="si'+i+'" onclick="pick('+i+')">'+'<div class="s-project">'+esc(s.project)+'</div>'+'<div class="s-meta">'+esc(s.age)+' · '+s.sizeKb+'kb</div>'+'</div>'; }).join('');
      } catch(e) { document.getElementById('session-list').innerHTML='<div class="s-meta" style="padding:14px;color:#e57373">Failed to load sessions</div>'; }
    }
    async function generate() {
      if (!selected) return;
      var count = parseInt(document.getElementById('count').value)||3;
      var main = document.getElementById('main');
      main.innerHTML = '<div class="loading"><div class="spinner"></div><span>Extracting reasoning…</span></div>';
      document.getElementById('gen-btn').disabled = true;
      try {
        var res = await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionFile:selected.file,mode:mode,count:count})});
        var data = await res.json();
        if (data.error) { main.innerHTML='<div class="error-box">Error: '+esc(data.error)+'</div>'; }
        else if (data.nothing||data.gateError) { main.innerHTML='<div class="msg-box">'+esc(data.message||data.gateError||'Nothing to share.')+'</div>'; }
        else { renderCandidates(data.candidates||[]); }
      } catch(e) { main.innerHTML='<div class="error-box">Request failed: '+esc(e.message)+'</div>'; }
      finally { document.getElementById('gen-btn').disabled=false; }
    }
    function renderCandidates(candidates) {
      var main = document.getElementById('main');
      if (!candidates.length) { main.innerHTML='<div class="msg-box">No candidates returned.</div>'; return; }
      main.innerHTML = candidates.map(function(c,i){
        var badge = (c.shape||'single').toUpperCase()+' · '+(c.type||'story').toUpperCase(), label = esc(c.label||'');
        if (c.shape==='thread') {
          var tweets = c.tweets||[];
          return '<div class="candidate"><div class="cand-header"><span class="badge">'+badge+'</span><span class="cand-label">'+label+'</span></div><div>'+
            tweets.map(function(t,j){ var tid='tw'+i+'_'+j, cid='cc'+i+'_'+j;
              return '<div class="thread-tweet"><div class="thread-num">'+(j+1)+'/'+tweets.length+'</div>'+
                '<textarea class="tweet-box" id="'+tid+'" oninput="updateChar(this,\''+cid+'\')">'+esc(t||'')+'</textarea>'+
                '<div class="tweet-footer"><span id="'+cid+'">'+charHtml(t||'')+'</span>'+
                '<button class="post-btn" onclick="postToX(\''+tid+'\')">Post to X →</button></div></div>';
            }).join('')+'</div></div>';
        }
        var text=c.text||'', tid='tw'+i, cid='cc'+i;
        return '<div class="candidate"><div class="cand-header"><span class="badge">'+badge+'</span><span class="cand-label">'+label+'</span></div>'+
          '<textarea class="tweet-box" id="'+tid+'" oninput="updateChar(this,\''+cid+'\')">'+esc(text)+'</textarea>'+
          '<div class="tweet-footer"><span id="'+cid+'">'+charHtml(text)+'</span>'+
          '<button class="post-btn" onclick="postToX(\''+tid+'\')">Post to X →</button></div></div>';
      }).join('');
    }
    init();
  </script>
</body>
</html>`;
```

**Step 2: Verify syntax**

```bash
cd "/Users/myrons/Claude Projects/devlog"
node --check devlog.js
node --test tests/ui.test.js
```

Expected: syntax clean, 9 pass (all existing tests — no new tests for this task).

**Step 3: Manual smoke test**

```bash
node devlog.js --ui --days 14
```

Verify:
- Browser opens at localhost:3000
- Session list appears in left panel with project names and ages
- Clicking a session highlights it and updates the header
- Clicking Generate shows spinner then candidates
- Each candidate has tweet text, character counter, Post to X button
- "Post to X →" opens x.com with tweet pre-filled
- Mode toggle switches between Story and Technical

**Step 4: Commit**

```bash
git add devlog.js
git commit -m "feat: full dark-theme web UI with session picker, generate, and post to X"
```

---

### Task 5: Landing page

**Files:**
- Create: `docs/index.html`

**Context:**
Static landing page served by GitHub Pages (GitHub auto-serves `docs/index.html` when configured). This is the Product Hunt hook — shows what devlog produces, how to install it, and the meta-story. No server-side code. Pure HTML/CSS.

**Step 1: Enable GitHub Pages**

This happens in GitHub repo settings (Settings → Pages → Source: `docs/` folder). Do this after pushing. No code changes needed.

**Step 2: Create `docs/index.html`**

```bash
ls "/Users/myrons/Claude Projects/devlog/docs"
```

The `docs/` folder exists (contains `plans/`). Create `docs/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>devlog — turn your Claude Code sessions into posts worth reading</title>
  <meta name="description" content="Devlog reads your Claude Code sessions, finds the reasoning behind your decisions, and writes the tweet. You hit Post.">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg: #0d0d0d; --bg2: #141414; --border: #222; --text: #e8e8e8; --text2: #888; --text3: #555; --blue: #1d6bf3; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    nav { padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); }
    .nav-logo { font-weight: 700; font-size: 18px; letter-spacing: -0.3px; }
    .nav-link { font-size: 14px; color: var(--text2); }

    /* Hero */
    .hero { max-width: 720px; margin: 0 auto; padding: 80px 40px 60px; text-align: center; }
    .hero h1 { font-size: clamp(28px, 5vw, 48px); font-weight: 700; letter-spacing: -1px; line-height: 1.15; margin-bottom: 20px; }
    .hero h1 em { color: var(--text3); font-style: normal; }
    .hero p { font-size: 18px; color: var(--text2); max-width: 520px; margin: 0 auto 36px; }
    .install { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px 24px; font-family: 'SF Mono', Monaco, monospace; font-size: 14px; display: inline-block; margin-bottom: 12px; }
    .install span { color: var(--text3); }
    .sub-install { font-size: 13px; color: var(--text3); }

    /* Screenshot placeholder */
    .screenshot { max-width: 900px; margin: 0 auto 80px; padding: 0 40px; }
    .screen-frame { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .screen-bar { height: 36px; background: #111; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 14px; gap: 7px; }
    .dot { width: 11px; height: 11px; border-radius: 50%; }
    .dot-r { background: #ff5f57; } .dot-y { background: #febc2e; } .dot-g { background: #28c840; }
    .screen-body { display: flex; height: 400px; }
    .screen-sidebar { width: 220px; border-right: 1px solid var(--border); padding: 14px; flex-shrink: 0; }
    .screen-main { flex: 1; padding: 20px; }
    .fake-item { padding: 8px 10px; border-radius: 5px; margin-bottom: 4px; font-size: 12px; }
    .fake-item.sel { background: rgba(29,107,243,0.1); border-left: 2px solid #1d6bf3; }
    .fake-item .p { font-weight: 600; color: var(--text); }
    .fake-item .m { color: var(--text3); font-size: 11px; }
    .fake-card { background: #111; border: 1px solid var(--border); border-radius: 6px; padding: 14px; margin-bottom: 12px; }
    .fake-badge { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 3px; background: #1a1a1a; border: 1px solid #2a2a2a; color: #888; display: inline-block; margin-bottom: 10px; }
    .fake-tweet { font-family: monospace; font-size: 12px; color: var(--text); line-height: 1.6; margin-bottom: 10px; }
    .fake-footer { display: flex; justify-content: space-between; align-items: center; }
    .fake-count { font-size: 11px; color: #4caf50; }
    .fake-btn { font-size: 11px; padding: 4px 10px; background: #000; border: 1px solid #333; border-radius: 4px; color: var(--text); }

    /* Examples */
    .examples { max-width: 720px; margin: 0 auto 80px; padding: 0 40px; }
    .examples h2 { font-size: 24px; font-weight: 600; margin-bottom: 8px; text-align: center; }
    .examples-sub { font-size: 14px; color: var(--text2); text-align: center; margin-bottom: 36px; }
    .example-tweet { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 14px; font-size: 14px; line-height: 1.7; }
    .example-tweet .label { font-size: 11px; color: var(--text3); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }

    /* How it works */
    .how { max-width: 720px; margin: 0 auto 80px; padding: 0 40px; }
    .how h2 { font-size: 24px; font-weight: 600; margin-bottom: 36px; text-align: center; }
    .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
    .step { text-align: center; }
    .step-num { width: 36px; height: 36px; border-radius: 50%; background: var(--bg2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; margin: 0 auto 12px; }
    .step h3 { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    .step p { font-size: 13px; color: var(--text2); }

    /* Meta */
    .meta { max-width: 720px; margin: 0 auto 80px; padding: 0 40px; text-align: center; }
    .meta p { font-size: 14px; color: var(--text2); margin-bottom: 8px; }

    /* Footer */
    footer { border-top: 1px solid var(--border); padding: 24px 40px; text-align: center; font-size: 13px; color: var(--text3); }

    @media (max-width: 600px) {
      .steps { grid-template-columns: 1fr; }
      .hero, .screenshot, .examples, .how, .meta { padding: 0 20px; }
      .hero { padding-top: 48px; }
      .screen-body { height: auto; flex-direction: column; }
      .screen-sidebar { width: 100%; border-right: none; border-bottom: 1px solid var(--border); }
    }
  </style>
</head>
<body>
  <nav>
    <div class="nav-logo">devlog ✦</div>
    <a href="https://github.com/myrons/devlog" class="nav-link">GitHub →</a>
  </nav>

  <section class="hero">
    <h1>Turn your Claude Code sessions into<br><em>posts people actually want to read</em></h1>
    <p>Devlog finds the reasoning behind your decisions and writes the tweet. You hit Post.</p>
    <div class="install"><span>$</span> git clone https://github.com/myrons/devlog &amp;&amp; node devlog.js --ui</div><br>
    <div class="sub-install">macOS · Node 18+ · zero dependencies</div>
  </section>

  <section class="screenshot">
    <div class="screen-frame">
      <div class="screen-bar">
        <div class="dot dot-r"></div><div class="dot dot-y"></div><div class="dot dot-g"></div>
      </div>
      <div class="screen-body">
        <div class="screen-sidebar">
          <div style="font-size:11px;color:#555;margin-bottom:10px">Sessions</div>
          <div class="fake-item sel"><div class="p">clipmatic</div><div class="m">2h ago · 14kb</div></div>
          <div class="fake-item"><div class="p">parsha</div><div class="m">5h ago · 4235kb</div></div>
          <div class="fake-item"><div class="p">devlog</div><div class="m">1d ago · 1461kb</div></div>
        </div>
        <div class="screen-main">
          <div class="fake-card">
            <div class="fake-badge">SINGLE · STORY</div>
            <div class="fake-tweet">three weeks with the wrong number.<br>$0.16/scan at $19 = losing money on<br>every heavy user. fixed: $29 + 100-scan<br>cap. most users do under 50 anyway.</div>
            <div class="fake-footer">
              <div class="fake-count">✓ 187/280</div>
              <div class="fake-btn">Post to X →</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="examples">
    <h2>Real output</h2>
    <p class="examples-sub">Generated from actual Claude Code sessions — unedited</p>
    <div class="example-tweet">
      <div class="label">Story · single</div>
      three weeks with the wrong number. $0.16/scan at $19 = losing money on every heavy user. fixed: $29 + 100-scan cap. most users do under 50 anyway.
    </div>
    <div class="example-tweet">
      <div class="label">Story · thread (1/3)</div>
      found 9 Christian references buried in Parsha Map's content. 4 direct Gospel mentions, 2 NT citations, 1 Tissot painting of Jesus healing lepers — in a Jewish Torah learning app. had to clean it all out.
    </div>
    <div class="example-tweet">
      <div class="label">Technical · single</div>
      <code>systemBackgroundColor</code> in LaunchScreen.storyboard resolves to black in dark mode. hardcoded <code>#fcf9f0</code> instead. less dynamic, guaranteed correct. sometimes the boring fix is the right fix.
    </div>
  </section>

  <section class="how">
    <h2>How it works</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <h3>Session</h3>
        <p>Pick any Claude Code session. Devlog reads the conversation, not the diff.</p>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <h3>Extract</h3>
        <p>Haiku finds the decisions, trade-offs, and numbers. Sonnet turns them into posts.</p>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <h3>Post</h3>
        <p>Edit inline. Hit Post to X. One click opens a pre-filled tweet composer.</p>
      </div>
    </div>
  </section>

  <section class="meta">
    <p>Built in public using itself. Every post about building devlog was generated by devlog.</p>
    <p><a href="https://x.com/myrons">Follow the build →</a></p>
  </section>

  <footer>
    devlog is open source · <a href="https://github.com/myrons/devlog">github.com/myrons/devlog</a>
  </footer>
</body>
</html>
```

**Step 3: Verify it opens**

```bash
open "/Users/myrons/Claude Projects/devlog/docs/index.html"
```

Verify the landing page looks right in the browser. Adjust any copy as needed.

**Step 4: Commit**

```bash
cd "/Users/myrons/Claude Projects/devlog"
git add docs/index.html
git commit -m "feat: landing page for Product Hunt launch"
```

---

## Acceptance criteria

- `node devlog.js --ui` opens `http://localhost:3000` in the browser
- Session list shows projects from the last 90 days
- Clicking a session + Generate runs the pipeline and shows candidates
- Each candidate has inline-editable tweet text with character counter
- "Post to X →" opens `x.com/intent/tweet?text=...` in a new tab
- Sessions with no reasoning show a clear "no story today" message
- CLI mode (`node devlog.js --list`) still works unchanged
- `node --test tests/ui.test.js` — 9 pass
- Full suite — 60 pass
- `docs/index.html` renders correctly in browser

## Out of scope

- Hosted/cloud version
- User accounts / auth
- Scheduling posts
- X API direct posting
- Session history / saved drafts
- LinkedIn generation
