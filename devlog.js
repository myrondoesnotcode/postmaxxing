#!/usr/bin/env node

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const rl   = require('readline');

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

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TYPEFULLY_KEY = process.env.TYPEFULLY_API_KEY;
const CLAUDE_DIR    = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const MAX_CHARS     = 12000;

const args     = process.argv.slice(2);
const getArg   = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag  = (flag) => args.includes(flag);

const PROJECT_FILTER = getArg('--project');
const DAYS_FILTER    = parseInt(getArg('--days') || '1');
const STYLE_FILE     = getArg('--style');
const PUSH_TO_TF     = hasFlag('--push');
const LIST_MODE      = hasFlag('--list');
const FORMAT         = getArg('--format') || 'mix';   // single | thread | mix
const TONE           = getArg('--tone')   || 'mix';   // technical | story | mix
const COUNT          = parseInt(getArg('--count') || '5');

// ─── Session discovery ─────────────────────────────────────────────────────

function findSessions() {
  if (!fs.existsSync(CLAUDE_DIR)) die(`Claude projects dir not found: ${CLAUDE_DIR}`);

  const cutoff   = Date.now() - DAYS_FILTER * 24 * 60 * 60 * 1000;
  const sessions = [];

  const projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  for (const dir of projectDirs) {
    const projectName = decodeProjectDir(dir);
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

function decodeProjectDir(dir) {
  try {
    return path.basename(dir.replace(/^-/, '').replace(/-/g, '/')) || dir;
  } catch { return dir; }
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

// ─── Tweet generation ──────────────────────────────────────────────────────

function buildSystemPrompt(projectName, styleExamples, tone, format) {
  const styleSection = styleExamples
    ? `\nExamples of this person's real tweets for style reference:\n---\n${styleExamples.slice(0, 2000)}\n---\n`
    : '';

  const toneGuide = {
    technical: `Tone: technical and specific. Mention stack, architecture, numbers, tradeoffs. Written for developers who want the actual details. Don't dumb it down.`,
    story:     `Tone: story-first. Focus on the human experience — the moment of realization, the frustration, the unexpected turn. Numbers only if they serve the story. Written for anyone building something.`,
    mix:       `Tone: vary across outputs. Some should be technical and specific (for developers). Some should be story-first (for anyone building something).`,
  }[tone] || toneGuide.mix;

  const formatGuide = {
    single: `All outputs must be single tweets under 280 characters.`,
    thread: `All outputs must be threads of 3-5 connected tweets. Each tweet in the thread under 280 chars. Threads should have a clear arc: hook → development → payoff.`,
    mix:    `Mix formats: some single tweets (under 280 chars), some threads (3-5 tweets with a hook → development → payoff arc).`,
  }[format];

  return `You are a ghost-writer for a developer sharing authentic building-in-public content on X/Twitter. They are building ${projectName}.

Voice: specific, honest, not corporate. Shares the messy middle. Uses actual numbers and real decisions. Self-deprecating about mistakes. Thinks out loud.
${styleSection}
${toneGuide}

${formatGuide}

Rules:
- Be specific. Use actual numbers, decisions, and details from the session.
- No hype. No em-dashes. No "excited to share". No "game-changer".
- Feel like a journal entry made public.
- 1 hashtag max per tweet, only if completely natural.

Return ONLY valid JSON, no other text, in this exact format:
{
  "items": [
    { "type": "single", "label": "short label", "text": "tweet text" },
    { "type": "thread", "label": "short label", "tweets": ["tweet 1", "tweet 2", "tweet 3"] }
  ]
}`;
}

async function generateTweets(session, projectName, styleExamples) {
  if (!ANTHROPIC_KEY) die('Missing ANTHROPIC_API_KEY in .env');

  const systemPrompt = buildSystemPrompt(projectName, styleExamples, TONE, FORMAT);
  const userPrompt   = `Project: ${projectName}. Generate ${COUNT} items total.\n\nSession:\n${session}`;

  const res  = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  const data  = await res.json();
  if (data.error) die(`Anthropic API error: ${data.error.message}`);

  const raw   = data.content?.find(b => b.type === 'text')?.text || '';
  const clean = raw.replace(/```json|```/g, '').trim();

  try { return JSON.parse(clean); }
  catch { die(`Couldn't parse API response:\n${raw}`); }
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
  console.log(`  devlog  ·  ${projectName}  ·  tone:${TONE}  format:${FORMAT}`);
  console.log(`${'─'.repeat(60)}\n`);

  result.items.forEach((item, i) => {
    if (item.type === 'single') {
      const len = item.text.length;
      console.log(`  ${i + 1}. [SINGLE] ${item.label.toUpperCase()}`);
      console.log(`  ${len > 260 ? '⚠' : '✓'} ${len}/280\n`);
      console.log(`  ${item.text.replace(/\n/g, '\n  ')}\n`);
    } else if (item.type === 'thread') {
      console.log(`  ${i + 1}. [THREAD] ${item.label.toUpperCase()}`);
      console.log(`  ${item.tweets.length} tweets\n`);
      item.tweets.forEach((t, j) => {
        const len = t.length;
        console.log(`  ${j + 1}/${item.tweets.length} ${len > 260 ? '⚠' : '✓'} ${len}/280`);
        console.log(`  ${t.replace(/\n/g, '\n  ')}\n`);
      });
    }
    console.log(`  ${'·'.repeat(40)}\n`);
  });

  console.log(`${'─'.repeat(60)}`);
  console.log(`  Flags: --format single|thread|mix  --tone technical|story|mix  --count N`);
  if (TYPEFULLY_KEY) console.log(`  --push to send drafts to Typefully`);
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

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  devlog v0  —  session → tweets\n');

  process.stdout.write('  Finding sessions...');
  const sessions = findSessions();
  process.stdout.write(` found ${sessions.length}\n`);

  if (sessions.length === 0) die(`No sessions found. Try --days 7.`);

  const session = LIST_MODE ? await pickSession(sessions) : sessions[0];
  console.log(`\n  Project : ${session.project}`);
  console.log(`  Session : ${formatAge(session.mtime)}  (${(session.size/1024).toFixed(0)}kb)`);
  console.log(`  Format  : ${FORMAT}  |  Tone: ${TONE}  |  Count: ${COUNT}`);

  process.stdout.write('  Parsing...');
  const messages = parseSession(session.file);
  const chunk    = chunkSession(messages);
  process.stdout.write(` ${messages.length} messages, ${chunk.length} chars\n`);

  if (messages.length < 2) die('Session too short. Try a different one.');

  const style = STYLE_FILE ? loadStyle(STYLE_FILE) : null;
  if (style) console.log(`  Style   : loaded from ${path.basename(STYLE_FILE)}`);

  process.stdout.write('  Generating...');
  const result = await generateTweets(chunk, session.project, style);
  process.stdout.write(' done\n');

  printResults(result, session.project);

  if (PUSH_TO_TF) {
    console.log('  Pushing to Typefully...\n');
    for (const item of result.items) {
      try {
        const content = item.type === 'thread' ? item.tweets.join('\n\n') : item.text;
        await pushToTypefully(content);
        console.log(`  ✓ ${item.type}: ${item.label}`);
      } catch (e) { console.error(`  ✗ Failed: ${e.message}`); }
    }
    console.log('\n  Done. Open Typefully to review.\n');
  }
}

main().catch(e => die(e.message));
