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
