const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectSlug, loadState, saveState } = require('../devlog.js');

test('projectSlug extracts last segment from encoded path', () => {
  assert.strictEqual(projectSlug('-Users-myrons-Claude-Projects-clipmatic'), 'clipmatic');
});

test('projectSlug handles nested project name', () => {
  assert.strictEqual(projectSlug('-home-user-projects-myapp'), 'myapp');
});

test('projectSlug returns empty string for empty input', () => {
  assert.strictEqual(projectSlug(''), '');
});

test('projectSlug returns last token for hyphenated project name (known limitation: encoding is lossy)', () => {
  // Claude Code encodes paths by replacing '/' with '-'.
  // A project at /Users/alice/my-cool-app encodes to -Users-alice-my-cool-app.
  // There is no way to distinguish path separators from hyphens in the project name.
  // The best we can do is return the last token, which will be 'app' not 'my-cool-app'.
  assert.strictEqual(projectSlug('-Users-alice-my-cool-app'), 'app');
});

test('loadState returns empty default when file does not exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-state-'));
  const state = loadState('nonexistent-project', { stateDir: tmp });
  assert.deepStrictEqual(state, {
    active_arcs: [],
    recent_posts: [],
    last_session_summary: null,
  });
});

test('saveState then loadState round-trips state', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-state-'));
  const slug = 'myproj';
  const written = {
    active_arcs: ['feature x'],
    recent_posts: [{ date: '2026-04-25', summary: 's', type: 'story' }],
    last_session_summary: 'did stuff',
  };
  saveState(slug, written, { stateDir: tmp });
  const read = loadState(slug, { stateDir: tmp });
  assert.deepStrictEqual(read, written);
});

test('loadState recovers from corrupt file by returning empty default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-state-'));
  fs.writeFileSync(path.join(tmp, 'corrupt.json'), '{not json');
  const state = loadState('corrupt', { stateDir: tmp });
  assert.deepStrictEqual(state, {
    active_arcs: [],
    recent_posts: [],
    last_session_summary: null,
  });
});
