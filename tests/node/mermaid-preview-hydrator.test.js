import test from 'node:test';
import assert from 'node:assert/strict';

import { MermaidPreviewHydrator } from '../../src/client/application/mermaid-preview-hydrator.js';

test('MermaidPreviewHydrator loads embedded Mermaid file sources through the injected loader', async (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    body: {
      classList: {
        add() {},
        remove() {},
      },
      querySelector() {
        return null;
      },
    },
    documentElement: {
      dataset: {},
    },
  };
  t.after(() => {
    globalThis.document = originalDocument;
  });

  const loaderCalls = [];
  const hydrator = new MermaidPreviewHydrator({
    previewElement: null,
  }, {
    loadFileSource: async (filePath) => {
      loaderCalls.push(filePath);
      return 'graph TD\nA-->B';
    },
  });

  const [first, second] = await Promise.all([
    hydrator.fetchSource('docs/flow.mmd'),
    hydrator.fetchSource('docs/flow.mmd'),
  ]);

  assert.equal(first, 'graph TD\nA-->B');
  assert.equal(second, first);
  assert.deepEqual(loaderCalls, ['docs/flow.mmd']);
});

test('MermaidPreviewHydrator configures embedded renders with SVG text labels', (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    body: {
      classList: {
        add() {},
        remove() {},
      },
      querySelector() {
        return null;
      },
    },
    documentElement: {
      dataset: {},
    },
  };
  t.after(() => {
    globalThis.document = originalDocument;
  });

  let initializedConfig = null;
  const hydrator = new MermaidPreviewHydrator({
    previewElement: null,
  });
  hydrator.configureMermaid({
    initialize(config) {
      initializedConfig = config;
    },
  });

  assert.equal(initializedConfig.htmlLabels, false);
  assert.equal(initializedConfig.flowchart.htmlLabels, false);
});


test('tagDiagramElements tags architecture-beta service nodes with the stripped service name', () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    documentElement: { dataset: {} },
  };
  try {
    function makeNode({ id, classList = [], textContent = '' }) {
      const attrs = new Map();
      if (id) attrs.set('id', id);
      return {
        classList: { contains: (name) => classList.includes(name) },
        getAttribute: (name) => attrs.get(name) ?? null,
        setAttribute: (name, value) => attrs.set(name, String(value)),
        querySelector: () => textContent ? { textContent } : null,
        textContent,
      };
    }

    const browser = makeNode({ id: 'mermaid-1787845235777-service-browser', classList: ['architecture-service'], textContent: 'Browser UI' });
    const server = makeNode({ id: 'mermaid-1787845235777-service-server', classList: ['architecture-service'], textContent: 'HTTP + WS Server' });
    const group = makeNode({ id: 'mermaid-1787845235777-group-collabmd', classList: ['architecture-group'], textContent: 'CollabMD' });
    const edge = makeNode({ id: 'mermaid-1787845235777-L_browser_server_0', classList: ['edge'] });

    const svg = {
      querySelectorAll: (selector) => {
        if (selector.includes('g.node') || selector.includes('g.edgePath') || selector.includes('g.edgeLabel')) return [];
        if (selector.includes('data-et') || selector.includes('text.') || selector.includes('rect.') || selector.includes('circle.') || selector.includes('path.arrow') || selector.includes('line.') || selector.includes('g.blockNode')) return [];
        if (selector.includes('g.architecture-service') || selector.includes('g.architecture-group')) return [browser, server, group];
        if (selector.includes('path.edge')) return [edge];
        return [];
      },
    };

    const hydrator = new MermaidPreviewHydrator({ previewElement: null });
    hydrator.tagDiagramElements(svg);

    assert.equal(browser.getAttribute('data-mermaid-element-id'), 'browser');
    assert.equal(server.getAttribute('data-mermaid-element-id'), 'server');
    assert.equal(group.getAttribute('data-mermaid-element-id'), 'collabmd');
    assert.equal(edge.getAttribute('data-mermaid-element-id'), 'L_browser_server_0');
  } finally {
    globalThis.document = originalDocument;
  }
});
