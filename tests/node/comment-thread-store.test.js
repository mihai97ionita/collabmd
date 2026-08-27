import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

import { createCommentThreadSharedType, serializeCommentThreads } from '../../src/domain/comment-threads.js';
import { CommentThreadStore } from '../../src/client/infrastructure/comment-thread-store.js';

function createStoreHarness() {
  const doc = new Y.Doc();
  const commentThreads = doc.getArray('comments');
  const ytext = doc.getText('codemirror');
  ytext.insert(0, '# Notes\n\nHello\n');
  const localUserRef = {
    current: {
      color: '#3b82f6',
      name: 'Tester',
      peerId: 'peer-1',
      userId: 'user-1',
    },
  };

  const store = new CommentThreadStore({
    getDoc: () => doc,
    getEditorState: () => null,
    getLocalUser: () => localUserRef.current,
  });
  store.bind({ commentThreads, ydoc: doc, ytext });

  return {
    commentThreads,
    localUserRef,
    store,
  };
}

function seedThread(commentThreads, reactions = []) {
  commentThreads.push([createCommentThreadSharedType({
    anchorEnd: { assoc: 0, type: null },
    anchorEndLine: 3,
    anchorKind: 'line',
    anchorQuote: 'Hello',
    anchorStart: { assoc: 0, type: null },
    anchorStartLine: 3,
    id: 'thread-1',
    messages: [{
      body: 'Hello comment',
      id: 'comment-1',
      reactions,
      userName: 'Tester',
    }],
  })]);
}

test('toggleCommentReaction adds and removes the local reaction', () => {
  const { commentThreads, store } = createStoreHarness();
  seedThread(commentThreads);

  assert.equal(store.toggleCommentReaction('thread-1', 'comment-1', '👍'), true);
  let [thread] = serializeCommentThreads(commentThreads);
  assert.equal(thread.messages[0].reactions.length, 1);
  assert.equal(thread.messages[0].reactions[0].emoji, '👍');
  assert.equal(thread.messages[0].reactions[0].users.length, 1);
  assert.equal(thread.messages[0].reactions[0].users[0].userId, 'user-1');

  assert.equal(store.toggleCommentReaction('thread-1', 'comment-1', '👍'), true);
  [thread] = serializeCommentThreads(commentThreads);
  assert.deepEqual(thread.messages[0].reactions, []);
});

test('toggleCommentReaction aggregates multiple users and removes empty groups', () => {
  const { commentThreads, localUserRef, store } = createStoreHarness();
  seedThread(commentThreads);

  assert.equal(store.toggleCommentReaction('thread-1', 'comment-1', '🎉'), true);
  localUserRef.current = {
    color: '#22c55e',
    name: 'Reviewer',
    peerId: 'peer-2',
    userId: 'user-2',
  };
  assert.equal(store.toggleCommentReaction('thread-1', 'comment-1', '🎉'), true);

  let [thread] = serializeCommentThreads(commentThreads);
  assert.equal(thread.messages[0].reactions.length, 1);
  assert.equal(thread.messages[0].reactions[0].users.length, 2);
  assert.deepEqual(thread.messages[0].reactions[0].users.map((user) => user.userId), ['user-1', 'user-2']);

  localUserRef.current = {
    color: '#3b82f6',
    name: 'Tester',
    peerId: 'peer-1',
    userId: 'user-1',
  };
  assert.equal(store.toggleCommentReaction('thread-1', 'comment-1', '🎉'), true);
  [thread] = serializeCommentThreads(commentThreads);
  assert.equal(thread.messages[0].reactions[0].users.length, 1);
  assert.equal(thread.messages[0].reactions[0].users[0].userId, 'user-2');

  localUserRef.current = {
    color: '#22c55e',
    name: 'Reviewer',
    peerId: 'peer-2',
    userId: 'user-2',
  };
  assert.equal(store.toggleCommentReaction('thread-1', 'comment-1', '🎉'), true);
  [thread] = serializeCommentThreads(commentThreads);
  assert.deepEqual(thread.messages[0].reactions, []);
});

test('resolveCommentThread returns a diagram-element thread without touching the editor doc', () => {
  const doc = new Y.Doc();
  const commentThreads = doc.getArray('comments');
  const ytext = doc.getText('codemirror');
  const localUserRef = {
    current: { color: '#3b82f6', name: 'Tester', peerId: 'peer-1', userId: 'user-1' },
  };
  const fakeState = { doc: { line: () => { throw new Error('must not be called for diagram anchors'); } } };
  const store = new CommentThreadStore({
    getDoc: () => doc,
    getEditorState: () => fakeState,
    getLocalUser: () => localUserRef.current,
  });
  store.bind({ commentThreads, ydoc: doc, ytext });

  commentThreads.push([createCommentThreadSharedType({
    anchorEndLine: 48,
    anchorKind: 'diagram-element',
    anchorPoint: { x: 100, y: 50 },
    anchorQuote: 'Validate auth token',
    anchorSnapshot: { height: 40, text: 'Validate auth token', type: 'node', width: 120, x: 80, y: 30 },
    anchorStartLine: 42,
    diagramKey: 'mermaid-source-0',
    elementId: 'A1',
    id: 'thread-diag-1',
    messages: [{ body: 'Diagram comment', id: 'comment-diag-1', userName: 'Tester' }],
  })]);

  const resolved = store.getCommentThreads();
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].anchorKind, 'diagram-element');
  assert.equal(resolved[0].elementId, 'A1');
  assert.equal(resolved[0].anchor.anchorKind, 'diagram-element');
  assert.equal(resolved[0].anchor.elementId, 'A1');
  assert.equal(resolved[0].anchor.diagramKey, 'mermaid-source-0');
  assert.equal(resolved[0].anchor.startLine, 42);
  assert.equal(resolved[0].anchor.endLine, 48);
  assert.equal(resolved[0].anchor.quote, 'Validate auth token');
});

test('editCommentMessage updates the body and records editedAt', () => {
  const { commentThreads, store } = createStoreHarness();
  seedThread(commentThreads);

  assert.equal(store.editCommentMessage('thread-1', 'comment-1', 'Updated body'), true);
  const [thread] = serializeCommentThreads(commentThreads);
  assert.equal(thread.messages[0].body, 'Updated body');
  assert.ok(Number.isFinite(thread.messages[0].editedAt), 'editedAt must be set');
});

test('resolveCommentThread marks the thread resolved without deleting it', () => {
  const { commentThreads, store } = createStoreHarness();
  seedThread(commentThreads);

  assert.equal(store.resolveCommentThread('thread-1'), true);

  const sharedThread = commentThreads.toArray().find((entry) => entry.get('id') === 'thread-1');
  assert.ok(sharedThread, 'thread must still exist in the Yjs array (not deleted)');
  assert.ok(Number.isFinite(sharedThread.get('resolvedAt')), 'resolvedAt must be set');
  assert.equal(sharedThread.get('resolvedByName'), 'Tester');
  assert.equal(sharedThread.get('resolvedByPeerId'), 'peer-1');
});

test('resolveCommentThread returns false for an unknown thread id', () => {
  const { store } = createStoreHarness();
  assert.equal(store.resolveCommentThread('does-not-exist'), false);
});

test('resolveCommentThread is excluded by default serialization but included with includeResolved-aware readers', () => {
  const { commentThreads, store } = createStoreHarness();
  seedThread(commentThreads);

  store.resolveCommentThread('thread-1');

  const defaultSerialized = serializeCommentThreads(commentThreads);
  assert.equal(defaultSerialized.length, 0, 'serializeCommentThreads skips resolved threads by default');

  const rawArray = commentThreads.toArray();
  const sharedThread = rawArray.find((entry) => entry.get('id') === 'thread-1');
  assert.ok(Number.isFinite(sharedThread.get('resolvedAt')), 'resolved thread is still present in the raw array');
});
