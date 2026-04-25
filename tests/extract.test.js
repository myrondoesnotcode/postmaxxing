const test = require('node:test');
const assert = require('node:assert');
const { buildExtractionPrompt } = require('../devlog.js');

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
