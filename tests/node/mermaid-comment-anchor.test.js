import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMermaidCommentAnchor,
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
    getAttribute: (name) => {
      if (name === 'id') {
        return id;
      }
      if (name === 'data-et') {
        return dataset.et ?? null;
      }
      if (name === 'data-id') {
        return dataset.id ?? null;
      }
      if (name === 'data-from') {
        return dataset.from ?? null;
      }
      if (name === 'data-to') {
        return dataset.to ?? null;
      }
      return null;
    },
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

test('classifyElementType maps PlantUML id prefixes to element types', () => {
  const component = makeFakeElement({ id: 'elem_DatabaseService', classList: [] });
  assert.equal(classifyElementType(component), 'node');
  const componentEnt = makeFakeElement({ id: 'ent0002', classList: [] });
  assert.equal(classifyElementType(componentEnt), 'node');
  const arrow = makeFakeElement({ id: 'link_ServiceA_DatabaseService', classList: ['link'] });
  assert.equal(classifyElementType(arrow), 'edge');
  const arrowLnk = makeFakeElement({ id: 'lnk4', classList: ['link'] });
  assert.equal(classifyElementType(arrowLnk), 'edge');
});

test('classifyElementType maps sequence diagram data-et attributes to element types', () => {
  const participant = makeFakeElement({ dataset: { et: 'participant' } });
  assert.equal(classifyElementType(participant), 'node');
  const lifeline = makeFakeElement({ dataset: { et: 'life-line' } });
  assert.equal(classifyElementType(lifeline), 'node');
  const message = makeFakeElement({ dataset: { et: 'message' } });
  assert.equal(classifyElementType(message), 'edge');
});

test('classifyElementType maps gantt element classes to element types', () => {
  const taskBar = makeFakeElement({ classList: ['bar'] });
  assert.equal(classifyElementType(taskBar), 'node');
  const taskText = makeFakeElement({ classList: ['taskText'] });
  assert.equal(classifyElementType(taskText), 'edge-label');
  const taskTextOutside = makeFakeElement({ classList: ['taskTextOutsideRight'] });
  assert.equal(classifyElementType(taskTextOutside), 'edge-label');
});

test('classifyElementType maps gitGraph element classes to element types', () => {
  const commit = makeFakeElement({ classList: ['commitPoint'] });
  assert.equal(classifyElementType(commit), 'node');
  const arrow = makeFakeElement({ classList: ['arrow'] });
  assert.equal(classifyElementType(arrow), 'edge');
  const branch = makeFakeElement({ classList: ['branch'] });
  assert.equal(classifyElementType(branch), 'edge');
});

test('classifyElementType maps block diagram element classes to element types', () => {
  const blockNode = makeFakeElement({ classList: ['blockNode'] });
  assert.equal(classifyElementType(blockNode), 'node');
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

test('buildMermaidCommentAnchor enriches the anchor with the shell source line', () => {
  globalThis.SVGSVGElement = class SVGSVGElement {};
  try {
    const svg = {
      createSVGPoint: () => ({ x: 0, y: 0, matrixTransform: () => ({ x: 10, y: 20 }) }),
      getScreenCTM: () => ({ inverse: () => ({}) }),
    };
    Object.setPrototypeOf(svg, globalThis.SVGSVGElement.prototype);
    const node = makeFakeElement({
      id: 'flowchart-A-0',
      classList: ['node'],
      textContent: 'Start',
    });
    node.ownerSVGElement = svg;
    node.getBBox = () => ({ x: 0, y: 0, width: 80, height: 40 });
    const shell = makeFakeElement({ classList: ['mermaid-shell'] });
    shell.getAttribute = (name) => {
      if (name === 'data-source-line') return '42';
      if (name === 'data-source-line-end') return '48';
      if (name === 'data-mermaid-key') return 'mermaid-source-0';
      return null;
    };
    node.closest = (selector) => {
      if (selector.includes('mermaid-shell')) return shell;
      if (selector.includes('node') || selector.includes('edgePath') || selector.includes('edgeLabel')) return node;
      return null;
    };

    const anchor = buildMermaidCommentAnchor({ target: node, clientX: 5, clientY: 5 });
    assert.equal(anchor.anchorKind, 'diagram-element');
    assert.equal(anchor.elementId, 'flowchart-A-0');
    assert.equal(anchor.anchorStartLine, 42);
    assert.equal(anchor.anchorEndLine, 48);
    assert.equal(anchor.diagramKey, 'mermaid-source-0');
  } finally {
    delete globalThis.SVGSVGElement;
  }
});

test('buildMermaidCommentAnchor sets anchorStartLine to null when the shell has no data-source-line', () => {
  globalThis.SVGSVGElement = class SVGSVGElement {};
  try {
    const svg = {
      createSVGPoint: () => ({ x: 0, y: 0, matrixTransform: () => ({ x: 10, y: 20 }) }),
      getScreenCTM: () => ({ inverse: () => ({}) }),
    };
    Object.setPrototypeOf(svg, globalThis.SVGSVGElement.prototype);
    const node = makeFakeElement({ id: 'A', classList: ['node'], textContent: 'Start' });
    node.ownerSVGElement = svg;
    node.getBBox = () => ({ x: 0, y: 0, width: 80, height: 40 });
    const shell = makeFakeElement({ classList: ['mermaid-shell'] });
    shell.getAttribute = () => null;
    node.closest = (selector) => {
      if (selector.includes('mermaid-shell')) return shell;
      if (selector.includes('node')) return node;
      return null;
    };

    const anchor = buildMermaidCommentAnchor({ target: node, clientX: 5, clientY: 5 });
    assert.equal(anchor.anchorStartLine, null);
    assert.equal(anchor.anchorEndLine, null);
  } finally {
    delete globalThis.SVGSVGElement;
  }
});
