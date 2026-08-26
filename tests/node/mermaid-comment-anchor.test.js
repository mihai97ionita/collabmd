import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyElementType,
  findDiagramShell,
  isCommentModeActive,
  readElementId,
  readElementText,
} from '../../src/client/application/mermaid-comment-anchor.js';

function makeFakeElement({ id, classList = [], textContent = '', dataset = {} } = {}) {
  const el = {
    classList: {
      contains: (name) => classList.includes(name),
    },
    closest: (selector) => {
      const classes = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
      for (const cls of classes) {
        if (classList.includes(cls)) {
          return el;
        }
      }
      return null;
    },
    getAttribute: (name) => (name === 'id' ? id : null),
    querySelector: () => null,
    textContent,
    dataset,
  };
  return el;
}

test('readElementId returns the trimmed id attribute', () => {
  assert.equal(readElementId(makeFakeElement({ id: 'A' })), 'A');
  assert.equal(readElementId(makeFakeElement({ id: '  B  ' })), 'B');
  assert.equal(readElementId(makeFakeElement({ id: '' })), null);
  assert.equal(readElementId(makeFakeElement({ id: null })), null);
});

test('classifyElementType maps class names to element types', () => {
  assert.equal(classifyElementType(makeFakeElement({ classList: ['edgePath'] })), 'edge');
  assert.equal(classifyElementType(makeFakeElement({ classList: ['edgeLabel'] })), 'edge-label');
  assert.equal(classifyElementType(makeFakeElement({ classList: ['node'] })), 'node');
  assert.equal(classifyElementType(makeFakeElement({ classList: [] })), 'node');
});

test('readElementText falls back to empty string when no text element is found', () => {
  assert.equal(readElementText(makeFakeElement({ textContent: '' })), '');
});

test('findDiagramShell returns the enclosing mermaid/plantuml shell', () => {
  const shell = makeFakeElement({ classList: ['mermaid-shell'] });
  assert.equal(findDiagramShell(shell), shell);
  const node = makeFakeElement({ classList: ['node'] });
  assert.equal(findDiagramShell(node), null);
});

test('isCommentModeActive reads the data-diagram-comment-mode attribute', () => {
  const active = makeFakeElement({ classList: ['mermaid-shell'], dataset: { diagramCommentMode: 'true' } });
  assert.equal(isCommentModeActive(active), true);
  const inactive = makeFakeElement({ classList: ['mermaid-shell'], dataset: { diagramCommentMode: 'false' } });
  assert.equal(isCommentModeActive(inactive), false);
  assert.equal(isCommentModeActive(null), false);
});
