import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_PROVIDER,
  ANCHOR_STATUS,
  MIN_REANCHOR_QUOTE_LENGTH,
  detectAnchorProvider,
  moveCommentThreadAnchors,
  reconcileCommentThread,
  reconcileCommentThreads,
} from '../../src/domain/comment-anchors.js';

function makeTextThread(overrides = {}) {
  return {
    anchorEnd: { item: { client: 1, clock: 9 }, tname: 'codemirror' },
    anchorEndLine: 481,
    anchorKind: 'line',
    anchorQuote: 'Detection path: billingCode to MIGRATION_CUSTOMER',
    anchorStart: { item: { client: 1, clock: 8 }, tname: 'codemirror' },
    anchorStartLine: 481,
    id: 'thread-1',
    ...overrides,
  };
}

test('detectAnchorProvider maps line and text anchors to text', () => {
  assert.equal(detectAnchorProvider({ anchorKind: 'line' }), ANCHOR_PROVIDER.TEXT);
  assert.equal(detectAnchorProvider({ anchorKind: 'text' }), ANCHOR_PROVIDER.TEXT);
});

test('detectAnchorProvider maps diagram-element with diagramKey to mermaid by default', () => {
  assert.equal(
    detectAnchorProvider({ anchorKind: 'diagram-element', diagramKey: 'mermaid-0' }),
    ANCHOR_PROVIDER.MERMAID,
  );
});

test('detectAnchorProvider maps plantuml diagram keys to plantuml', () => {
  assert.equal(
    detectAnchorProvider({ anchorKind: 'diagram-element', diagramKey: 'plantuml-0' }),
    ANCHOR_PROVIDER.PLANTUML,
  );
});

test('detectAnchorProvider maps diagram-element without diagramKey to excalidraw', () => {
  assert.equal(
    detectAnchorProvider({ anchorKind: 'diagram-element', elementId: 'shape-1' }),
    ANCHOR_PROVIDER.EXCALIDRAW,
  );
});

test('reconcileCommentThread re-anchors on a unique quote match and clears stale positions', () => {
  const newDoc = [
    '# Title',
    '',
    'Detection path: billingCode to MIGRATION_CUSTOMER',
    '',
  ].join('\n');
  const result = reconcileCommentThread(makeTextThread(), newDoc);
  assert.equal(result.status, ANCHOR_STATUS.RESOLVED);
  assert.equal(result.thread.anchorStartLine, 3);
  assert.equal(result.thread.anchorEndLine, 3);
  assert.equal(result.thread.anchorStart, null, 'stale relative position must be cleared');
  assert.equal(result.thread.anchorEnd, null, 'stale relative position must be cleared');
  assert.equal(result.thread.anchorStatus, ANCHOR_STATUS.RESOLVED);
});

test('reconcileCommentThread marks multiple matches as ambiguous and does not move the anchor', () => {
  const newDoc = [
    'Detection path: billingCode to MIGRATION_CUSTOMER',
    'Detection path: billingCode to MIGRATION_CUSTOMER',
  ].join('\n');
  const thread = makeTextThread();
  const result = reconcileCommentThread(thread, newDoc);
  assert.equal(result.status, ANCHOR_STATUS.AMBIGUOUS);
  assert.equal(result.reason, 'quote-ambiguous');
  assert.equal(result.thread.anchorStartLine, 481, 'anchor must not move on ambiguity');
  assert.equal(result.thread.anchorStatus, ANCHOR_STATUS.AMBIGUOUS);
});

test('reconcileCommentThread marks a missing quote as missing and preserves the anchor', () => {
  const newDoc = '# Nothing here\n';
  const thread = makeTextThread();
  const result = reconcileCommentThread(thread, newDoc);
  assert.equal(result.status, ANCHOR_STATUS.MISSING);
  assert.equal(result.reason, 'quote-not-found');
  assert.equal(result.thread.anchorStartLine, 481);
  assert.equal(result.thread.anchorStatus, ANCHOR_STATUS.MISSING);
});

test('reconcileCommentThread refuses to re-anchor a quote shorter than the minimum', () => {
  const thread = makeTextThread({ anchorQuote: 'short' });
  const result = reconcileCommentThread(thread, 'short\n');
  assert.equal(result.status, ANCHOR_STATUS.MISSING);
  assert.equal(result.reason, 'quote-too-short');
});

test('reconcileCommentThread defers diagram-element anchors', () => {
  const thread = makeTextThread({
    anchorEnd: null,
    anchorKind: 'diagram-element',
    anchorSnapshot: { height: 10, text: 'A', type: 'node', width: 10, x: 0, y: 0 },
    anchorPoint: { x: 1, y: 2 },
    anchorStart: null,
    diagramKey: 'mermaid-0',
    elementId: 'A',
  });
  const result = reconcileCommentThread(thread, 'any\n');
  assert.equal(result.status, ANCHOR_STATUS.DEFERRED);
  assert.equal(result.thread.anchorStatus, ANCHOR_STATUS.DEFERRED);
  assert.equal(result.thread.elementId, 'A', 'diagram identity must be preserved');
});

test('reconcileCommentThread defers excalidraw anchors that have no diagramKey', () => {
  const thread = makeTextThread({
    anchorEnd: null,
    anchorKind: 'diagram-element',
    anchorSnapshot: { height: 10, text: 'A', type: 'rectangle', width: 10, x: 0, y: 0 },
    anchorPoint: { x: 1, y: 2 },
    anchorStart: null,
    elementId: 'shape-1',
  });
  const result = reconcileCommentThread(thread, 'any\n');
  assert.equal(result.status, ANCHOR_STATUS.DEFERRED);
  assert.equal(result.thread.anchorStatus, ANCHOR_STATUS.DEFERRED);
});

test('reconcileCommentThreads aggregates a report across mixed threads', () => {
  const newDoc = 'Detection path: billingCode to MIGRATION_CUSTOMER\n';
  const threads = [
    makeTextThread({ id: 'moved' }),
    makeTextThread({ id: 'gone', anchorQuote: 'Removed content that is long enough' }),
    makeTextThread({
      id: 'diagram',
      anchorKind: 'diagram-element',
      anchorPoint: { x: 1, y: 2 },
      anchorSnapshot: { height: 10, text: 'A', type: 'node', width: 10, x: 0, y: 0 },
      diagramKey: 'mermaid-0',
      elementId: 'A',
    }),
  ];
  const { report, threads: reconciled } = reconcileCommentThreads(threads, newDoc);
  assert.deepEqual(report.reanchored, ['moved']);
  assert.deepEqual(report.missing, ['gone']);
  assert.deepEqual(report.deferred, ['diagram']);
  assert.deepEqual(report.ambiguous, []);
  assert.equal(reconciled.length, 3);
});

test('reconcileCommentThreads treats a non-array input as empty', () => {
  const { report, threads } = reconcileCommentThreads(null, 'x');
  assert.deepEqual(threads, []);
  assert.deepEqual(report.reanchored, []);
});

test('MIN_REANCHOR_QUOTE_LENGTH is a positive guard', () => {
  assert.ok(Number.isFinite(MIN_REANCHOR_QUOTE_LENGTH) && MIN_REANCHOR_QUOTE_LENGTH > 0);
});

test('moveCommentThreadAnchors moves only requested text threads and preserves request order', () => {
  const threads = [
    makeTextThread({
      id: 'thread-1',
      messages: [{ body: 'keep me', id: 'message-1' }],
      metadata: { keep: true },
      resolvedAt: null,
    }),
    makeTextThread({ id: 'thread-2', anchorKind: 'text', resolvedAt: null }),
    makeTextThread({ id: 'untouched', resolvedAt: null }),
  ];
  const original = structuredClone(threads);
  const proposal = ['# Plan', 'Intro', 'tiny', 'A multi-line', 'quote target'].join('\n');

  const result = moveCommentThreadAnchors(threads, [
    { threadId: 'thread-2', startLine: 4, endLine: 5, quote: 'multi-line quote' },
    { threadId: 'thread-1', startLine: 3, endLine: 3, quote: 'tiny' },
  ], proposal);

  assert.equal(result.ok, true);
  assert.deepEqual(result.moved, ['thread-2', 'thread-1']);
  assert.equal(result.threads.length, threads.length);
  assert.deepEqual(threads, original, 'the pure transform must not mutate its inputs');
  assert.deepEqual(result.threads[0], {
    ...threads[0],
    anchorEnd: null,
    anchorEndLine: 3,
    anchorQuote: 'tiny',
    anchorStart: null,
    anchorStartLine: 3,
    anchorStatus: ANCHOR_STATUS.RESOLVED,
  });
  assert.equal(result.threads[0].messages, threads[0].messages, 'messages must be preserved');
  assert.deepEqual(result.threads[1], {
    ...threads[1],
    anchorEnd: null,
    anchorEndLine: 5,
    anchorQuote: 'multi-line quote',
    anchorStart: null,
    anchorStartLine: 4,
    anchorStatus: ANCHOR_STATUS.RESOLVED,
  });
  assert.equal(result.threads[2], threads[2], 'unrequested threads must be returned unchanged');
});

test('moveCommentThreadAnchors rejects malformed or empty move batches', () => {
  const threads = [makeTextThread({ resolvedAt: null })];
  const proposal = 'target line';
  for (const moves of [undefined, null, {}, [], [null], [
    { threadId: '', startLine: 1, endLine: 1, quote: 'target' },
  ]]) {
    const result = moveCommentThreadAnchors(threads, moves, proposal);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid-moves');
  }
});

test('moveCommentThreadAnchors validates the entire batch before transforming', () => {
  const threads = [makeTextThread({ resolvedAt: null })];
  const original = structuredClone(threads);
  const result = moveCommentThreadAnchors(threads, [
    { threadId: 'thread-1', startLine: 1, endLine: 1, quote: 'target' },
    { threadId: 'missing', startLine: 1, endLine: 1, quote: 'target' },
  ], 'target line');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'thread-not-found');
  assert.deepEqual(threads, original);
  assert.equal(result.threads, undefined, 'failed validation must not expose partially transformed threads');
});

test('moveCommentThreadAnchors rejects duplicate, resolved, and non-text targets', () => {
  const cases = [
    {
      code: 'duplicate-thread-id',
      threads: [makeTextThread({ resolvedAt: null })],
      moves: [
        { threadId: 'thread-1', startLine: 1, endLine: 1, quote: 'target' },
        { threadId: 'thread-1', startLine: 1, endLine: 1, quote: 'target' },
      ],
    },
    {
      code: 'resolved-thread',
      threads: [makeTextThread({ resolvedAt: 123 })],
      moves: [{ threadId: 'thread-1', startLine: 1, endLine: 1, quote: 'target' }],
    },
    {
      code: 'unsupported-anchor',
      threads: [makeTextThread({ anchorKind: 'diagram-element', resolvedAt: null })],
      moves: [{ threadId: 'thread-1', startLine: 1, endLine: 1, quote: 'target' }],
    },
  ];

  for (const fixture of cases) {
    const result = moveCommentThreadAnchors(fixture.threads, fixture.moves, 'target line');
    assert.equal(result.ok, false);
    assert.equal(result.code, fixture.code);
  }
});

test('moveCommentThreadAnchors rejects invalid ranges and quotes outside the selected lines', () => {
  const threads = [makeTextThread({ resolvedAt: null })];
  const proposal = ['first line', 'second target', 'third line'].join('\n');
  const invalidMoves = [
    { threadId: 'thread-1', startLine: 1.5, endLine: 2, quote: 'target' },
    { threadId: 'thread-1', startLine: 0, endLine: 1, quote: 'first' },
    { threadId: 'thread-1', startLine: 3, endLine: 2, quote: 'target' },
    { threadId: 'thread-1', startLine: 2, endLine: 4, quote: 'target' },
  ];
  for (const move of invalidMoves) {
    const result = moveCommentThreadAnchors(threads, [move], proposal);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid-range');
  }

  for (const quote of ['', '   ', 'first line']) {
    const result = moveCommentThreadAnchors(threads, [
      { threadId: 'thread-1', startLine: 2, endLine: 2, quote },
    ], proposal);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid-quote');
  }
});
