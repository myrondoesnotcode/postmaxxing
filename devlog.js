#!/usr/bin/env node

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const rl             = require('readline');
const { execSync }   = require('child_process');

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

function findSessions() {
  if (!fs.existsSync(CLAUDE_DIR)) die(`Claude projects dir not found: ${CLAUDE_DIR}`);

  const cutoff   = Date.now() - DAYS_FILTER * 24 * 60 * 60 * 1000;
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
  main().catch(e => die(e.message));
} else {
  module.exports = { projectSlug, loadState, saveState, recordApprovals, passesPreGate, buildExtractionPrompt, extractStage1, buildStoryPrompt, buildTechnicalPrompt, generateStage2, buildNoteContent, exportToNotes };
}
