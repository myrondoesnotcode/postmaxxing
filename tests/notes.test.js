const test = require('node:test');
const assert = require('node:assert');
const { buildNoteContent } = require('../postmaxx.js');

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

test('buildNoteContent includes project name and date in header', () => {
  // Use a result with no tweet content that echoes the project name,
  // so we're testing the header itself and not coincidental tweet content.
  const resultWithoutProjectName = {
    candidates: [{
      shape: 'single', type: 'story', label: 'test label',
      text: 'some tweet text with no project name in it', tweets: null, arc: null, summary_for_state: 's',
    }],
  };
  const content = buildNoteContent(resultWithoutProjectName, 'myuniqueslug', 'story', '2026-04-25');
  assert.match(content, /myuniqueslug/i);
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

const { exportToNotes } = require('../postmaxx.js');

test('exportToNotes calls execFn with osascript command containing title and body', () => {
  let capturedCmd = null;
  const stubExec = (cmd) => { capturedCmd = cmd; };

  const result = exportToNotes('My Title', 'My Body', { execFn: stubExec });

  assert.ok(capturedCmd, 'execFn should have been called');
  assert.match(capturedCmd, /osascript/);
  assert.match(capturedCmd, /My Title/);
  assert.match(capturedCmd, /My Body/);
  assert.strictEqual(result, true, 'Should return true on success');
});

test('exportToNotes does not throw when execFn succeeds', () => {
  const stubExec = () => {};
  assert.doesNotThrow(() => exportToNotes('T', 'B', { execFn: stubExec }));
});

test('exportToNotes warns but does not throw when execFn throws', () => {
  const stubExec = () => { throw new Error('osascript not found'); };
  assert.doesNotThrow(() => exportToNotes('T', 'B', { execFn: stubExec }));
  const result = exportToNotes('T', 'B', { execFn: stubExec });
  assert.strictEqual(result, false, 'Should return false when execFn throws');
});

test('exportToNotes skips when platform is not darwin', () => {
  let called = false;
  const stubExec = () => { called = true; };
  const result = exportToNotes('T', 'B', { execFn: stubExec, platform: 'linux' });
  assert.strictEqual(called, false, 'Should not call execFn on non-darwin');
  assert.strictEqual(result, false, 'Should return false when skipping');
});

test('exportToNotes escapes double quotes in title and body', () => {
  let capturedCmd = null;
  const stubExec = (cmd) => { capturedCmd = cmd; };
  exportToNotes('Title with "quotes"', 'Body with "quotes" inside', { execFn: stubExec });
  assert.ok(capturedCmd, 'execFn should have been called');
  assert.doesNotMatch(capturedCmd, /"quotes"/, 'Raw double quotes should not appear unescaped');
  assert.match(capturedCmd, /\\"quotes\\"/);
});

test('exportToNotes handles body with newlines', () => {
  let capturedCmd = null;
  const stubExec = (cmd) => { capturedCmd = cmd; };
  exportToNotes('T', 'line one\nline two', { execFn: stubExec });
  assert.ok(capturedCmd);
  assert.doesNotMatch(capturedCmd, /line one\nline two/, 'Literal newline should not appear in command');
  assert.match(capturedCmd, /line one\\nline two/);
});
