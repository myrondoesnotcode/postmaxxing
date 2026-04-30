#!/usr/bin/env node

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const rl             = require('readline');
const { execSync }   = require('child_process');
const { exec }       = require('child_process');
const http           = require('http');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim().replace(/^['"]|['"]$/g, '');
    });
}
loadEnv();

const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY;
const TYPEFULLY_KEY      = process.env.TYPEFULLY_API_KEY;
const CLAUDE_DIR         = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const MAX_CHARS          = 12000;
const MIN_SESSION_BYTES  = 5 * 1024;
const MIN_SESSION_LINES  = 8; // 4 exchanges × 2 messages
const HAIKU_MODEL        = 'claude-haiku-4-5';
const SONNET_MODEL       = 'claude-sonnet-4-6';

const args     = process.argv.slice(2);
const getArg   = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag  = (flag) => args.includes(flag);

const PROJECT_FILTER = getArg('--project');
const DAYS_FILTER    = parseInt(getArg('--days') || '1');
const STYLE_FILE     = getArg('--style');
const PUSH_TO_TF     = hasFlag('--push');
const SAVE_TO_NOTES  = hasFlag('--notes');
const LIST_MODE      = hasFlag('--list');
const USE_UI         = hasFlag('--ui');
const UI_PORT        = parseInt(getArg('--port') || '3000');
const MODE           = getArg('--mode')    || 'story';  // story | technical
const CONTEXT        = getArg('--context') || null;     // optional one-line hint
const COUNT          = parseInt(getArg('--count') || '5');

if (!['story', 'technical'].includes(MODE)) {
  die(`Invalid --mode: ${MODE}. Use 'story' or 'technical'.`);
}

// ─── Pre-gate ─────────────────────────────────────────────────────────────

function passesPreGate(rawText) {
  if (rawText.length < MIN_SESSION_BYTES) {
    return { ok: false, reason: `Session too short (${rawText.length} bytes, need ${MIN_SESSION_BYTES}).` };
  }
  const lineCount = rawText.trim().split('\n').filter(Boolean).length;
  if (lineCount < MIN_SESSION_LINES) {
    return { ok: false, reason: `Session has too few messages (${lineCount} lines, need ${MIN_SESSION_LINES}).` };
  }
  return { ok: true };
}

// ─── Stage 1: Extraction ──────────────────────────────────────────────────

function buildExtractionPrompt(sessionText, state) {
  const arcsBlock = state.active_arcs.length
    ? `Active feature arcs in flight:\n${state.active_arcs.map(a => `- ${a}`).join('\n')}`
    : 'No active arcs yet.';

  const recentBlock = state.recent_posts.length
    ? `Recently posted (most recent first):\n${state.recent_posts.slice(-5).reverse().map(p => `- [${p.date}] (${p.type}) ${p.summary}`).join('\n')}`
    : 'No recent posts.';

  return `You are extracting reasoning and decisions from a coding session for a builder who shares their process publicly.

${arcsBlock}

${recentBlock}

Read the session and return ONLY strict JSON — no prose, no markdown fences. Do not invent or infer anything not explicitly present in the session.

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
- has_reasoning: true only if the session contains an articulated decision, trade-off, or realization. Pure debugging without a "why" = false.
- best_output_type:
  - "story" if has_reasoning and the insight stands alone
  - "continuation" if it extends one of the active arcs listed above
  - "drip" if small but real (a brief update worth noting)
  - "nothing" if there is genuinely no signal worth sharing
- quotable_lines: copy verbatim from what the user said in the session. Do not paraphrase.
- active_arc: if best_output_type is "continuation", set this to the matching arc name from the active arcs list above; if "story" and the session starts a new ongoing theme, name it; otherwise null.
- Only include items explicitly present in the session text below.

Session:
${sessionText}`;
}

async function extractStage1(sessionText, state, opts) {
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const apiKey  = opts.apiKey;
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

  const raw   = data.content?.find(b => b.type === 'text')?.text || '';
  // Strip markdown fences, then extract the first {...} block to handle leading prose
  const stripped = raw.replace(/```json|```/g, '').trim();
  const match    = stripped.match(/\{[\s\S]*\}/);
  const clean    = match ? match[0] : stripped;

  try { return JSON.parse(clean); }
  catch { throw new Error(`Couldn't parse Stage 1 response:\n${raw}`); }
}

// ─── Stage 2: Generation ───────────────────────────────────────────────────

const VOICE_RULES = `Voice rules (non-negotiable):
- Specific over vague. Use real numbers and concrete details from the extraction.
- Honest over hyped. No "excited to share", no "thrilled to", no "game-changer".
- No em-dashes. Use commas, periods, or line breaks.
- 1 hashtag max per post, often zero.
- Lowercase opens are fine. Reads like a journal entry made public.
- If something was wrong or surprising, say so plainly.`;

const OUTPUT_FORMAT = `Return strict JSON only, no markdown fences:
{
  "candidates": [
    {
      "shape": "single" or "thread",
      "type": "story" or "continuation" or "drip",
      "label": "short descriptive label",
      "text": "tweet text (for shape:single, otherwise null)",
      "tweets": ["tweet 1", "tweet 2", ...] (for shape:thread, otherwise null),
      "arc": "arc name this continues, or null",
      "summary_for_state": "one-line summary of this post for the project journal"
    }
  ]
}
Rules: for shape "single", tweets must be null. For shape "thread", text must be null.
Single tweets must be ≤ 280 characters. Thread tweets must each be ≤ 280 characters.`;

// ─── Web UI ────────────────────────────────────────────────────────────────

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

function formatExtraction(extraction) {
  return JSON.stringify(extraction, null, 2);
}

function formatRecentPosts(state) {
  if (!state.recent_posts.length) return 'No recent posts.';
  return state.recent_posts.slice(-5).reverse()
    .map(p => `- [${p.date}] (${p.type}) ${p.summary}`)
    .join('\n');
}

function buildStoryPrompt(extraction, state, opts) {
  const { count, voiceExamples } = opts;
  const voiceBlock = voiceExamples
    ? `\nThis person's real posts for tone reference:\n---\n${voiceExamples.slice(0, 2000)}\n---\n`
    : '';

  return `You are ghost-writing building-in-public posts. Lens: STORY — surface the product or business reasoning behind decisions. Who made a choice, why they made it, and what it means.

Extraction (ground truth — every claim must trace here):
${formatExtraction(extraction)}

Recent posts (so you can write continuations and avoid repetition):
${formatRecentPosts(state)}
${voiceBlock}
${VOICE_RULES}

Generate ${count} candidates. Each candidate picks its own shape:
- "single" when one tight insight lands in ≤ 280 chars
- "thread" (3-5 tweets, each ≤ 280) when the reasoning needs space

If best_output_type is "drip", keep it short and casual. If "continuation", reference the arc explicitly.

${OUTPUT_FORMAT}`;
}

function buildTechnicalPrompt(extraction, state, opts) {
  const { count, voiceExamples } = opts;
  const voiceBlock = voiceExamples
    ? `\nThis person's real posts for tone reference:\n---\n${voiceExamples.slice(0, 2000)}\n---\n`
    : '';

  return `You are ghost-writing building-in-public posts. Lens: TECHNICAL — surface the engineering decisions, stack choices, patterns, and trade-offs. Audience is developers who want the actual details. Don't dumb it down.

Extraction (ground truth — every claim must trace here):
${formatExtraction(extraction)}

Recent posts (for continuation and avoiding repetition):
${formatRecentPosts(state)}
${voiceBlock}
${VOICE_RULES}

Generate ${count} candidates. Lean into specifics: library names, patterns, constraints, the trade-off accepted. Each candidate picks its own shape:
- "single" for one sharp technical observation (≤ 280 chars)
- "thread" for a chain of decisions or a non-obvious trade-off explained

If best_output_type is "drip", keep it brief. If "continuation", reference the arc.

${OUTPUT_FORMAT}`;
}

async function generateStage2(extraction, state, opts) {
  const fetchFn      = opts.fetchFn || globalThis.fetch;
  const { mode, count, voiceExamples, apiKey } = opts;
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

  const raw   = data.content?.find(b => b.type === 'text')?.text || '';
  const clean = raw.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed?.candidates)) {
      throw new Error(`Stage 2 response missing candidates array:\n${raw}`);
    }
    return parsed;
  } catch (e) { throw new Error(`Couldn't parse Stage 2 response: ${e.message}\n${raw}`); }
}

// ─── Session discovery ─────────────────────────────────────────────────────

function findSessions(opts = {}) {
  if (!fs.existsSync(CLAUDE_DIR)) die(`Claude projects dir not found: ${CLAUDE_DIR}`);

  const days   = (opts.days !== undefined) ? opts.days : DAYS_FILTER;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const sessions = [];

  const projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  for (const dir of projectDirs) {
    const projectName = projectSlug(dir);
    if (PROJECT_FILTER && !projectName.toLowerCase().includes(PROJECT_FILTER.toLowerCase())) continue;

    const dirPath = path.join(CLAUDE_DIR, dir);
    const files   = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat     = fs.statSync(filePath);
      if (stat.mtime.getTime() < cutoff) continue;
      sessions.push({ project: projectName, file: filePath, mtime: stat.mtime, size: stat.size });
    }
  }

  return sessions.sort((a, b) => b.mtime - a.mtime);
}

function projectSlug(dir) {
  if (!dir) return dir;
  const stripped = dir.replace(/^-/, '').replace(/-/g, '/');
  const last = stripped.split('/').filter(Boolean).pop();
  return last || '';
}

// ─── Session parsing ───────────────────────────────────────────────────────

function parseSession(filePath) {
  const lines    = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      let role, content;

      if (entry.type === 'user' || entry.type === 'assistant') {
        role    = entry.type;
        content = extractContent((entry.message || entry).content);
      } else if (entry.role === 'user' || entry.role === 'assistant') {
        role    = entry.role;
        content = extractContent(entry.content);
      } else continue;

      if (content && content.length > 20) messages.push({ role, content });
    } catch { }
  }

  return messages;
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return '';
}

// ─── Smart chunking ────────────────────────────────────────────────────────

function chunkSession(messages) {
  const full = messages.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');
  if (full.length <= MAX_CHARS) return full;

  const exchanges = [];
  for (let i = 0; i < messages.length - 1; i += 2) {
    const combined = (messages[i]?.content || '') + ' ' + (messages[i+1]?.content || '');
    exchanges.push({ score: scoreDecisionDensity(combined), index: i });
  }
  exchanges.sort((a, b) => b.score - a.score);

  const selected = new Set([0, ...exchanges.slice(-2).map(e => e.index)]);
  for (const ex of exchanges) {
    if (selected.has(ex.index)) continue;
    selected.add(ex.index);
    if (buildChunk(messages, selected).length > MAX_CHARS) { selected.delete(ex.index); break; }
  }
  return buildChunk(messages, selected);
}

function scoreDecisionDensity(text) {
  return [
    /\b(actually|realized|wrong|changed|decided|switched|dropped|pivoted)\b/gi,
    /\b(turns out|it works|discovered|the problem)\b/gi,
    /\$[\d,.]+/g, /\d+[x%]/g,
    /\b(cost|price|margin|users|tokens|sessions)\b/gi,
  ].reduce((s, re) => s + (text.match(re)?.length || 0), 0);
}

function buildChunk(messages, selectedIndices) {
  const sorted = [...selectedIndices].sort((a, b) => a - b);
  const parts  = [];
  let prev     = -1;
  for (const idx of sorted) {
    if (idx > prev + 1) parts.push('[...omitted...]');
    if (messages[idx])   parts.push(`[USER]: ${messages[idx].content}`);
    if (messages[idx+1]) parts.push(`[ASSISTANT]: ${messages[idx+1].content}`);
    prev = idx + 1;
  }
  return parts.join('\n\n');
}

// ─── Style loading ─────────────────────────────────────────────────────────

function loadStyle(stylePath) {
  if (!stylePath || !fs.existsSync(stylePath)) return null;
  try {
    const raw  = fs.readFileSync(stylePath, 'utf8');
    const json = raw.replace(/^window\.\S+\s*=\s*/, '').trim();
    return JSON.parse(json)
      .map(item => item.tweet?.full_text || item.full_text || '')
      .filter(t => t && !t.startsWith('RT @') && t.length > 40)
      .slice(0, 50).join('\n---\n');
  } catch (e) { warn(`Couldn't parse style file: ${e.message}`); return null; }
}

// ─── Typefully push ────────────────────────────────────────────────────────

async function pushToTypefully(content) {
  if (!TYPEFULLY_KEY) die('Missing TYPEFULLY_API_KEY in .env');
  const res = await fetch('https://api.typefully.com/v1/drafts/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': `Bearer ${TYPEFULLY_KEY}` },
    body: JSON.stringify({ content, threadify: false }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || res.statusText);
  return data;
}

// ─── Output ────────────────────────────────────────────────────────────────

function printResults(result, projectName) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  devlog  ·  ${projectName}  ·  mode:${MODE}`);
  console.log(`${'─'.repeat(60)}\n`);

  if (!result.candidates || result.candidates.length === 0) {
    console.log('  (no candidates returned)\n');
    return;
  }

  result.candidates.forEach((c, i) => {
    const tag = `[${(c.shape || 'unknown').toUpperCase()} · ${(c.type || 'unknown').toUpperCase()}]`;
    console.log(`  ${i + 1}. ${tag}  ${c.label || ''}`);
    if (c.shape === 'single') {
      const len = (c.text || '').length;
      console.log(`     ${len > 260 ? '⚠' : '✓'} ${len}/280\n`);
      console.log(`     ${(c.text || '').replace(/\n/g, '\n     ')}\n`);
    } else {
      const tweets = c.tweets || [];
      console.log(`     ${tweets.length} tweets\n`);
      tweets.forEach((t, j) => {
        const len = (t || '').length;
        console.log(`     ${j + 1}/${tweets.length} ${len > 260 ? '⚠' : '✓'} ${len}/280`);
        console.log(`     ${(t || '').replace(/\n/g, '\n     ')}\n`);
      });
    }
    console.log(`  ${'·'.repeat(40)}\n`);
  });

  console.log(`${'─'.repeat(60)}`);
  console.log(`  --mode story|technical  --count N  --push  --notes`);
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── Interactive session picker ────────────────────────────────────────────

async function pickSession(sessions) {
  if (sessions.length === 0) die('No sessions found. Try --days 7.');
  console.log('\nAvailable sessions:\n');
  sessions.slice(0, 15).forEach((s, i) => {
    console.log(`  ${String(i+1).padStart(2)}. [${s.project.padEnd(20)}]  ${formatAge(s.mtime).padEnd(12)}  ${(s.size/1024).toFixed(0)}kb`);
  });
  const answer = await prompt('\nPick a number (Enter for #1): ');
  return sessions[Math.max(0, parseInt(answer || '1') - 1)] || sessions[0];
}

// ─── State management ─────────────────────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatAge(date) {
  const mins = Math.floor((Date.now() - date) / 60000);
  if (mins < 60)   return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins/60)}h ago`;
  return `${Math.floor(mins/1440)}d ago`;
}

function prompt(q) {
  const i = rl.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => i.question(q, a => { i.close(); r(a); }));
}

function die(msg)  { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }
function warn(msg) { console.warn(`  ⚠ ${msg}`); }

// ─── Push & approval ──────────────────────────────────────────────────────

async function handlePushAndApproval(result, slug) {
  if (!TYPEFULLY_KEY) {
    console.log('  Skipping push: no TYPEFULLY_API_KEY in .env\n');
    return;
  }

  const answer = await prompt('  Which to push? (e.g. "1,3" or "none"): ');
  const picks  = answer.trim().toLowerCase();
  if (!picks || picks === 'none') {
    console.log('  No approvals recorded.\n');
    return;
  }

  const indices = picks.split(',')
    .map(s => parseInt(s.trim(), 10) - 1)
    .filter(i => !isNaN(i) && i >= 0 && i < result.candidates.length);

  const approvals = [];
  for (const i of indices) {
    const c       = result.candidates[i];
    const content = c.shape === 'thread' ? (c.tweets || []).join('\n\n') : c.text;
    try {
      await pushToTypefully(content);
      console.log(`  ✓ pushed: ${c.label}`);
      approvals.push({ summary: c.summary_for_state || c.label, type: c.type, arc: c.arc });
    } catch (e) {
      console.error(`  ✗ failed: ${e.message}`);
    }
  }

  if (approvals.length) {
    recordApprovals(slug, approvals);
    console.log(`\n  Recorded ${approvals.length} approval(s) to project state.\n`);
  }
}

// ─── Notes export ──────────────────────────────────────────────────────────

function buildNoteContent(result, projectName, mode, dateStr) {
  const date    = dateStr || new Date().toISOString().slice(0, 10);
  const divider = '─'.repeat(40);
  const lines   = [];

  lines.push(`${projectName}  ·  MODE: ${mode}  |  ${date}`);
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

function exportToNotes(title, body, opts = {}) {
  const platform = opts.platform || process.platform;
  const execFn   = opts.execFn   || ((cmd) => execSync(cmd, { stdio: 'pipe' }));

  if (platform !== 'darwin') {
    warn('Apple Notes export is macOS only — skipping.');
    return false;
  }

  // Escape single quotes for AppleScript (replace with right single quotation mark)
  const safeTitle = (title || '').replace(/'/g, '\u2019').replace(/"/g, '\\"');
  const safeBody  = (body  || '').replace(/'/g, '\u2019').replace(/"/g, '\\"').replace(/\n/g, '\\n');

  const script = `tell application "Notes" to make new note at folder "Notes" with properties {name:"${safeTitle}", body:"${safeBody}"}`;

  try {
    execFn(`osascript -e '${script}'`);
    return true;
  } catch (e) {
    warn(`Apple Notes export failed: ${e.message}`);
    return false;
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function runPipeline(sessionFile, mode, count, opts = {}) {
  if (!fs.existsSync(sessionFile)) return { gateError: 'Session file not found.' };

  const apiKey = opts.apiKey || ANTHROPIC_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

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

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  devlog v1  —  session → reasoning → posts\n');

  if (!ANTHROPIC_KEY) die('Missing ANTHROPIC_API_KEY in .env');

  process.stdout.write('  Finding sessions...');
  const sessions = findSessions();
  process.stdout.write(` found ${sessions.length}\n`);
  if (sessions.length === 0) die('No sessions found. Try --days 7.');

  const session = LIST_MODE ? await pickSession(sessions) : sessions[0];
  const slug    = projectSlug(path.basename(path.dirname(session.file)));

  console.log(`\n  Project : ${session.project}  (slug: ${slug})`);
  console.log(`  Session : ${formatAge(session.mtime)}  (${(session.size/1024).toFixed(0)}kb)`);
  console.log(`  Mode    : ${MODE}  |  Count: ${COUNT}`);

  // Pre-API gate
  const rawText = fs.readFileSync(session.file, 'utf8');
  const gate    = passesPreGate(rawText);
  if (!gate.ok) die(gate.reason + ' Try a longer session or --list.');

  process.stdout.write('  Parsing...');
  const messages = parseSession(session.file);
  const chunk    = chunkSession(messages);
  process.stdout.write(` ${messages.length} messages, ${chunk.length} chars\n`);

  const state = loadState(slug);
  if (state.active_arcs.length) console.log(`  Arcs    : ${state.active_arcs.join(', ')}`);

  const voiceExamples = STYLE_FILE ? loadStyle(STYLE_FILE) : null;
  if (voiceExamples) console.log(`  Style   : loaded from ${path.basename(STYLE_FILE)}`);

  // Append manual context hint to session if provided
  const sessionForPrompt = CONTEXT
    ? `Manual context from author: ${CONTEXT}\n\n---\n\n${chunk}`
    : chunk;

  process.stdout.write('  Extracting (Haiku)...');
  const extraction = await extractStage1(sessionForPrompt, state, { apiKey: ANTHROPIC_KEY });
  process.stdout.write(' done\n');

  // Stage 1 gate: nothing to share
  // If Stage 1 found nothing AND no arc is in flight, there's nothing to write about.
  // If an arc is active, fall through — a drip update is still useful.
  if (extraction.best_output_type === 'nothing' && !extraction.active_arc) {
    console.log('\n  No story today.\n  Session had no articulated decisions or reasoning worth sharing.\n  Try a session where you talked through a choice or trade-off.\n');
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
  } else if (result.candidates && result.candidates.length) {
    console.log(`  --push to send drafts to Typefully.\n`);
  }

  if (SAVE_TO_NOTES) {
    const noteTitle   = `Devlog · ${session.project} · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const noteContent = buildNoteContent(result, session.project, MODE);
    const saved = exportToNotes(noteTitle, noteContent);
    if (saved) console.log(`  ✓ Saved to Apple Notes: "${noteTitle}"\n`);
  }
}

if (require.main === module) {
  if (USE_UI) serveUi().catch(e => die(e.message));
  else main().catch(e => die(e.message));
} else {
  module.exports = { projectSlug, loadState, saveState, recordApprovals, passesPreGate, buildExtractionPrompt, extractStage1, buildStoryPrompt, buildTechnicalPrompt, generateStage2, buildNoteContent, exportToNotes, runPipeline, serveUi };
}
