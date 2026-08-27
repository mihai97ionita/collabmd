import assert from 'node:assert/strict';
import test from 'node:test';

import { commentsFeature } from '../../src/client/application/app-shell/comments-feature.js';

test('comment overview selection keeps comments tab and opens anchored thread card', async () => {
  const calls = [];
  const context = {
    commentUi: {
      openThreadFromOverview: (threadId) => {
        calls.push(['openThreadFromOverview', threadId]);
        return true;
      },
    },
    closeSidebarOnMobile: () => calls.push(['closeSidebarOnMobile']),
    currentFilePath: 'notes/current.md',
    navigation: {
      navigateToFile: (filePath, options) => calls.push(['navigateToFile', filePath, options]),
    },
    session: {
      scrollToLine: (line, viewportRatio) => calls.push(['scrollToLine', line, viewportRatio]),
    },
    setSidebarTab: (tab) => calls.push(['setSidebarTab', tab]),
    setSidebarVisibility: (visible) => calls.push(['setSidebarVisibility', visible]),
    workspaceRouteController: {
      openFile: async (filePath) => {
        calls.push(['openFile', filePath]);
        context.currentFilePath = filePath;
      },
      preserveSidebarTabForNextFileRoute: (filePath) => calls.push(['preserveSidebarTabForNextFileRoute', filePath]),
    },
  };
  context.focusPendingCommentOverviewThread = commentsFeature.focusPendingCommentOverviewThread;

  await commentsFeature.openCommentOverviewThread.call(context, {
    anchor: { startLine: 12 },
    filePath: 'notes/target.md',
    threadId: 'thread-1',
  });

  assert.deepEqual(calls, [
    ['setSidebarTab', 'comments'],
    ['setSidebarVisibility', true],
    ['preserveSidebarTabForNextFileRoute', 'notes/target.md'],
    ['navigateToFile', 'notes/target.md', { line: 12 }],
    ['openFile', 'notes/target.md'],
    ['setSidebarTab', 'comments'],
    ['setSidebarVisibility', true],
    ['scrollToLine', 12, 0.2],
    ['openThreadFromOverview', 'thread-1'],
    ['setSidebarTab', 'comments'],
    ['closeSidebarOnMobile'],
  ]);
  assert.equal(context._pendingCommentOverviewFocus, null);
});

test('comment overview selection opens an Excalidraw thread in its diagram drawer', async () => {
  const calls = [];
  const context = {
    closeSidebarOnMobile: () => calls.push(['closeSidebarOnMobile']),
    currentFilePath: 'notes/current.md',
    excalidrawEmbed: {
      openCommentThread: (filePath, threadId) => calls.push(['openCommentThread', filePath, threadId]),
    },
    navigation: {
      navigateToFile: (filePath, options) => calls.push(['navigateToFile', filePath, options]),
    },
    setSidebarTab: (tab) => calls.push(['setSidebarTab', tab]),
    setSidebarVisibility: (visible) => calls.push(['setSidebarVisibility', visible]),
    workspaceRouteController: {
      openFile: async (filePath) => {
        calls.push(['openFile', filePath]);
        context.currentFilePath = filePath;
      },
      preserveSidebarTabForNextFileRoute: (filePath) => calls.push(['preserveSidebarTabForNextFileRoute', filePath]),
    },
  };

  await commentsFeature.openCommentOverviewThread.call(context, {
    anchor: { kind: 'diagram-element' },
    filePath: 'diagrams/target.excalidraw',
    threadId: 'thread-diagram',
  });

  assert.deepEqual(calls, [
    ['setSidebarTab', 'comments'],
    ['setSidebarVisibility', true],
    ['preserveSidebarTabForNextFileRoute', 'diagrams/target.excalidraw'],
    ['navigateToFile', 'diagrams/target.excalidraw', undefined],
    ['openFile', 'diagrams/target.excalidraw'],
    ['setSidebarTab', 'comments'],
    ['setSidebarVisibility', true],
    ['openCommentThread', 'diagrams/target.excalidraw', 'thread-diagram'],
    ['closeSidebarOnMobile'],
  ]);
});

test('comment overview tree changes refresh only while comments tab is active', () => {
  const calls = [];
  const filesContext = {
    activeSidebarTab: 'files',
    scheduleCommentOverviewRefresh: (options) => calls.push(['files-refresh', options]),
  };

  commentsFeature.handleCommentOverviewWorkspaceTreeChange.call(filesContext);

  assert.equal(filesContext._commentOverviewStale, true);
  assert.deepEqual(calls, []);

  const commentsContext = {
    activeSidebarTab: 'comments',
    scheduleCommentOverviewRefresh: (options) => calls.push(['comments-refresh', options]),
  };

  commentsFeature.handleCommentOverviewWorkspaceTreeChange.call(commentsContext);

  assert.equal(commentsContext._commentOverviewStale, true);
  assert.deepEqual(calls, [['comments-refresh', { delayMs: 0 }]]);
});

test('comment overview sidebar open clears stale state and refreshes', () => {
  const calls = [];
  const context = {
    _commentOverviewStale: true,
    commentsOverview: {
      refresh: () => calls.push(['refresh']),
    },
  };

  commentsFeature.refreshCommentOverviewForSidebarOpen.call(context);

  assert.equal(context._commentOverviewStale, false);
  assert.deepEqual(calls, [['refresh']]);
});

test('diagram comment reveal runs after pending line sync and renews suspension', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const frames = [];
  const calls = [];
  const anchor = {
    anchorKind: 'diagram-element',
    anchorStartLine: 42,
    elementId: 'flowchart-UserDb-0',
  };
  const session = {};
  const context = {
    previewRenderer: {
      revealDiagramElement: (value) => calls.push(['revealDiagramElement', value]),
    },
    scrollSyncController: {
      suspendSync: (duration) => calls.push(['suspendSync', duration]),
    },
    session,
  };

  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };

  try {
    requestAnimationFrame(() => {
      calls.push(['lineSync']);
      context.scrollSyncController.suspendSync(0);
    });

    commentsFeature.revealCommentAnchor.call(context, anchor);

    assert.deepEqual(calls, []);
    frames.shift()(0);
    frames.shift()(0);
    assert.deepEqual(calls, [
      ['lineSync'],
      ['suspendSync', 0],
      ['suspendSync', 800],
      ['revealDiagramElement', anchor],
    ]);
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test('closing a comment invalidates a queued diagram reveal', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const frames = [];
  const calls = [];
  const context = {
    previewRenderer: {
      clearPreviewReveal: () => calls.push(['clearPreviewReveal']),
      revealDiagramElement: () => calls.push(['revealDiagramElement']),
    },
    session: {
      clearCommentReveal: () => calls.push(['clearCommentReveal']),
    },
  };

  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };

  try {
    commentsFeature.revealCommentAnchor.call(context, {
      anchorKind: 'diagram-element',
      elementId: 'flowchart-user-db-0',
    });
    commentsFeature.revealCommentAnchor.call(context, null);
    frames.shift()(0);

    assert.deepEqual(calls, [
      ['clearCommentReveal'],
      ['clearPreviewReveal'],
    ]);
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});
