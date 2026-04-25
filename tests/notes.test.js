const test = require('node:test');
const assert = require('node:assert');
const { buildNoteContent } = require('../devlog.js');

const sampleResult = {
  candidates: [
    {
      shape: 'single',
      type: 'story',
      label: 'pricing realization',
      text: 'three weeks with the wrong number. $0.16/scan at $19 = losing money.',
      tweets: null,
      arc: null,
      summary_for_state: 'pricing change',
    },
    {
      shape: 'thread',
      type: 'story',
      label: 'full reasoning',
      text: null,
      tweets: [
        'priced Clipmatic at $19/mo.',
        'looked at unit economics. losing money.',
        'fix: $29 + 100-scan cap.',
      ],
      arc: null,
      summary_for_state: 'thread on pricing',
    },
  ],
};

test('buildNoteContent includes project name and date', () => {
  const content = buildNoteContent(sampleResult, 'clipmatic', 'story', '2026-04-25');
  assert.match(content, /clipmatic/i);
  assert.match(content, /2026-04-25/);
});

test('buildNoteContent includes single tweet text', () => {
  const content = buildNoteContent(sampleResult, 'clipmatic', 'story', '2026-04-25');
  assert.match(content, /\$0\.16\/scan/);
  assert.match(content, /SINGLE/);
});

test('buildNoteContent includes thread tweets numbered', () => {
  const content = buildNoteContent(sampleResult, 'clipmatic', 'story', '2026-04-25');
  assert.match(content, /THREAD/);
  assert.match(content, /1\/3/);
  assert.match(content, /priced Clipmatic at \$19\/mo\./);
});

test('buildNoteContent includes mode in header', () => {
  const content = buildNoteContent(sampleResult, 'clipmatic', 'technical', '2026-04-25');
  assert.match(content, /technical/i);
});

test('buildNoteContent handles empty candidates gracefully', () => {
  const content = buildNoteContent({ candidates: [] }, 'myproj', 'story', '2026-04-25');
  assert.ok(typeof content === 'string');
  assert.match(content, /myproj/i);
});
