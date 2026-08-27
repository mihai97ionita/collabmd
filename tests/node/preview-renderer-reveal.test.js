import assert from 'node:assert/strict';
import test from 'node:test';

import { PreviewRenderer } from '../../src/client/application/preview-renderer.js';

function createRenderer({ shells, globalNode = null } = {}) {
  const previewElement = {
    querySelector(selector) {
      if (selector.includes('[data-mermaid-element-id')) {
        return globalNode;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.preview-comment-reveal') {
        return [];
      }
      return shells;
    },
  };
  const renderer = Object.create(PreviewRenderer.prototype);
  renderer.previewElement = previewElement;
  renderer.previewContainer = null;
  renderer.previewRevealGeneration = 0;
  renderer.previewRevealTimer = null;
  renderer.previewRevealCancel = null;
  return renderer;
}

function createShell(sourceLine, node = null, diagramKey = null) {
  return {
    classList: { add() {}, remove() {} },
    getAttribute(name) {
      if (name === 'data-source-line') return String(sourceLine);
      if (name === 'data-mermaid-key') return diagramKey;
      return null;
    },
    querySelector(selector) {
      return selector.includes('[data-mermaid-element-id') ? node : null;
    },
  };
}

function createNode(shell) {
  const classes = [];
  return {
    classList: {
      add(className) {
        classes.push(className);
      },
      remove() {},
    },
    closest() {
      return shell;
    },
    classes,
  };
}

test('revealDiagramElement scopes an anchored lookup to its source-line shell', () => {
  const wrongShell = createShell(42, null, 'mermaid-wrong');
  const targetShell = createShell(42, null, 'mermaid-target');
  const targetNode = createNode(targetShell);
  targetShell.querySelector = () => targetNode;
  const renderer = createRenderer({
    globalNode: createNode(wrongShell),
    shells: [wrongShell, targetShell],
  });

  assert.equal(renderer.revealDiagramElement({
    anchorKind: 'diagram-element',
    anchorStartLine: 42,
    diagramKey: 'mermaid-target',
    elementId: 'flowchart-user-db-0',
  }), true);
  assert.deepEqual(targetNode.classes, ['preview-comment-reveal']);
});

test('clearPreviewReveal cancels a pending diagram retry', async () => {
  const shell = createShell(42);
  const renderer = createRenderer({ shells: [shell] });
  const pendingReveal = renderer.revealDiagramElement({
    anchorKind: 'diagram-element',
    anchorStartLine: 42,
    elementId: 'missing',
  });

  renderer.clearPreviewReveal();

  assert.equal(await pendingReveal, false);
});