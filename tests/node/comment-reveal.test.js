import assert from 'node:assert/strict';
import test from 'node:test';

import { commentUiCardMethods } from '../../src/client/presentation/comment-ui/comment-ui-card.js';
import { commentUiStateMethods } from '../../src/client/presentation/comment-ui/comment-ui-state.js';

function createHarness({ threads = [], supported = true } = {}) {
  const revealCalls = [];
  const navigateCalls = [];
  const renderCalls = [];

  const harness = {
    supported,
    threads,
    activeCard: null,
    reactionPicker: null,
    session: {
      getCommentAnchorClientRect: () => null,
    },
    onRevealAnchor: (anchor) => revealCalls.push(anchor),
    onNavigateToLine: (line) => navigateCalls.push(line),
    render: () => renderCalls.push('render'),
    renderCard: () => renderCalls.push('renderCard'),
    renderDrawer: () => renderCalls.push('renderDrawer'),
    renderToolbar: () => renderCalls.push('renderToolbar'),
    scheduleLayoutRefresh: () => renderCalls.push('scheduleLayoutRefresh'),
    clearPreviewSelection: () => renderCalls.push('clearPreviewSelection'),
    getThreadGroups: commentUiStateMethods.getThreadGroups,
    openThreadFromOverview: commentUiStateMethods.openThreadFromOverview,
    openThreadGroup: commentUiCardMethods.openThreadGroup,
    closeCard: commentUiCardMethods.closeCard,
    closeThreadCard: commentUiStateMethods.closeThreadCard,
  };

  return { harness, revealCalls, navigateCalls, renderCalls };
}

const sampleThread = {
  id: 'thread-1',
  anchor: {
    anchorKind: 'line',
    startLine: 5,
    endLine: 5,
    quote: 'anchored text',
  },
  messages: [{ id: 'm1', body: 'comment', userName: 'reviewer' }],
};

test('openThreadFromOverview calls onRevealAnchor with the thread anchor', () => {
  const { harness, revealCalls } = createHarness({ threads: [sampleThread] });

  const didOpen = harness.openThreadFromOverview('thread-1');

  assert.equal(didOpen, true);
  assert.equal(revealCalls.length, 1);
  assert.deepEqual(revealCalls[0], sampleThread.anchor);
});

test('openThreadGroup calls onRevealAnchor with the group anchor', () => {
  const { harness, revealCalls } = createHarness({ threads: [sampleThread] });
  const group = harness.getThreadGroups()[0];

  harness.openThreadGroup(group, {
    anchor: group.anchor,
    origin: 'editor',
    sourceRect: null,
  });

  assert.equal(revealCalls.length, 1);
  assert.deepEqual(revealCalls[0], group.anchor);
});

test('closeCard calls onRevealAnchor with null to clear the highlight', () => {
  const { harness, revealCalls } = createHarness({ threads: [sampleThread] });
  const group = harness.getThreadGroups()[0];

  harness.openThreadGroup(group, {
    anchor: group.anchor,
    origin: 'editor',
    sourceRect: null,
  });
  harness.closeCard();

  assert.equal(revealCalls.length, 2);
  assert.deepEqual(revealCalls[0], group.anchor);
  assert.equal(revealCalls[1], null);
});

test('openThreadFromOverview returns false when thread is not found', () => {
  const { harness, revealCalls } = createHarness({ threads: [sampleThread] });

  const didOpen = harness.openThreadFromOverview('nonexistent');

  assert.equal(didOpen, false);
  assert.equal(revealCalls.length, 0);
});

test('closeThreadCard calls onRevealAnchor with null', () => {
  const { harness, revealCalls } = createHarness();

  harness.closeThreadCard();

  assert.equal(revealCalls.length, 1);
  assert.equal(revealCalls[0], null);
});
