const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectSlug, loadState, saveState, recordApprovals } = require('../postmaxx.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postmaxx-state-'));
  const state = loadState('nonexistent-project', { stateDir: tmp });
  assert.deepStrictEqual(state, {
    active_arcs: [],
    recent_posts: [],
    last_session_summary: null,
  });
});

test('saveState then loadState round-trips state', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postmaxx-state-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postmaxx-state-'));
  fs.writeFileSync(path.join(tmp, 'corrupt.json'), '{not json');
  const state = loadState('corrupt', { stateDir: tmp });
  assert.deepStrictEqual(state, {
    active_arcs: [],
    recent_posts: [],
    last_session_summary: null,
  });
});

test('recordApprovals appends entries to recent_posts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postmaxx-state-'));
  const slug = 'p1';
  recordApprovals(slug, [
    { summary: 'pricing decision', type: 'story', arc: null },
  ], { stateDir: tmp, today: '2026-04-25' });

  const state = loadState(slug, { stateDir: tmp });
  assert.strictEqual(state.recent_posts.length, 1);
  assert.deepStrictEqual(state.recent_posts[0], { date: '2026-04-25', summary: 'pricing decision', type: 'story' });
});

test('recordApprovals merges new arcs without duplicates', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postmaxx-state-'));
  const slug = 'p2';
  saveState(slug, {
    active_arcs: ['existing arc'],
    recent_posts: [],
    last_session_summary: null,
  }, { stateDir: tmp });

  recordApprovals(slug, [
    { summary: 'x', type: 'story', arc: 'existing arc' },
    { summary: 'y', type: 'story', arc: 'new arc' },
  ], { stateDir: tmp });

  const state = loadState(slug, { stateDir: tmp });
  assert.deepStrictEqual(state.active_arcs.sort(), ['existing arc', 'new arc']);
});

test('recordApprovals trims recent_posts to last 20', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postmaxx-state-'));
  const slug = 'p3';
  const existing = {
    active_arcs: [],
    recent_posts: Array.from({ length: 19 }, (_, i) => ({
      date: '2026-04-01', summary: `old ${i}`, type: 'drip',
    })),
    last_session_summary: null,
  };
  saveState(slug, existing, { stateDir: tmp });

  recordApprovals(slug, [
    { summary: 'new one', type: 'story', arc: null },
    { summary: 'new two', type: 'continuation', arc: null },
  ], { stateDir: tmp, today: '2026-04-25' });

  const state = loadState(slug, { stateDir: tmp });
  assert.strictEqual(state.recent_posts.length, 20);
  assert.strictEqual(state.recent_posts[state.recent_posts.length - 1].summary, 'new two');
});
