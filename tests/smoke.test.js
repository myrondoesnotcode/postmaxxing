const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  passesPreGate,
  extractStage1,
  generateStage2,
  loadState,
  recordApprovals,
  saveState,
} = require('../postmaxx.js');

// ─── Fixture helpers ───────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, 'fixtures');
const richSession  = () => fs.readFileSync(path.join(FIXTURES, 'session-rich.jsonl'), 'utf8');
const thinSession  = () => fs.readFileSync(path.join(FIXTURES, 'session-thin.jsonl'), 'utf8');
const grindSession = () => fs.readFileSync(path.join(FIXTURES, 'session-grind.jsonl'), 'utf8');
const stateWithArc = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'state-with-arc.json'), 'utf8'));
const emptyState   = () => ({ active_arcs: [], recent_posts: [], last_session_summary: null });

// Canonical fake extraction for pricing session
const richExtraction = {
  has_reasoning: true,
  best_output_type: 'story',
  active_arc: null,
  decisions: [{
    what: 'switched Starter from $19 to $29 with 100-scan cap',
    why: 'unit economics: $0.16/scan made $19 lose money on heavy users',
    alternatives: ['raise prices later'],
    tradeoff: 'fewer signups for sustainable margin',
  }],
  key_numbers: ['$0.16/scan', '$19', '$29', '100 scans'],
  wrong_about: 'thought hosting was the main cost — it is API',
  moment_of_realization: 'looked at unit economics and saw the loss',
  quotable_lines: ['I had been carrying the wrong unit-economics number for three weeks'],
  technical_specifics: { stack: [], patterns: [], constraints: [] },
};

const nothingExtraction = {
  has_reasoning: false,
  best_output_type: 'nothing',
  active_arc: null,
  decisions: [], key_numbers: [], wrong_about: null, moment_of_realization: null,
  quotable_lines: [], technical_specifics: { stack: [], patterns: [], constraints: [] },
};

// ─── Gate tests ────────────────────────────────────────────────────────────

test('smoke: thin session fails pre-gate', () => {
  const result = passesPreGate(thinSession());
  assert.strictEqual(result.ok, false);
});

test('smoke: grind session passes pre-gate', () => {
  const raw = grindSession();
  assert.ok(raw.length >= 5120, `grind fixture is only ${raw.length} bytes — must be ≥5120`);
  const result = passesPreGate(raw);
  assert.strictEqual(result.ok, true);
});

// ─── Full pipeline: rich session → story candidates ────────────────────────

test('smoke: rich session → Haiku extraction → Sonnet generation (story mode)', async () => {
  // Two-call stub: first call → Haiku extraction, second call → Sonnet generation
  const callModels = [];
  const stubFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    callModels.push(body.model);
    if (body.model.includes('haiku')) {
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: JSON.stringify(richExtraction) }] }),
      };
    }
    // Sonnet call
    return {
      ok: true,
      json: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            candidates: [
              {
                shape: 'single',
                type: 'story',
                label: 'pricing realization',
                text: 'three weeks with the wrong number. $0.16/scan at $19 = losing money on heavy users. switched to $29 + 100-scan cap.',
                tweets: null,
                arc: null,
                summary_for_state: 'shared pricing change driven by unit economics',
              },
              {
                shape: 'thread',
                type: 'story',
                label: 'full pricing reasoning',
                text: null,
                tweets: [
                  'priced Clipmatic Starter at $19/mo. seemed fine.',
                  'then I looked at unit economics. $0.16/scan. heavy user (200 scans) = $32 cost. I was losing $13.',
                  'fix: $29 Starter, 100-scan cap. most users do under 50 anyway.',
                ],
                arc: null,
                summary_for_state: 'thread on pricing reasoning and cap decision',
              },
            ],
          }),
        }],
      }),
    };
  };

  const state = emptyState();

  // Stage 1: extraction
  const extraction = await extractStage1(richSession(), state, { fetchFn: stubFetch, apiKey: 'test-key' });
  assert.strictEqual(extraction.has_reasoning, true, 'Stage 1 should detect reasoning');
  assert.strictEqual(extraction.best_output_type, 'story');
  assert.ok(extraction.decisions.length > 0, 'Should have at least one decision');

  // Stage 2: generation
  const result = await generateStage2(extraction, state, {
    mode: 'story', count: 2, fetchFn: stubFetch, apiKey: 'test-key',
  });
  assert.strictEqual(result.candidates.length, 2, 'Should return 2 candidates');
  assert.strictEqual(result.candidates[0].shape, 'single');
  assert.strictEqual(result.candidates[1].shape, 'thread');
  assert.ok(result.candidates[0].text.includes('$0.16'), 'Single should contain the key number');
  assert.strictEqual(result.candidates[1].tweets.length, 3, 'Thread should have 3 tweets');

  // Verify two API calls happened (Haiku + Sonnet) in the correct order
  assert.strictEqual(callModels.length, 2, 'Should make exactly 2 API calls');
  assert.strictEqual(callModels[0], 'claude-haiku-4-5', '1st call must be Haiku (Stage 1)');
  assert.strictEqual(callModels[1], 'claude-sonnet-4-6', '2nd call must be Sonnet (Stage 2)');
});

// ─── Full pipeline: grind session → nothing extraction ────────────────────

test('smoke: grind session → Haiku returns nothing → no Stage 2 call', async () => {
  let callCount = 0;
  const stubFetch = async (url, opts) => {
    callCount++;
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(nothingExtraction) }] }),
    };
  };

  const extraction = await extractStage1(grindSession(), emptyState(), { fetchFn: stubFetch, apiKey: 'k' });
  assert.strictEqual(extraction.has_reasoning, false);
  assert.strictEqual(extraction.best_output_type, 'nothing');
  // Only 1 API call (Haiku). Caller (main) decides not to call Stage 2.
  assert.strictEqual(callCount, 1, 'Grind session should only hit Haiku, not Sonnet');
});

// ─── Arc continuation scenario ────────────────────────────────────────────

test('smoke: session with active arc → extraction reflects continuation', async () => {
  const arcState = stateWithArc(); // has active_arcs: ['pricing redesign']

  const continuationExtraction = {
    ...richExtraction,
    best_output_type: 'continuation',
    active_arc: 'pricing redesign',
  };

  let capturedPrompt = null;
  const stubFetch = async (url, opts) => {
    capturedPrompt = JSON.parse(opts.body).messages[0].content;
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(continuationExtraction) }] }),
    };
  };

  const extraction = await extractStage1(richSession(), arcState, { fetchFn: stubFetch, apiKey: 'k' });
  assert.ok(capturedPrompt, 'Stage 1 should have sent a prompt');
  assert.match(capturedPrompt, /pricing redesign/, 'Active arc should appear in the extraction prompt');
  assert.strictEqual(extraction.best_output_type, 'continuation');
  assert.strictEqual(extraction.active_arc, 'pricing redesign');
});

// ─── Approval recording integration ───────────────────────────────────────

test('smoke: approvals from pipeline update project state', () => {
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'postmaxx-smoke-'));
  const slug = 'clipmatic';

  recordApprovals(slug, [
    { summary: 'shared pricing change via unit economics', type: 'story', arc: null },
  ], { stateDir: tmp, today: '2026-04-25' });

  const state = loadState(slug, { stateDir: tmp });
  assert.strictEqual(state.recent_posts.length, 1);
  assert.strictEqual(state.recent_posts[0].summary, 'shared pricing change via unit economics');
  assert.strictEqual(state.recent_posts[0].date, '2026-04-25');
});

// ─── Technical mode produces different prompt than story mode ────────────

test('smoke: technical mode sends different prompt to Sonnet than story mode', async () => {
  const prompts = {};
  const stubFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    prompts[body.model] = body.messages[0].content;
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ candidates: [] }) }] }),
    };
  };

  // Run story mode
  await generateStage2(richExtraction, emptyState(), { mode: 'story', count: 1, fetchFn: stubFetch, apiKey: 'k' });
  const storyPrompt = prompts['claude-sonnet-4-6'];

  // Run technical mode
  await generateStage2(richExtraction, emptyState(), { mode: 'technical', count: 1, fetchFn: stubFetch, apiKey: 'k' });
  const techPrompt = prompts['claude-sonnet-4-6'];

  assert.notStrictEqual(storyPrompt, techPrompt, 'Story and technical prompts must differ');
  assert.match(storyPrompt, /STORY/);
  assert.match(techPrompt, /TECHNICAL/);
});
