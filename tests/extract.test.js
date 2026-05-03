const test = require('node:test');
const assert = require('node:assert');
const { buildExtractionPrompt, extractStage1 } = require('../postmaxx.js');

const emptyState = { active_arcs: [], recent_posts: [], last_session_summary: null };

test('buildExtractionPrompt embeds the session text', () => {
  const prompt = buildExtractionPrompt('UNIQUE_MARKER_XYZ', emptyState);
  assert.match(prompt, /UNIQUE_MARKER_XYZ/);
});

test('buildExtractionPrompt mentions active arcs', () => {
  const state = { active_arcs: ['pricing redesign'], recent_posts: [], last_session_summary: null };
  const prompt = buildExtractionPrompt('session', state);
  assert.match(prompt, /pricing redesign/);
});

test('buildExtractionPrompt includes recent posts for continuation detection', () => {
  const state = {
    active_arcs: [],
    recent_posts: [{ date: '2026-04-24', summary: 'shared unit economics', type: 'story' }],
    last_session_summary: null,
  };
  const prompt = buildExtractionPrompt('session', state);
  assert.match(prompt, /shared unit economics/);
});

test('buildExtractionPrompt instructs model to return required JSON schema fields', () => {
  const prompt = buildExtractionPrompt('session', emptyState);
  assert.match(prompt, /has_reasoning/);
  assert.match(prompt, /best_output_type/);
  assert.match(prompt, /decisions/);
  assert.match(prompt, /quotable_lines/);
  assert.match(prompt, /technical_specifics/);
});

test('buildExtractionPrompt instructs model to only include items from the session', () => {
  const prompt = buildExtractionPrompt('session', emptyState);
  assert.match(prompt, /only|explicitly|do not invent/i);
});

const fakeExtraction = {
  has_reasoning: true,
  best_output_type: 'story',
  active_arc: null,
  decisions: [{ what: 'changed pricing', why: 'unit economics', alternatives: [], tradeoff: 'margin vs signups' }],
  key_numbers: ['$0.16/scan'],
  wrong_about: null,
  moment_of_realization: null,
  quotable_lines: [],
  technical_specifics: { stack: [], patterns: [], constraints: [] },
};

test('extractStage1 returns parsed extraction JSON from Haiku response', async () => {
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify(fakeExtraction) }] }),
  });

  const result = await extractStage1('session text', { active_arcs: [], recent_posts: [], last_session_summary: null }, {
    fetchFn: stubFetch,
    apiKey: 'test-key',
  });

  assert.strictEqual(result.has_reasoning, true);
  assert.strictEqual(result.best_output_type, 'story');
  assert.deepStrictEqual(result.key_numbers, ['$0.16/scan']);
});

test('extractStage1 strips markdown fences from response', async () => {
  const nothing = {
    has_reasoning: false, best_output_type: 'nothing', active_arc: null,
    decisions: [], key_numbers: [], wrong_about: null, moment_of_realization: null,
    quotable_lines: [], technical_specifics: { stack: [], patterns: [], constraints: [] },
  };
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(nothing) + '\n```' }] }),
  });

  const result = await extractStage1('s', { active_arcs: [], recent_posts: [], last_session_summary: null }, {
    fetchFn: stubFetch,
    apiKey: 'k',
  });

  assert.strictEqual(result.has_reasoning, false);
});

test('extractStage1 throws on API error', async () => {
  const stubFetch = async () => ({
    ok: false,
    json: async () => ({ error: { message: 'rate limited' } }),
  });

  await assert.rejects(
    extractStage1('s', { active_arcs: [], recent_posts: [], last_session_summary: null }, { fetchFn: stubFetch, apiKey: 'k' }),
    /rate limited/
  );
});

test('extractStage1 calls Haiku model (not Sonnet)', async () => {
  let capturedBody;
  const stubFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(fakeExtraction) }] }),
    };
  };

  await extractStage1('session', { active_arcs: [], recent_posts: [], last_session_summary: null }, {
    fetchFn: stubFetch,
    apiKey: 'k',
  });

  assert.match(capturedBody.model, /haiku/i);
});
