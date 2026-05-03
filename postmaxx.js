#!/usr/bin/env node

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const rl             = require('readline');
const { execSync }   = require('child_process');
const { exec }       = require('child_process');
const http           = require('http');

const CONFIG_DIR  = path.join(os.homedir(), '.postmaxxing');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config');

function loadEnv() {
  // build candidate paths: ~/.postmaxxing/config, then walk up from __dirname looking for .env
  const candidates = [CONFIG_FILE];
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const parseEnv = (text) => text.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim().replace(/^['"]|['"]$/g, '');
  });
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) parseEnv(fs.readFileSync(envPath, 'utf8'));
  }
}
loadEnv();

async function setupFirstRun() {
  if (process.env.ANTHROPIC_API_KEY) return;
  console.log('\n  postmaxx_ — first run setup\n');
  console.log('  Get your API key at: https://console.anthropic.com/settings/keys\n');
  const key = await prompt('  Paste your Anthropic API key: ');
  if (!key || !key.trim().startsWith('sk-')) {
    console.error('\n  ✗ Invalid key. Run again and paste a key starting with sk-\n');
    process.exit(1);
  }
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `ANTHROPIC_API_KEY=${key.trim()}\n`, { mode: 0o600 });
  process.env.ANTHROPIC_API_KEY = key.trim();
  console.log('  ✓ Key saved to ~/.postmaxxing/config\n');
}

const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY;
const TYPEFULLY_KEY      = process.env.TYPEFULLY_API_KEY;
const CLAUDE_DIR         = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const MAX_CHARS          = 12000;
const MIN_SESSION_BYTES  = 5 * 1024;
const MIN_SESSION_LINES  = 8; // 4 exchanges × 2 messages
const HAIKU_MODEL        = 'claude-haiku-4-5';
const SONNET_MODEL       = 'claude-sonnet-4-6';
const OPUS_MODEL         = 'claude-opus-4-7';

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
const UI_PORT        = parseInt(getArg('--port') || process.env.PORT || '3000');
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
- Write like a founder texting a smart friend, not a content creator performing transparency.
- Open with tension, surprise, or a specific problem — never with context-setting or "so I've been building".
- Specific over vague. Real numbers, real names, real constraints. "4 hours" beats "a while". "Haiku" beats "a smaller model".
- "I was wrong about X" outperforms "I learned X". Vulnerability beats expertise signaling.
- No em-dashes. No "excited to share", "thrilled to announce", "game-changer", "journey".
- No hashtags unless one is genuinely relevant. Never #buildinpublic.
- Lowercase opens are fine. Short sentences. No padding.
- If the session had a realization or reversal, that IS the story — lead with it.
- Threads: tweet 1 is a HOOK that creates tension without resolving it. Each subsequent tweet earns the next read. Last tweet lands the point or asks something real.`;

const SINGLE_EXAMPLES = `What good single tweets look like:
"spent 3 hours debugging a race condition. turned out i was calling the wrong function. the correct function existed 20 lines above it."
"decided to cut the feature i spent 2 weeks on. it was technically impressive and nobody asked for it."
"users don't want X, they want Y. took 40 support tickets to understand the difference."`;

const THREAD_EXAMPLES = `What good thread hooks look like (tweet 1 only):
"i almost shipped the wrong architecture. here's what changed my mind:"
"we had 3 approaches. picked the worst one first. this is why:"
"the bug wasn't in the code. it was in my assumption about how the API worked."
Note: hooks end with a colon or create a gap the reader must fill. Never summarize the thread in tweet 1.`;

const TECHNICAL_VOICE_RULES = `Technical voice rules:
- Name the actual thing: library name, function name, error message, model name, algorithm. Never say "a library" or "an approach".
- Lead with numbers when you have them: before/after latency, file sizes, line counts, benchmark results.
- The trade-off accepted > the solution chosen. What did you give up? Why was it worth it?
- One concrete technical thing per tweet. Not a journey, not a reflection.
- Terse. Jargon is fine — the reader will look it up or already knows.
- No "I learned", "I realized", "this changed everything", "game-changer".
- No em-dashes. Lowercase is fine. Short sentences.
- Anti-pattern: "I used a more efficient approach" — worthless. Say "switched from O(n²) to O(n log n) via a hash map".
- Anti-pattern: "I decided to use a different architecture" — worthless. Say "dropped the saga pattern, moved to direct DB writes, removed 400 lines".`;

const TECHNICAL_SINGLE_EXAMPLES = `What good technical tweets look like:
"dropped lodash. bundle 87kb → 31kb. it was added 3 years ago for _.cloneDeep. structuredClone() ships in node 17."
"sqlite isn't a toy. we moved from postgres: p99 dropped 40ms → 3ms. the whole db is one 2.1gb file."
"race condition: two workers read count=5, both write count=6. fix: SELECT ... FOR UPDATE. been there since sql92."`;

const TECHNICAL_THREAD_EXAMPLES = `What good technical thread hooks look like (tweet 1 only):
"benchmarked 4 approaches. the obvious one was 10x slower. here's why:"
"the error message is lying: [exact error text]. here's what's actually happening:"
"we had 3 engineers who all thought it was someone else's bug. here's the actual callstack:"
Note: tweet 1 names the specific thing. Never start with "I've been building" or "here's what I learned".`;

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
  <title>postmaxx_</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0a;
      --card: #111;
      --card2: #141414;
      --border: #222;
      --border2: #2a2a2a;
      --green: #CDFF00;
      --white: #F0EFE8;
      --muted: #666;
      --muted2: #999;
      --red: #FF6B6B;
      --yellow: #f5a623;
    }
    body { font-family: 'DM Sans', sans-serif; background: var(--bg); color: var(--white); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    a { text-decoration: none; color: inherit; }

    /* header */
    header { height: 54px; padding: 0 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    .logo { font-family: 'JetBrains Mono', monospace; font-size: 16px; font-weight: 700; letter-spacing: -0.5px; color: var(--white); }
    .logo span { color: var(--green); }
    #session-info { font-size: 12px; color: var(--muted2); font-family: 'JetBrains Mono', monospace; }

    /* layout */
    .layout { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 264px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
    .controls { padding: 16px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 12px; }

    /* mode buttons */
    .mode-row { display: flex; gap: 6px; }
    .mode-btn { flex: 1; padding: 7px 0; background: transparent; border: 1px solid var(--border2); color: var(--muted2); font-size: 12px; font-weight: 600; font-family: 'DM Sans', sans-serif; cursor: pointer; transition: all 0.15s; letter-spacing: .03em; text-transform: uppercase; }
    .mode-btn.active { background: var(--card2); border-color: #444; color: var(--white); }
    .mode-btn:hover:not(.active) { border-color: #333; color: var(--muted); }

    /* count */
    .count-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted2); }
    .count-input { width: 44px; background: var(--card2); border: 1px solid var(--border2); color: var(--white); font-size: 12px; padding: 5px 8px; text-align: center; font-family: 'JetBrains Mono', monospace; }
    .count-input:focus { outline: none; border-color: var(--green); }

    /* context */
    .ctx-label { font-size: 11px; color: var(--muted); margin-bottom: 5px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
    .ctx-area { width: 100%; background: var(--card2); border: 1px solid var(--border2); color: var(--muted2); font-size: 12px; padding: 8px 10px; resize: none; height: 54px; font-family: 'DM Sans', sans-serif; line-height: 1.5; }
    .ctx-area:focus { outline: none; border-color: #444; color: var(--white); }
    .ctx-area::placeholder { color: var(--muted); }

    /* generate button */
    .gen-btn { padding: 10px; background: var(--green); color: #000; border: none; font-size: 13px; font-weight: 700; font-family: 'DM Sans', sans-serif; cursor: pointer; letter-spacing: .02em; transition: opacity 0.15s; text-transform: uppercase; }
    .gen-btn:hover:not(:disabled) { opacity: .88; }
    .gen-btn:disabled { opacity: 0.3; cursor: not-allowed; }

    /* session list */
    .session-list-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px 4px; border-bottom: 1px solid var(--border); }
    .sessions-label { font-size: 10px; font-weight: 700; letter-spacing: .1em; color: var(--muted); text-transform: uppercase; font-family: 'JetBrains Mono', monospace; }
    .refresh-btn { font-size: 11px; color: var(--muted); background: transparent; border: none; cursor: pointer; padding: 2px 0; font-family: 'DM Sans', sans-serif; transition: color 0.15s; }
    .refresh-btn:hover { color: var(--green); }
    .session-list { flex: 1; overflow-y: auto; }
    .day-header { padding: 10px 16px 5px; font-size: 10px; font-weight: 700; letter-spacing: .1em; color: var(--muted); text-transform: uppercase; border-top: 1px solid var(--border); font-family: 'JetBrains Mono', monospace; }
    .day-header:first-child { border-top: none; }
    .session-item { padding: 10px 16px; cursor: pointer; border-bottom: 1px solid #0f0f0f; transition: background 0.1s; }
    .session-item:hover { background: var(--card); }
    .session-item.selected { background: rgba(205,255,0,0.05); border-left: 2px solid var(--green); padding-left: 14px; }
    .s-project { font-size: 13px; font-weight: 600; color: var(--white); }
    .s-meta { font-size: 11px; color: var(--muted); margin-top: 2px; font-family: 'JetBrains Mono', monospace; }
    .s-excerpt { font-size: 11px; color: var(--muted); margin-top: 3px; font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* source tabs */
    .source-tabs { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); background: var(--bg); flex-shrink: 0; }
    .src-tab { flex: 1; padding: 7px 4px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--muted); font-size: 10px; font-weight: 700; font-family: 'JetBrains Mono', monospace; cursor: pointer; letter-spacing: .06em; text-transform: uppercase; transition: all 0.15s; }
    .src-tab.active { color: var(--white); border-bottom-color: var(--green); }
    .src-tab:hover:not(.active) { color: var(--muted2); }
    .src-refresh { padding: 7px 10px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--muted); font-size: 12px; cursor: pointer; transition: color 0.15s; }
    .src-refresh:hover { color: var(--green); }

    /* model picker */
    .model-row { display: flex; gap: 4px; }
    .model-btn { flex: 1; padding: 6px 0; background: transparent; border: 1px solid var(--border2); color: var(--muted2); font-size: 11px; font-weight: 600; font-family: 'DM Sans', sans-serif; cursor: pointer; transition: all 0.15s; letter-spacing: .02em; }
    .model-btn.active { background: var(--card2); border-color: #444; color: var(--white); }
    .model-btn:hover:not(.active) { border-color: #333; color: var(--muted); }
    .model-cost { font-size: 10px; color: var(--muted); font-family: 'JetBrains Mono', monospace; text-align: center; margin-top: -4px; }

    /* source badge */
    .src-badge { display: inline-block; font-size: 9px; font-weight: 700; font-family: 'JetBrains Mono', monospace; padding: 1px 4px; border-radius: 2px; letter-spacing: .04em; vertical-align: middle; margin-right: 4px; }
    .src-cc { background: rgba(205,255,0,0.12); color: #CDFF00; }
    .src-oc { background: rgba(100,150,255,0.15); color: #7fa8ff; }
    .src-cx { background: rgba(255,150,80,0.15); color: #ff9c55; }

    /* main */
    .main { flex: 1; overflow-y: auto; padding: 28px; }
    .empty-state { height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 0; }
    .empty-logo { font-family: 'Bebas Neue', sans-serif; font-size: 48px; line-height: 1; color: var(--border2); letter-spacing: 2px; margin-bottom: 32px; }
    .empty-steps { display: flex; flex-direction: column; gap: 18px; }
    .empty-step { display: flex; align-items: center; gap: 14px; }
    .step-num { font-family: 'JetBrains Mono', monospace; font-size: 28px; font-weight: 700; color: var(--green); line-height: 1; min-width: 40px; }
    .step-text { font-size: 15px; color: var(--white); font-weight: 500; }
    @keyframes pulse-once { 0%,100% { text-shadow: none; } 40% { text-shadow: 0 0 12px rgba(205,255,0,0.7); } }
    .pulse-once { animation: pulse-once 1.5s ease forwards; }

    /* preview */
    .preview-card { background: var(--card); border: 1px solid var(--border); padding: 18px; margin-bottom: 20px; }
    .preview-title { font-size: 10px; font-weight: 700; color: var(--muted); letter-spacing: .1em; text-transform: uppercase; margin-bottom: 10px; font-family: 'JetBrains Mono', monospace; }
    .preview-text { font-size: 13px; color: var(--muted2); line-height: 1.65; white-space: pre-wrap; word-break: break-word; max-height: 130px; overflow: hidden; position: relative; }
    .preview-text::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 36px; background: linear-gradient(transparent, var(--card)); }
    .preview-hint { font-size: 12px; color: var(--muted); text-align: center; padding-top: 10px; }

    /* signal */
    .signal-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; font-size: 12px; padding: 9px 14px; border: 1px solid var(--border); background: var(--card); }
    .signal-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .signal-good { background: var(--green); }
    .signal-weak { background: var(--yellow); }
    .signal-text { color: var(--muted2); font-family: 'JetBrains Mono', monospace; font-size: 11px; }

    /* loading */
    .loading { display: flex; align-items: center; justify-content: center; height: 200px; gap: 12px; color: var(--muted2); font-size: 13px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { width: 16px; height: 16px; border: 2px solid var(--border2); border-top-color: var(--green); border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0; }

    /* candidates */
    .candidate { background: var(--card); border: 1px solid var(--border); padding: 18px; margin-bottom: 12px; }
    .cand-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .badge { font-size: 10px; font-weight: 700; letter-spacing: .08em; padding: 3px 8px; background: transparent; border: 1px solid var(--border2); color: var(--muted); font-family: 'JetBrains Mono', monospace; }
    .cand-label { font-size: 13px; color: var(--muted2); flex: 1; }
    .regen-btn { padding: 3px 9px; background: transparent; color: var(--muted); border: 1px solid var(--border2); font-size: 11px; cursor: pointer; transition: all 0.15s; flex-shrink: 0; font-family: 'DM Sans', sans-serif; }
    .regen-btn:hover { color: var(--white); border-color: #444; }

    /* tweet editor */
    .tweet-box { font-family: 'JetBrains Mono', monospace; font-size: 13px; line-height: 1.7; color: var(--white); background: var(--bg); border: 1px solid var(--border2); padding: 13px; width: 100%; resize: vertical; min-height: 76px; }
    .tweet-box:focus { outline: none; border-color: #383838; }
    .tweet-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 8px; }
    .footer-left { display: flex; align-items: center; gap: 8px; }
    .char-ok { color: var(--green); font-size: 11px; font-family: 'JetBrains Mono', monospace; }
    .char-warn { color: var(--yellow); font-size: 11px; font-family: 'JetBrains Mono', monospace; }
    .char-over { color: var(--red); font-size: 11px; font-family: 'JetBrains Mono', monospace; }
    .copy-btn { padding: 4px 10px; background: transparent; color: var(--muted); border: 1px solid var(--border2); font-size: 11px; cursor: pointer; transition: all 0.15s; font-family: 'DM Sans', sans-serif; }
    .copy-btn:hover { color: var(--white); border-color: #444; }
    .post-btn { padding: 6px 16px; background: var(--green); color: #000; border: none; font-size: 12px; font-weight: 700; cursor: pointer; transition: opacity 0.15s; flex-shrink: 0; font-family: 'DM Sans', sans-serif; letter-spacing: .02em; text-transform: uppercase; }
    .post-btn:hover { opacity: .85; }
    .post-btn:disabled { opacity: .4; cursor: not-allowed; }
    .thread-tweet { margin-bottom: 14px; }
    .thread-num { font-size: 10px; color: var(--muted); margin-bottom: 5px; font-family: 'JetBrains Mono', monospace; letter-spacing: .05em; }

    /* misc */
    .msg-box { background: var(--card); border: 1px solid var(--border); padding: 20px; font-size: 14px; line-height: 1.6; color: var(--muted2); }
    .error-box { background: #120808; border: 1px solid #3a1515; padding: 16px; font-size: 13px; color: var(--red); }
  </style>
</head>
<body>
  <header>
    <div class="logo">postmaxx<span>_</span></div>
    <div id="session-info"></div>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <div class="controls">
        <div class="mode-row">
          <button class="mode-btn active" id="btn-story" onclick="setMode('story')">Story</button>
          <button class="mode-btn" id="btn-technical" onclick="setMode('technical')">Technical</button>
        </div>
        <div>
          <div class="ctx-label" style="margin-bottom:6px">Model</div>
          <div class="model-row">
            <button class="model-btn" id="btn-haiku" onclick="setModel('claude-haiku-4-5')">Haiku</button>
            <button class="model-btn active" id="btn-sonnet" onclick="setModel('claude-sonnet-4-6')">Sonnet</button>
            <button class="model-btn" id="btn-opus" onclick="setModel('claude-opus-4-7')">Opus</button>
          </div>
          <div class="model-cost" id="model-cost">~$0.003 / run</div>
        </div>
        <div class="count-row">
          <span>Candidates</span>
          <input class="count-input" id="count" type="number" min="1" max="10" value="3">
        </div>
        <div>
          <div class="ctx-label">About you</div>
          <textarea class="ctx-area" id="context" placeholder="solo founder, building X, prev Y eng…"></textarea>
        </div>
        <button class="gen-btn" id="gen-btn" onclick="generate()" disabled>Generate →</button>
      </div>
      <div class="source-tabs" id="source-tabs">
        <button class="src-tab active" id="src-all" data-src="all" onclick="setSource(this.dataset.src)">All</button>
        <button class="src-refresh" onclick="init()" title="Refresh">↻</button>
      </div>
      <div class="session-list" id="session-list">
        <div class="s-meta" style="padding:14px">Loading…</div>
      </div>
    </aside>
    <main class="main" id="main">
      <div class="empty-state">
        <div class="empty-logo">POSTMAXX</div>
        <div class="empty-steps">
          <div class="empty-step"><span class="step-num" id="step-num-1">01</span><span class="step-text">Pick a session from the left</span></div>
          <div class="empty-step"><span class="step-num">02</span><span class="step-text">Add context about yourself</span></div>
          <div class="empty-step"><span class="step-num">03</span><span class="step-text">Hit Generate</span></div>
        </div>
      </div>
    </main>
  </div>
  <script>
    var selected = null, mode = 'story', lastExtraction = null;
    var sourceFilter = 'all';
    var selectedModel = 'claude-sonnet-4-6';
    var modelCosts = { 'claude-haiku-4-5': '~$0.001 / run', 'claude-sonnet-4-6': '~$0.003 / run', 'claude-opus-4-7': '~$0.015 / run' };

    // persist context across refreshes
    var ctxEl = document.getElementById('context');
    ctxEl.value = localStorage.getItem('pmx_context') || '';
    ctxEl.addEventListener('input', function(){ localStorage.setItem('pmx_context', ctxEl.value); });

    // pulse step 1 on first ever load
    if (!localStorage.getItem('pmx_onboarded')) {
      var sn = document.getElementById('step-num-1');
      if (sn) sn.classList.add('pulse-once');
    }

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function charHtml(text) {
      var n = (text||'').length, cls = n<=260?'char-ok':n<=280?'char-warn':'char-over', icon = n<=260?'✓':n<=280?'⚠':'✗';
      return '<span class="'+cls+'">'+icon+' '+n+'/280</span>';
    }
    function updateChar(el, cid) { document.getElementById(cid).innerHTML = charHtml(el.value); }

    function copyText(tid, btnEl) {
      var val = document.getElementById(tid).value;
      navigator.clipboard.writeText(val).then(function(){
        var orig = btnEl.textContent; btnEl.textContent = 'Copied!'; btnEl.style.color = 'var(--green)';
        setTimeout(function(){ btnEl.textContent = orig; btnEl.style.color = ''; }, 1500);
      });
    }

    function postToX(tid) { window.open('https://x.com/intent/tweet?text='+encodeURIComponent(document.getElementById(tid).value),'_blank'); }

    async function postThread(i, count) {
      var tweets = [];
      for (var j=0; j<count; j++) { var el=document.getElementById('tw'+i+'_'+j); if(el) tweets.push(el.value); }
      var btn = document.getElementById('ptbtn'+i);
      btn.disabled = true; btn.textContent = 'Posting…';
      try {
        var res = await fetch('/api/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tweets:tweets})});
        var data = await res.json();
        if (data.error) { alert('Error: '+data.error); btn.disabled=false; btn.textContent='Post thread →'; }
        else { btn.textContent='Posted ✓'; btn.style.borderColor='#4caf50'; }
      } catch(e) { alert('Failed: '+e.message); btn.disabled=false; btn.textContent='Post thread →'; }
    }

    async function regenCandidate(i) {
      if (!selected) return;
      var el = document.getElementById('cand'+i);
      if (!el) return;
      el.style.opacity = '0.4';
      var ctx = document.getElementById('context').value.trim();
      try {
        var body = { sessionFile: selected.file, mode: mode, count: 1, context: ctx, source: selected.source||'claude-code', model: selectedModel };
        if (selected.sessionId) body.sessionId = selected.sessionId;
        var res = await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        var data = await res.json();
        if (data.error || !data.candidates || !data.candidates.length) { el.style.opacity='1'; return; }
        var newHtml = buildCandidateHtml(data.candidates[0], i);
        el.outerHTML = newHtml;
      } catch(e) { el.style.opacity='1'; }
    }

    function setMode(m) {
      mode = m;
      document.getElementById('btn-story').classList.toggle('active', m==='story');
      document.getElementById('btn-technical').classList.toggle('active', m==='technical');
    }

    function setModel(m) {
      selectedModel = m;
      ['haiku','sonnet','opus'].forEach(function(n){ document.getElementById('btn-'+n).classList.remove('active'); });
      var btnId = m === 'claude-haiku-4-5' ? 'btn-haiku' : m === 'claude-opus-4-7' ? 'btn-opus' : 'btn-sonnet';
      document.getElementById(btnId).classList.add('active');
      document.getElementById('model-cost').textContent = modelCosts[m] || '';
    }

    function setSource(src) {
      sourceFilter = src;
      document.querySelectorAll('.src-tab').forEach(function(el){ el.classList.remove('active'); });
      var activeTab = document.getElementById('src-'+src);
      if (activeTab) activeTab.classList.add('active');
      renderSessionList();
    }

    function renderSessionList() {
      var sessions = window.__sessions || [];
      var filtered = sourceFilter === 'all' ? sessions : sessions.filter(function(s){ return s.source === sourceFilter; });
      var list = document.getElementById('session-list');
      if (!filtered.length) { list.innerHTML='<div class="s-meta" style="padding:14px">No sessions found.</div>'; return; }
      var html='', lastDay='';
      filtered.forEach(function(s, fi){
        var i = sessions.indexOf(s);
        var day=s.mtime.slice(0,10);
        if (day!==lastDay) {
          html+='<div class="day-header">'+esc(formatDay(day))+'</div>';
          lastDay=day;
        }
        var srcBadge = s.source==='opencode' ? '<span class="src-badge src-oc">OC</span>' : s.source==='codex' ? '<span class="src-badge src-cx">CX</span>' : '<span class="src-badge src-cc">CC</span>';
        var excerptHtml = s.excerpt ? '<div class="s-excerpt">'+esc(s.excerpt)+'</div>' : '';
        html+='<div class="session-item" id="si'+i+'" onclick="pick('+i+')">'+'<div class="s-project">'+esc(s.project)+'</div>'+'<div class="s-meta">'+srcBadge+esc(s.age)+' · '+s.sizeKb+'kb</div>'+excerptHtml+'</div>';
      });
      list.innerHTML=html;
    }

    function formatDay(iso){
      var d=new Date(iso+'T12:00:00Z'), now=new Date();
      var td=now.toISOString().slice(0,10), yd=new Date(now-864e5).toISOString().slice(0,10);
      if (iso===td) return 'Today';
      if (iso===yd) return 'Yesterday';
      return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    }

    async function pick(i) {
      document.querySelectorAll('.session-item').forEach(function(el){el.classList.remove('selected');});
      var el = document.getElementById('si'+i); if (el) el.classList.add('selected');
      selected = window.__sessions[i];
      document.getElementById('session-info').textContent = selected.project+' · '+selected.age;
      document.getElementById('gen-btn').disabled = false;
      localStorage.setItem('pmx_onboarded', '1');
      var main = document.getElementById('main');
      main.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading preview…</span></div>';
      try {
        var params = 'file='+encodeURIComponent(selected.file)+'&source='+encodeURIComponent(selected.source||'claude-code');
        if (selected.sessionId) params += '&sessionId='+encodeURIComponent(selected.sessionId);
        var res = await fetch('/api/preview?'+params);
        var data = await res.json();
        if (data.preview) {
          main.innerHTML = '<div class="preview-card"><div class="preview-title">Session preview</div><div class="preview-text">'+esc(data.preview)+'</div></div>'+
            '<div class="preview-hint">Hit Generate → when ready</div>';
        } else { main.innerHTML = '<div class="empty-state"><div class="empty-icon">✦</div><div>Hit Generate</div></div>'; }
      } catch(e) { main.innerHTML = '<div class="empty-state"><div class="empty-icon">✦</div><div>Hit Generate</div></div>'; }
    }

    async function init() {
      try {
        var list = document.getElementById('session-list');
        list.innerHTML = '<div class="s-meta" style="padding:14px">Loading…</div>';
        var res = await fetch('/api/sessions'), sessions = await res.json();
        if (!sessions.length) { list.innerHTML='<div class="s-meta" style="padding:14px">No sessions found.</div>'; return; }
        sessions.sort(function(a,b){
          var da=a.mtime.slice(0,10), db=b.mtime.slice(0,10);
          if (da!==db) return da>db?-1:1;
          return b.sizeKb-a.sizeKb;
        });
        window.__sessions = sessions;

        // build source tabs dynamically
        var sources = Array.from(new Set(sessions.map(function(s){ return s.source||'claude-code'; })));
        var tabsEl = document.getElementById('source-tabs');
        var tabsHtml = '<button class="src-tab'+(sourceFilter==='all'?' active':'')+'" id="src-all" data-src="all" onclick="setSource(this.dataset.src)">All</button>';
        sources.forEach(function(src){
          var label = src==='claude-code'?'CC':src==='opencode'?'OC':'CX';
          tabsHtml += '<button class="src-tab'+(sourceFilter===src?' active':'')+'" id="src-'+src+'" data-src="'+src+'" onclick="setSource(this.dataset.src)">'+label+'</button>';
        });
        tabsHtml += '<button class="src-refresh" onclick="init()" title="Refresh">↻</button>';
        tabsEl.innerHTML = tabsHtml;

        renderSessionList();
      } catch(e) { document.getElementById('session-list').innerHTML='<div class="s-meta" style="padding:14px;color:#e57373">Failed to load sessions</div>'; }
    }

    async function generate() {
      if (!selected) return;
      var count = parseInt(document.getElementById('count').value)||3;
      var ctx = document.getElementById('context').value.trim();
      var main = document.getElementById('main');
      main.innerHTML = '<div class="loading"><div class="spinner"></div><span>Extracting reasoning…</span></div>';
      document.getElementById('gen-btn').disabled = true;
      try {
        var body = { sessionFile: selected.file, mode: mode, count: count, context: ctx, source: selected.source||'claude-code', model: selectedModel };
        if (selected.sessionId) body.sessionId = selected.sessionId;
        var res = await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        var data = await res.json();
        if (data.error) { main.innerHTML='<div class="error-box">Error: '+esc(data.error)+'</div>'; }
        else if (data.nothing||data.gateError) { main.innerHTML='<div class="msg-box">'+esc(data.message||data.gateError||'Nothing to share.')+'</div>'; }
        else { renderCandidates(data.candidates||[], data.extraction); }
      } catch(e) { main.innerHTML='<div class="error-box">Request failed: '+esc(e.message)+'</div>'; }
      finally { document.getElementById('gen-btn').disabled=false; }
    }

    function buildCandidateHtml(c, i) {
      var badge = (c.shape||'single').toUpperCase()+' · '+(c.type||'story').toUpperCase(), label = esc(c.label||'');
      var header = '<div class="cand-header"><span class="badge">'+badge+'</span><span class="cand-label">'+label+'</span>'+
        '<button class="regen-btn" onclick="regenCandidate('+i+')">↻ redo</button></div>';
      if (c.shape==='thread') {
        var tweets = c.tweets||[];
        var threadHtml = tweets.map(function(t,j){
          var tid='tw'+i+'_'+j, cid='cc'+i+'_'+j;
          return '<div class="thread-tweet"><div class="thread-num">'+(j+1)+'/'+tweets.length+'</div>'+
            '<textarea class="tweet-box" id="'+tid+'" oninput="updateChar(this,\\x27'+cid+'\\x27)">'+esc(t||'')+'</textarea>'+
            '<div class="tweet-footer"><div class="footer-left"><span id="'+cid+'">'+charHtml(t||'')+'</span>'+
            '<button class="copy-btn" onclick="copyText(\\x27'+tid+'\\x27,this)">Copy</button></div></div></div>';
        }).join('');
        return '<div class="candidate" id="cand'+i+'">'+header+'<div>'+threadHtml+
          '<div class="tweet-footer" style="margin-top:4px"><span></span>'+
          '<button class="post-btn" id="ptbtn'+i+'" onclick="postThread('+i+','+tweets.length+')">Post thread →</button></div>'+
          '</div></div>';
      }
      var text=c.text||'', tid='tw'+i, cid='cc'+i;
      return '<div class="candidate" id="cand'+i+'">'+header+
        '<textarea class="tweet-box" id="'+tid+'" oninput="updateChar(this,\\x27'+cid+'\\x27)">'+esc(text)+'</textarea>'+
        '<div class="tweet-footer"><div class="footer-left"><span id="'+cid+'">'+charHtml(text)+'</span>'+
        '<button class="copy-btn" onclick="copyText(\\x27'+tid+'\\x27,this)">Copy</button></div>'+
        '<button class="post-btn" onclick="postToX(\\x27'+tid+'\\x27)">Post to X →</button></div></div>';
    }

    function renderCandidates(candidates, extraction) {
      var main = document.getElementById('main');
      if (!candidates.length) { main.innerHTML='<div class="msg-box">No candidates returned.</div>'; return; }
      var signalHtml = '';
      if (extraction) {
        var good = extraction.has_reasoning && extraction.decisions && extraction.decisions.length > 0;
        signalHtml = '<div class="signal-bar"><div class="signal-dot '+(good?'signal-good':'signal-weak')+'"></div>'+
          '<span class="signal-text">'+(good ? extraction.decisions.length+' decision'+(extraction.decisions.length>1?'s':'')+' found' : 'Low signal session — posts may be thin')+'</span></div>';
      }
      main.innerHTML = signalHtml + candidates.map(function(c,i){ return buildCandidateHtml(c,i); }).join('');
    }
    init();
  </script>
</body>
</html>`;

async function handleGetSessions(req, res) {
  const sessions = findAllSessions({ days: 90 });
  const data = sessions.map(s => ({
    project:   s.project,
    file:      s.file,
    mtime:     s.mtime.toISOString(),
    sizeKb:    Math.round(s.size / 1024),
    age:       formatAge(s.mtime),
    source:    s.source || 'claude-code',
    sessionId: s.sessionId || null,
    excerpt:   getSessionExcerpt(s),
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

  const { sessionFile, mode, count, context, source, sessionId, model } = params;
  if (!sessionFile) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'sessionFile is required' }));
    return;
  }

  try {
    const result = await runPipeline(sessionFile, mode || 'story', count || 3, {
      apiKey:    ANTHROPIC_KEY,
      context:   context || '',
      source:    source || 'claude-code',
      sessionId: sessionId || null,
      model:     model || null,
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

  if (req.method === 'GET' && urlPath === '/api/preview') {
    const sp = new URL('http://x' + req.url).searchParams;
    const file      = sp.get('file');
    const source    = sp.get('source') || 'claude-code';
    const sessionId = sp.get('sessionId');

    if (source === 'claude-code' && (!file || !fs.existsSync(file))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    try {
      const session = { file, source, sessionId };
      const messages = parseSessionBySource(session);
      if (!messages) throw new Error('Could not read session');
      const userMsgs = messages.filter(m => m.role === 'user').slice(0, 3).map(m => m.content.slice(0, 300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ preview: userMsgs.join('\n\n') }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/push') {
    try {
      const body = await readBody(req);
      const { tweets } = JSON.parse(body);
      if (!TYPEFULLY_KEY) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing TYPEFULLY_API_KEY in .env' }));
        return;
      }
      const content = (tweets || []).join('\n\n\n\n');
      const tfRes = await fetch('https://api.typefully.com/v1/drafts/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': `Bearer ${TYPEFULLY_KEY}` },
        body: JSON.stringify({ content, threadify: true }),
      });
      const data = await tfRes.json();
      if (!tfRes.ok) throw new Error(data.message || tfRes.statusText);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && urlPath === '/landing') {
    const landingPath = path.join(__dirname, 'docs', 'index.html');
    if (fs.existsSync(landingPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(landingPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Landing page not found');
    }
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
  console.log(`\n  postmaxx_ UI  →  http://127.0.0.1:${actualPort}\n`);
  if (!skipOpen) exec(`open http://127.0.0.1:${actualPort}`);

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

  return `You are writing X posts for a founder/builder. Lens: STORY — the human reasoning behind a decision. Not what they built, but why they made the call they made, what they got wrong, what surprised them.

Extraction (ground truth — every claim must trace here, invent nothing):
${formatExtraction(extraction)}

Recent posts (avoid repeating these angles):
${formatRecentPosts(state)}
${voiceBlock}
${VOICE_RULES}

${SINGLE_EXAMPLES}

${THREAD_EXAMPLES}

Generate ${count} candidates with genuinely different angles — not variations of the same framing. Each picks its own shape:
- "single" when one sharp moment lands in ≤ 280 chars
- "thread" (3-5 tweets, each ≤ 280) when there's a narrative arc worth following

If best_output_type is "drip", one casual sentence is better than trying to manufacture a story. If "continuation", name the arc explicitly in the first line.

${OUTPUT_FORMAT}`;
}

function buildTechnicalPrompt(extraction, state, opts) {
  const { count, voiceExamples } = opts;
  const voiceBlock = voiceExamples
    ? `\nThis person's real posts for tone reference:\n---\n${voiceExamples.slice(0, 2000)}\n---\n`
    : '';

  return `You are writing X posts for a developer. Lens: TECHNICAL — the actual engineering decision, with real specifics. Audience is developers who will immediately know if you're being vague or hand-wavy. Do not dumb it down, do not editorialize.

Extraction (ground truth — every claim must trace here, invent nothing):
${formatExtraction(extraction)}

Recent posts (avoid repeating these angles):
${formatRecentPosts(state)}
${voiceBlock}
${TECHNICAL_VOICE_RULES}

${TECHNICAL_SINGLE_EXAMPLES}

${TECHNICAL_THREAD_EXAMPLES}

Generate ${count} candidates with genuinely different angles. Use real names: library names, model names, error messages, patterns. The trade-off accepted is more interesting than the solution chosen. Each picks its own shape:
- "single" for one sharp technical observation (≤ 280 chars)
- "thread" for a chain of decisions or a non-obvious trade-off explained

If best_output_type is "drip", keep it brief. If "continuation", reference the arc.

${OUTPUT_FORMAT}`;
}

async function generateStage2(extraction, state, opts) {
  const fetchFn      = opts.fetchFn || globalThis.fetch;
  const { mode, count, voiceExamples, apiKey } = opts;
  const stage2Model  = opts.model || SONNET_MODEL;
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
      model: stage2Model,
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

function findClaudeCodeSessions(opts = {}) {
  if (!fs.existsSync(CLAUDE_DIR)) return [];

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
      sessions.push({ project: projectName, file: filePath, mtime: stat.mtime, size: stat.size, source: 'claude-code' });
    }
  }

  return sessions;
}

function findOpencodeSessions(opts = {}) {
  try {
    const raw = execSync('opencode session list --json 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];

    const days   = (opts.days !== undefined) ? opts.days : DAYS_FILTER;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sessions = [];

    for (const s of list) {
      const mtime = new Date(s.time || s.createdAt || s.updated_at || 0);
      if (mtime.getTime() < cutoff) continue;
      sessions.push({
        project:   s.projectPath ? path.basename(s.projectPath) : (s.title || s.id || 'opencode'),
        file:      s.id,
        mtime,
        size:      0,
        source:    'opencode',
        sessionId: s.id,
      });
    }
    return sessions;
  } catch { return []; }
}

function findCodexSessions(opts = {}) {
  const codexDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(codexDir)) return [];

  const days   = (opts.days !== undefined) ? opts.days : DAYS_FILTER;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const sessions = [];

  function scanDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scanDir(full); continue; }
      if (!entry.name.endsWith('.jsonl')) continue;
      const stat = fs.statSync(full);
      if (stat.mtime.getTime() < cutoff) continue;
      sessions.push({ project: 'codex', file: full, mtime: stat.mtime, size: stat.size, source: 'codex' });
    }
  }
  scanDir(codexDir);
  return sessions;
}

function findSessions(opts = {}) {
  const cc = findClaudeCodeSessions(opts);
  if (cc.length === 0 && !opts.multiSource) {
    // legacy: die with helpful message only in CLI mode
    if (!fs.existsSync(CLAUDE_DIR)) die(`Claude projects dir not found: ${CLAUDE_DIR}`);
  }
  return cc.sort((a, b) => b.mtime - a.mtime);
}

function findAllSessions(opts = {}) {
  const all = [
    ...findClaudeCodeSessions(opts),
    ...findOpencodeSessions(opts),
    ...findCodexSessions(opts),
  ];
  return all.sort((a, b) => b.mtime - a.mtime);
}

function projectSlug(dir) {
  if (!dir) return dir;
  // strip worktree suffix before extracting project name
  const base = dir.replace(/--claude-worktrees-[^/]+$/, '');
  const stripped = base.replace(/^-/, '').replace(/-/g, '/');
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
  if (Array.isArray(content)) return content
    .filter(b => b.text && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text'))
    .map(b => b.text).join('\n').trim();
  return '';
}

function parseOpencodeSession(sessionId) {
  try {
    const raw = execSync(`opencode session export ${sessionId} --format json 2>/dev/null`, { encoding: 'utf8', timeout: 10000 });
    const data = JSON.parse(raw.trim());
    const parts = data.parts || data.messages || [];
    const messages = [];
    for (const p of parts) {
      const role = p.role || (p.type === 'user' ? 'user' : p.type === 'assistant' ? 'assistant' : null);
      if (!role || (role !== 'user' && role !== 'assistant')) continue;
      const content = typeof p.content === 'string' ? p.content : extractContent(p.content);
      if (content && content.length > 20) messages.push({ role, content });
    }
    return messages;
  } catch { return null; }
}

function parseCodexSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const payload = entry.payload || entry;
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = typeof payload.content === 'string'
        ? payload.content
        : extractContent(payload.content);
      if (content && content.length > 20) messages.push({ role, content });
    } catch { }
  }
  return messages;
}

function parseSessionBySource(session) {
  if (session.source === 'opencode') return parseOpencodeSession(session.sessionId || session.file);
  if (session.source === 'codex')    return parseCodexSession(session.file);
  return parseSession(session.file);
}

function getSessionExcerpt(session) {
  try {
    if (session.source === 'opencode') return '';
    const fd  = fs.openSync(session.file, 'r');
    const buf = Buffer.alloc(4096);
    const n   = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, n).toString('utf8');
    for (const line of chunk.split('\n')) {
      try {
        const entry = JSON.parse(line);
        const payload = entry.payload || entry;
        const role = payload.role || entry.type;
        if (role !== 'user') continue;
        const raw = extractContent((payload.message || payload).content || payload.content);
        const content = raw.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/g, '').trim();
        if (content && content.length > 20) return content.slice(0, 80);
      } catch { }
    }
    return '';
  } catch { return ''; }
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
    body: JSON.stringify({ content, threadify: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || res.statusText);
  return data;
}

// ─── Output ────────────────────────────────────────────────────────────────

function printResults(result, projectName) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  postmaxx_  ·  ${projectName}  ·  mode:${MODE}`);
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

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.postmaxxing', 'state');

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
    const content = c.shape === 'thread' ? (c.tweets || []).join('\n\n\n\n') : c.text;
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
  const source    = opts.source || 'claude-code';
  const sessionId = opts.sessionId || null;

  if (source === 'claude-code' && !fs.existsSync(sessionFile)) return { gateError: 'Session file not found.' };

  const apiKey = opts.apiKey || ANTHROPIC_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const session  = { file: sessionFile, source, sessionId };
  const messages = parseSessionBySource(session);
  if (!messages) return { gateError: 'Could not read session transcript.' };

  // pre-gate for Claude Code files (raw byte/line check); skip for other sources
  if (source === 'claude-code') {
    const rawText = fs.readFileSync(sessionFile, 'utf8');
    const gate    = passesPreGate(rawText);
    if (!gate.ok) return { gateError: gate.reason };
  } else {
    if (messages.length < 4) return { gateError: 'Session too short to generate a post.' };
  }

  const chunk            = chunkSession(messages);
  const slug             = source === 'claude-code'
    ? projectSlug(path.basename(path.dirname(sessionFile)))
    : (sessionId || sessionFile).replace(/[^a-z0-9]/gi, '-').slice(0, 40);
  const state            = loadState(slug, opts);
  const voiceExamples    = STYLE_FILE ? loadStyle(STYLE_FILE) : null;
  const contextHint      = opts.context || CONTEXT || '';
  const sessionForPrompt = contextHint ? `Context about the author: ${contextHint}\n\n---\n\n${chunk}` : chunk;

  const extraction = await extractStage1(sessionForPrompt, state, { apiKey, fetchFn: opts.fetchFn });

  if (extraction.best_output_type === 'nothing') return { nothing: true, message: 'Nothing worth sharing in this session.' };

  const result = await generateStage2(extraction, state, {
    mode:  mode || 'story',
    count: count || 3,
    voiceExamples,
    apiKey,
    model:    opts.model || null,
    fetchFn:  opts.fetchFn,
  });
  result.extraction = extraction;
  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  postmaxx_  —  session → reasoning → posts\n');

  await setupFirstRun();
  const ANTHROPIC_KEY_LIVE = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY_LIVE) die('Missing ANTHROPIC_API_KEY');

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

  if (extraction.best_output_type === 'nothing') extraction.best_output_type = 'drip';

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
  if (USE_UI) setupFirstRun().then(() => serveUi()).catch(e => die(e.message));
  else main().catch(e => die(e.message));
} else {
  module.exports = { projectSlug, loadState, saveState, recordApprovals, passesPreGate, buildExtractionPrompt, extractStage1, buildStoryPrompt, buildTechnicalPrompt, generateStage2, buildNoteContent, exportToNotes, runPipeline, serveUi };
}
