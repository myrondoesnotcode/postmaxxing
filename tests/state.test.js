const test = require('node:test');
const assert = require('node:assert');
const { projectSlug } = require('../devlog.js');

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
