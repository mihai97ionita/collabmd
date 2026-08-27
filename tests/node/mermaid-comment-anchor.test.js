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

function makeFakeElement({ id, classList = [], textContent = '', dataset = {}, tagName = 'g' } = {}) {
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
      // Also match bare element selectors like `g.architecture-service` and
      // descendant combinators used by the architecture-beta selector.
      if (selector.includes('g.architecture-service') && classList.includes('architecture-service')) {
        return el;
      }
      if (selector.includes('g.architecture-group') && classList.includes('architecture-group')) {
        return el;
      }
      if (selector.includes('path.edge') && classList.includes('edge') && tagName.toLowerCase() === 'path') {
        return el;
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
    tagName,
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

test('classifyElementType maps architecture-beta element classes to element types', () => {
  const service = makeFakeElement({ classList: ['architecture-service'] });
  assert.equal(classifyElementType(service), 'node');
  const group = makeFakeElement({ classList: ['architecture-group'] });
  assert.equal(classifyElementType(group), 'node');
  const edge = makeFakeElement({ classList: ['edge'], tagName: 'path' });
  assert.equal(classifyElementType(edge), 'edge');
});

test('readElementId extracts the service name from an architecture-beta id', () => {
  assert.equal(
    readElementId(makeFakeElement({ id: 'mermaid-1787845235777-service-server' })),
    'server',
  );
  assert.equal(
    readElementId(makeFakeElement({ id: 'mermaid-1787845235777-group-collabmd' })),
    'collabmd',
  );
});

test('readElementId extracts the edge identifier from an architecture-beta edge id', () => {
  assert.equal(
    readElementId(makeFakeElement({ id: 'mermaid-1787845235777-L_browser_server_0', classList: ['edge'], tagName: 'path' })),
    'L_browser_server_0',
  );
});

test('readElementId still strips the mermaid numeric prefix for standard nodes', () => {
  assert.equal(readElementId(makeFakeElement({ id: 'mermaid-12-flowchart-A-0' })), 'flowchart-A-0');
  assert.equal(readElementId(makeFakeElement({ id: 'A' })), 'A');
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


test('buildMermaidCommentAnchor anchors an architecture-beta service node', () => {
  globalThis.SVGSVGElement = class SVGSVGElement {};
  try {
    const svg = {
      createSVGPoint: () => ({ x: 0, y: 0, matrixTransform: () => ({ x: 16, y: 123 }) }),
      getScreenCTM: () => ({ inverse: () => ({}) }),
    };
    Object.setPrototypeOf(svg, globalThis.SVGSVGElement.prototype);
    const service = makeFakeElement({
      id: 'mermaid-1787845235777-service-server',
      classList: ['architecture-service'],
      textContent: 'HTTP + WS Server',
    });
    service.ownerSVGElement = svg;
    service.getBBox = () => ({ x: 16, y: 123, width: 80, height: 121 });
    service.querySelector = (selector) => {
      if (selector.includes('text')) {
        return { textContent: 'HTTP + WS Server' };
      }
      return null;
    };
    const shell = makeFakeElement({ classList: ['mermaid-shell'] });
    shell.getAttribute = (name) => {
      if (name === 'data-source-line') return '420';
      if (name === 'data-source-line-end') return '440';
      if (name === 'data-mermaid-key') return 'mermaid-12dudk7-0';
      return null;
    };
    service.closest = (selector) => {
      if (selector.includes('mermaid-shell')) return shell;
      if (selector.includes('architecture-service')) return service;
      return null;
    };

    const anchor = buildMermaidCommentAnchor({ target: service, clientX: 20, clientY: 130 });
    assert.equal(anchor.anchorKind, 'diagram-element');
    assert.equal(anchor.elementId, 'server');
    assert.equal(anchor.anchorQuote, 'HTTP + WS Server');
    assert.equal(anchor.anchorSnapshot.type, 'node');
    assert.equal(anchor.diagramKey, 'mermaid-12dudk7-0');
    assert.equal(anchor.anchorStartLine, 420);
  } finally {
    delete globalThis.SVGSVGElement;
  }
});

test('buildMermaidCommentAnchor anchors an architecture-beta edge path', () => {
  globalThis.SVGSVGElement = class SVGSVGElement {};
  try {
    const svg = {
      createSVGPoint: () => ({ x: 0, y: 0, matrixTransform: () => ({ x: 5, y: 5 }) }),
      getScreenCTM: () => ({ inverse: () => ({}) }),
    };
    Object.setPrototypeOf(svg, globalThis.SVGSVGElement.prototype);
    const edge = makeFakeElement({
      id: 'mermaid-1787845235777-L_browser_server_0',
      classList: ['edge'],
      tagName: 'path',
      textContent: '',
    });
    edge.ownerSVGElement = svg;
    edge.getBBox = () => ({ x: 0, y: 0, width: 100, height: 10 });
    const shell = makeFakeElement({ classList: ['mermaid-shell'] });
    shell.getAttribute = () => null;
    edge.closest = (selector) => {
      if (selector.includes('mermaid-shell')) return shell;
      if (selector.includes('path.edge')) return edge;
      return null;
    };

    const anchor = buildMermaidCommentAnchor({ target: edge, clientX: 5, clientY: 5 });
    assert.equal(anchor.anchorKind, 'diagram-element');
    assert.equal(anchor.elementId, 'L_browser_server_0');
    assert.equal(anchor.anchorSnapshot.type, 'edge');
  } finally {
    delete globalThis.SVGSVGElement;
  }
});
