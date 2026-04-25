const test = require('node:test');
const assert = require('node:assert');
const { buildStoryPrompt, buildTechnicalPrompt, generateStage2 } = require('../devlog.js');

const sampleExtraction = {
  has_reasoning: true,
  best_output_type: 'story',
  active_arc: 'pricing redesign',
  decisions: [{
    what: 'switched Starter from $19 to $29 with 100-scan cap',
    why: 'unit economics: $0.16/scan made $19 lose money on heavy users',
    alternatives: ['raise prices later', 'cap at $19'],
    tradeoff: 'fewer signups for sustainable margin',
  }],
  key_numbers: ['$0.16/scan', '$19', '$29', '100 scans'],
  wrong_about: 'thought hosting was the main cost — it is API',
  moment_of_realization: 'looked at unit economics and saw the loss',
  quotable_lines: ['I had been carrying the wrong unit-economics number for three weeks'],
  technical_specifics: { stack: [], patterns: [], constraints: [] },
};

const emptyState = { active_arcs: [], recent_posts: [], last_session_summary: null };

// --- buildStoryPrompt ---

test('buildStoryPrompt embeds extraction key numbers', () => {
  const p = buildStoryPrompt(sampleExtraction, emptyState, { count: 3, voiceExamples: null });
  assert.match(p, /\$0\.16\/scan/);
});

test('buildStoryPrompt forbids em-dashes and hype phrases', () => {
  const p = buildStoryPrompt(sampleExtraction, emptyState, { count: 3 });
  assert.match(p, /em-dash/i);
  assert.match(p, /excited to share/i);
});

test('buildStoryPrompt requests JSON candidates output', () => {
  const p = buildStoryPrompt(sampleExtraction, emptyState, { count: 3 });
  assert.match(p, /candidates/i);
  assert.match(p, /summary_for_state/);
});

test('buildStoryPrompt embeds voice examples when provided', () => {
  const p = buildStoryPrompt(sampleExtraction, emptyState, {
    count: 3,
    voiceExamples: 'EXAMPLE_TWEET_UNIQUE_MARKER',
  });
  assert.match(p, /EXAMPLE_TWEET_UNIQUE_MARKER/);
});

// --- buildTechnicalPrompt ---

test('buildTechnicalPrompt differs from buildStoryPrompt', () => {
  const story = buildStoryPrompt(sampleExtraction, emptyState, { count: 3 });
  const tech  = buildTechnicalPrompt(sampleExtraction, emptyState, { count: 3 });
  assert.notStrictEqual(story, tech);
});

test('buildTechnicalPrompt mentions engineering or technical framing', () => {
  const p = buildTechnicalPrompt(sampleExtraction, emptyState, { count: 3 });
  assert.match(p, /technical|engineering|trade.off|stack/i);
});

// --- generateStage2 ---

const fakeCandidates = {
  candidates: [
    {
      shape: 'single',
      type: 'story',
      label: 'pricing realization',
      text: 'three weeks with the wrong number. $0.16/scan at $19 = losing money. switched to $29 + 100-scan cap.',
      tweets: null,
      arc: 'pricing redesign',
      summary_for_state: 'explained pricing change via unit economics',
    },
  ],
};

test('generateStage2 uses story prompt for mode=story and calls Sonnet', async () => {
  let capturedBody;
  const stubFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(fakeCandidates) }] }),
    };
  };

  const result = await generateStage2(sampleExtraction, emptyState, {
    mode: 'story', count: 1, fetchFn: stubFetch, apiKey: 'k',
  });

  assert.match(capturedBody.model, /sonnet/i);
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.candidates[0].shape, 'single');
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

  await generateStage2(sampleExtraction, emptyState, {
    mode: 'technical', count: 3, fetchFn: stubFetch, apiKey: 'k',
  });

  // The prompt passed to Sonnet should contain technical-specific framing
  // We verify by checking that the story prompt was NOT used (they differ)
  const storyPrompt = buildStoryPrompt(sampleExtraction, emptyState, { count: 3 });
  assert.notStrictEqual(capturedBody.messages[0].content, storyPrompt);
});

test('generateStage2 strips markdown fences from response', async () => {
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(fakeCandidates) + '\n```' }],
    }),
  });

  const result = await generateStage2(sampleExtraction, emptyState, {
    mode: 'story', count: 1, fetchFn: stubFetch, apiKey: 'k',
  });

  assert.strictEqual(result.candidates[0].label, 'pricing realization');
});

test('generateStage2 throws on API error', async () => {
  const stubFetch = async () => ({
    ok: false,
    json: async () => ({ error: { message: 'context window exceeded' } }),
  });

  await assert.rejects(
    generateStage2(sampleExtraction, emptyState, { mode: 'story', count: 1, fetchFn: stubFetch, apiKey: 'k' }),
    /context window exceeded/
  );
});

test('generateStage2 throws when response is missing candidates array', async () => {
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ items: [] }) }] }),
  });

  await assert.rejects(
    generateStage2(sampleExtraction, emptyState, { mode: 'story', count: 1, fetchFn: stubFetch, apiKey: 'k' }),
    /candidates/
  );
});
