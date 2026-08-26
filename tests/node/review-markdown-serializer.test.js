import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serializeReviewToMarkdown } from '../../src/domain/review-markdown-serializer.js';

function makeThread(overrides = {}) {
  return {
    anchorKind: 'line',
    anchorQuote: 'The cache will store all responses indefinitely.',
    anchorStartLine: 42,
    anchorEndLine: 42,
    createdAt: Date.parse('2026-08-26T14:03:00Z'),
    createdByName: 'imihai',
    id: 'thread-1',
    messages: [{
      body: 'This will OOM. Add LRU eviction.',
      createdAt: Date.parse('2026-08-26T14:03:00Z'),
      id: 'comment-1',
      userName: 'imihai',
    }],
    resolvedAt: null,
    resolvedByName: '',
    ...overrides,
  };
}

test('serializeReviewToMarkdown returns the proposal verbatim when there are no threads', () => {
  const proposal = '# Plan\n\nDo the thing.\n';
  const result = serializeReviewToMarkdown({ proposalMarkdown: proposal, threads: [] });
  assert.equal(result, proposal);
});

test('serializeReviewToMarkdown appends a Review Comments appendix with line-anchored threads', () => {
  const proposal = '# Plan\n\nDo the thing.\n';
  const result = serializeReviewToMarkdown({ proposalMarkdown: proposal, threads: [makeThread()] });
  assert.ok(result.startsWith(proposal), 'proposal must be verbatim at the top');
  assert.ok(result.includes('---'), 'separator must be present');
  assert.ok(result.includes('## Review Comments'), 'appendix heading must be present');
  assert.ok(result.includes('### Line 42'), 'thread heading must reference the anchor line');
  assert.ok(result.includes('This will OOM. Add LRU eviction.'), 'comment body must be present');
  assert.ok(result.includes('@imihai'), 'comment author must be present');
});

test('serializeReviewToMarkdown excludes resolved threads by default and includes them when asked', () => {
  const resolved = makeThread({
    resolvedAt: Date.parse('2026-08-26T15:00:00Z'),
    resolvedByName: 'imihai',
  });
  const open = makeThread({
    id: 'thread-2',
    anchorStartLine: 10,
    anchorEndLine: 10,
    messages: [{
      body: 'Open comment.',
      createdAt: Date.parse('2026-08-26T14:00:00Z'),
      id: 'comment-2',
      userName: 'imihai',
    }],
  });

  const defaultResult = serializeReviewToMarkdown({
    proposalMarkdown: '# Plan\n',
    threads: [resolved, open],
  });
  assert.ok(defaultResult.includes('Line 10'), 'open thread must appear by default');
  assert.ok(!defaultResult.includes('Line 42'), 'resolved thread must be excluded by default');

  const includeResolvedResult = serializeReviewToMarkdown({
    proposalMarkdown: '# Plan\n',
    threads: [resolved, open],
    includeResolved: true,
  });
  assert.ok(includeResolvedResult.includes('(resolved by imihai)'), 'resolved marker must appear when included');
  assert.ok(includeResolvedResult.includes('Line 42'), 'resolved thread must appear when included');
});

test('serializeReviewToMarkdown sorts threads by anchor line ascending', () => {
  const later = makeThread({ id: 't-later', anchorStartLine: 100, anchorEndLine: 100 });
  const earlier = makeThread({ id: 't-earlier', anchorStartLine: 5, anchorEndLine: 5 });
  const result = serializeReviewToMarkdown({
    proposalMarkdown: '# Plan\n',
    threads: [later, earlier],
  });
  const earlierIndex = result.indexOf('Line 5');
  const laterIndex = result.indexOf('Line 100');
  assert.ok(earlierIndex > -1 && laterIndex > -1);
  assert.ok(earlierIndex < laterIndex, 'earlier line must appear first');
});

test('serializeReviewToMarkdown renders diagram-element anchors without a line number', () => {
  const diagramThread = makeThread({
    anchorKind: 'diagram-element',
    elementId: 'flowchart-node-A',
    anchorStartLine: null,
    anchorEndLine: null,
  });
  const result = serializeReviewToMarkdown({
    proposalMarkdown: '# Plan\n',
    threads: [diagramThread],
  });
  assert.ok(result.includes('### Diagram flowchart-node-A'), 'diagram heading must not reference a line');
  assert.ok(!result.includes('### Line'), 'no line heading for diagram anchors');
});

test('serializeReviewToMarkdown renders multiple messages in chronological order', () => {
  const thread = makeThread({
    messages: [
      { body: 'Second.', createdAt: Date.parse('2026-08-26T14:10:00Z'), id: 'c2', userName: 'imihai' },
      { body: 'First.', createdAt: Date.parse('2026-08-26T14:03:00Z'), id: 'c1', userName: 'imihai' },
    ],
  });
  const result = serializeReviewToMarkdown({ proposalMarkdown: '# Plan\n', threads: [thread] });
  const firstIndex = result.indexOf('First.');
  const secondIndex = result.indexOf('Second.');
  assert.ok(firstIndex < secondIndex, 'earlier message must appear first');
});

test('serializeReviewToMarkdown appends (edited) to messages with editedAt set', () => {
  const thread = makeThread({
    messages: [{
      body: 'Edited body.',
      createdAt: Date.parse('2026-08-26T14:03:00Z'),
      editedAt: Date.parse('2026-08-26T14:05:00Z'),
      id: 'c1',
      userName: 'imihai',
    }],
  });
  const result = serializeReviewToMarkdown({ proposalMarkdown: '# Plan\n', threads: [thread] });
  assert.ok(result.includes('(edited)'), 'edited marker must appear');
  assert.ok(result.includes('Edited body.'), 'edited body must appear');
});

test('serializeReviewToMarkdown does not append (edited) to messages without editedAt', () => {
  const thread = makeThread({
    messages: [{
      body: 'Original body.',
      createdAt: Date.parse('2026-08-26T14:03:00Z'),
      id: 'c1',
      userName: 'imihai',
    }],
  });
  const result = serializeReviewToMarkdown({ proposalMarkdown: '# Plan\n', threads: [thread] });
  assert.ok(!result.includes('(edited)'), 'no edited marker for unedited messages');
});
