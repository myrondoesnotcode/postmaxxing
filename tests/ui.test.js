const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const { runPipeline } = require('../devlog.js');

const GRIND_SESSION = path.join(__dirname, 'fixtures', 'session-grind.jsonl');
const THIN_SESSION  = path.join(__dirname, 'fixtures', 'session-thin.jsonl');

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
  const result = await runPipeline(GRIND_SESSION, 'story', 2, {
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
  const result = await runPipeline(GRIND_SESSION, 'story', 2, {
    apiKey: 'test-key',
    fetchFn: noReasoningFetch,
  });
  assert.strictEqual(result.nothing, true);
});
