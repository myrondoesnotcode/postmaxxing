const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { passesPreGate } = require('../devlog.js');

test('passesPreGate rejects session under 5KB', () => {
  const small = fs.readFileSync(path.join(__dirname, 'fixtures/session-thin.jsonl'), 'utf8');
  const result = passesPreGate(small);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /too short|bytes/i);
});

test('passesPreGate rejects session with too few message lines', () => {
  // Under 8 lines (4 exchanges * 2 messages each), regardless of size
  const tiny = '{"type":"user","message":{"content":"hi"}}\n'.repeat(3);
  const padded = tiny + 'x'.repeat(6000); // make it big enough to pass size gate
  // But wait — padded is not valid JSONL. Gate checks raw byte count and line count.
  // For this test, construct something big but with too few lines.
  const oneLine = '{"type":"user","message":{"content":"' + 'a'.repeat(2000) + '"}}\n';
  const fewLines = oneLine.repeat(3);
  assert.ok(fewLines.length > 5120); // size passes
  const result = passesPreGate(fewLines);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /exchanges|messages/i);
});

test('passesPreGate accepts rich session', () => {
  const rich = fs.readFileSync(path.join(__dirname, 'fixtures/session-grind.jsonl'), 'utf8');
  assert.ok(rich.length >= 5120, 'grind fixture must be ≥5KB');
  const result = passesPreGate(rich);
  assert.strictEqual(result.ok, true);
});
