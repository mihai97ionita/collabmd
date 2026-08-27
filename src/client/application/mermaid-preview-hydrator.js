import {
  createDiagramExportFileNames,
  renderMermaidExportSvgMarkup,
} from './diagram-preview-export.js';
import { DiagramPreviewHydrator } from './diagram-preview-hydrator.js';
import {
  createMermaidPlaceholderCardWithMessage,
  createDiagramErrorPlaceholderCard,
  MERMAID_BATCH_SIZE,
  normalizeDiagramError,
  normalizeMermaidSvg,
} from './preview-diagram-utils.js';

export class MermaidPreviewHydrator extends DiagramPreviewHydrator {
  constructor(renderer, { loadFileSource = null } = {}) {
    super(renderer, {
      batchSize: MERMAID_BATCH_SIZE,
      datasetKeys: {
        hydrated: 'mermaidHydrated',
        instanceId: 'mermaidInstanceId',
        key: 'mermaidKey',
        label: 'mermaidLabel',
        queued: 'mermaidQueued',
        sourceHash: 'mermaidSourceHash',
        sourceLine: 'sourceLine',
        sourceLineEnd: 'sourceLineEnd',
        target: 'mermaidTarget',
      },
      filePathLabel: 'Mermaid',
      loadFileSource,
      shellClassName: 'mermaid-shell',
      sourceClassName: 'mermaid-source',
    });
    this.currentTheme = document.documentElement?.dataset.theme === 'light' ? 'light' : 'dark';
    this.diagramChrome = renderer.diagramChrome;
    this.loader = null;
    this.runtime = null;
  }

  cancelHydration({ preserveActiveShell = false } = {}) {
    super.cancelHydration();
    if (!preserveActiveShell) {
      this.diagramChrome?.cancelActiveShell?.('mermaid');
    }
  }

  applyTheme(theme) {
    this.currentTheme = theme;
    const mermaid = this.runtime;
    if (!mermaid) {
      return;
    }

    this.configureMermaid(mermaid);
    this.resetHydratedShells();
  }

  configureMermaid(mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      htmlLabels: false,
      flowchart: {
        defaultRenderer: 'dagre-wrapper',
        htmlLabels: false,
        useMaxWidth: true,
      },
      class: {
        defaultRenderer: 'dagre-wrapper',
        useMaxWidth: true,
      },
      theme: this.currentTheme === 'dark' ? 'dark' : 'default',
      themeVariables: this.currentTheme === 'dark' ? {
        background: '#11161d',
        clusterBkg: '#141a22',
        edgeLabelBackground: '#11161d',
        lineColor: '#9aa7b4',
        mainBkg: '#171d26',
        nodeBorder: '#303c4b',
        primaryBorderColor: '#60a5fa',
        primaryColor: '#172a45',
        primaryTextColor: '#e6edf3',
        secondaryColor: '#1c2530',
        tertiaryColor: '#11161d',
        titleColor: '#e6edf3',
      } : {},
    });
  }

  ensureMermaid() {
    if (this.runtime) {
      this.configureMermaid(this.runtime);
      return Promise.resolve(this.runtime);
    }

    if (this.loader) {
      return this.loader;
    }

    this.loader = import('mermaid')
      .then((module) => {
        const mermaid = module?.default;
        if (!mermaid) {
          throw new Error('Mermaid runtime failed to initialize');
        }

        this.runtime = mermaid;
        this.configureMermaid(mermaid);
        return mermaid;
      })
      .catch((error) => {
        this.loader = null;
        this.runtime = null;
        throw new Error(error instanceof Error ? error.message : 'Failed to load Mermaid runtime');
      });

    return this.loader;
  }

  handleReconcile({ restoredMaximizedShell }) {
    if (restoredMaximizedShell) {
      document.body.classList.add('mermaid-maximized-open');
    }
    this.diagramChrome?.syncActiveShell?.();
  }

  async prepareHydrationBatch() {
    return this.ensureMermaid();
  }

  handlePrepareHydrationBatchError(_shells, error) {
    console.warn('[preview] Mermaid runtime failed to load:', error);
  }

  createRenderHost() {
    const renderHost = document.createElement('div');
    renderHost.style.position = 'fixed';
    renderHost.style.left = '-10000px';
    renderHost.style.top = '0';
    renderHost.style.width = '1200px';
    renderHost.style.visibility = 'hidden';
    renderHost.style.pointerEvents = 'none';
    document.body.appendChild(renderHost);
    return renderHost;
  }

  async hydrateShell(shell, mermaid, { hydrationToken, renderVersion } = {}) {
    if (!mermaid || !shell?.isConnected || this.isShellHydrated(shell)) {
      return;
    }

    if (!this.isHydrationCurrent(renderVersion, shell, hydrationToken)) {
      return;
    }

    let sourceNode = shell.querySelector('.mermaid-source');
    if (!sourceNode) {
      sourceNode = document.createElement('span');
      sourceNode.className = 'mermaid-source';
      sourceNode.hidden = true;
      shell.appendChild(sourceNode);
    }

    let source = sourceNode.textContent ?? '';
    try {
      if (!source.trim() && shell.dataset.mermaidTarget) {
        source = await this.fetchSource(shell.dataset.mermaidTarget);
        if (!shell.isConnected) {
          return;
        }
        sourceNode.textContent = source;
      }

      if (!source.trim()) {
        throw new Error(shell.dataset.mermaidTarget ? 'Mermaid file is empty' : 'Mermaid source is empty');
      }

      if (!this.isHydrationCurrent(renderVersion, shell, hydrationToken)) {
        return;
      }

      const renderedSource = source;
      source = this.prepareSource(source);

      shell.querySelector('.mermaid-placeholder-card')?.remove();

      const diagram = document.createElement('div');
      diagram.className = 'mermaid mermaid-render-node';
      diagram.id = shell.dataset.mermaidKey || `mermaid-${Date.now()}`;
      const sourceLine = shell.getAttribute('data-source-line');
      const sourceLineEnd = shell.getAttribute('data-source-line-end');
      if (sourceLine) {
        diagram.setAttribute('data-source-line', sourceLine);
      }
      if (sourceLineEnd) {
        diagram.setAttribute('data-source-line-end', sourceLineEnd);
      }
      diagram.textContent = source;

      const renderHost = this.createRenderHost();
      try {
        renderHost.appendChild(diagram);
        await mermaid.run({ nodes: [diagram] });
        if (
          !this.isHydrationCurrent(renderVersion, shell, hydrationToken)
          || !diagram.isConnected
          || diagram.parentElement !== renderHost
        ) {
          return;
        }

        this.enhanceDiagram(shell, diagram, renderedSource);
        this.markShellHydrated(shell);
      } finally {
        renderHost.remove();
      }
    } catch (error) {
      console.warn('[preview] Mermaid render failed:', error);
      if (!this.isHydrationCurrent(renderVersion, shell, hydrationToken)) {
        return;
      }

      if (this.markShellError(shell, error)) {
        return;
      }

      this.diagramChrome?.destroyShell?.(shell);
      shell.querySelector(':scope > .mermaid-toolbar')?.remove();
      shell.querySelector(':scope > .mermaid-frame')?.remove();
      shell.querySelector(':scope > .mermaid-render-node')?.remove();
      if (!shell.querySelector('.mermaid-placeholder-card')) {
        const key = shell.dataset.mermaidKey || 'mermaid';
        const message = normalizeDiagramError(error);
        sourceNode?.after(createDiagramErrorPlaceholderCard({
          key,
          kind: 'mermaid',
          label: shell.dataset.mermaidLabel || 'Mermaid diagram',
          message,
        }));
      }
    }
  }

  prepareSource(source) {
    let text = String(source ?? '');

    if (!/%%\{[\s\S]*?\binit\s*:/m.test(text)) {
      const initConfig = this.getPreviewInitConfig(text);
      if (initConfig) {
        text = `%%{init: ${JSON.stringify(initConfig)}}%%\n${text}`;
      }
    }

    if (!/^\s*gantt\b/m.test(text) || /\btodayMarker\b/.test(text)) {
      return text;
    }

    const lines = text.split('\n');
    const ganttLineIndex = lines.findIndex((line) => /^\s*gantt\b/.test(line));
    if (ganttLineIndex === -1) {
      return text;
    }

    lines.splice(ganttLineIndex + 1, 0, '    todayMarker off');
    return lines.join('\n');
  }

  getPreviewInitConfig(source) {
    if (/^\s*stateDiagram(?:-v2)?\b/m.test(source)) {
      return {
        htmlLabels: false,
      };
    }

    if (/^\s*classDiagram\b/m.test(source)) {
      return {
        htmlLabels: false,
      };
    }

    if (/^\s*gantt\b/m.test(source)) {
      return {
        htmlLabels: false,
      };
    }

    return null;
  }

  resetHydratedShells() {
    const previewElement = this.renderer.previewElement;
    if (!previewElement) {
      return;
    }

    const hydratedShells = Array.from(previewElement.querySelectorAll('.mermaid-shell[data-mermaid-hydrated="true"]'));
    const activeShell = this.diagramChrome?.syncActiveShell?.();
    if (activeShell?.classList?.contains('mermaid-shell') && !hydratedShells.includes(activeShell)) {
      hydratedShells.push(activeShell);
    }
    if (hydratedShells.length === 0) {
      return;
    }

    hydratedShells.forEach((shell) => {
      this.diagramChrome?.destroyShell?.(shell);
      this.clearShellOutput(shell);
      shell.querySelector(':scope > .mermaid-toolbar')?.remove();
      shell.querySelector(':scope > .mermaid-frame')?.remove();
      shell.querySelector(':scope > .mermaid-render-node')?.remove();
      if (!shell.querySelector('.mermaid-placeholder-card')) {
        shell.querySelector('.mermaid-source')?.after(createMermaidPlaceholderCardWithMessage(shell.dataset.mermaidKey || 'mermaid'));
      }
      this.enqueueShell(shell, { prioritize: true });
    });
  }

  async renderExportSvgMarkup(shell) {
    const mermaid = await this.ensureMermaid();
    try {
      const source = shell._diagramRenderedSource
        ?? shell.querySelector('.mermaid-source')?.textContent
        ?? '';
      return await renderMermaidExportSvgMarkup(mermaid, source);
    } finally {
      this.configureMermaid(mermaid);
    }
  }

  enhanceDiagram(shell, renderedDiagram, renderedSource = '') {
    const svg = renderedDiagram.querySelector('svg');
    if (!svg) {
      renderedDiagram.remove();
      return;
    }
    this.tagDiagramElements(svg);
    const { width: baseWidth, height: baseHeight } = normalizeMermaidSvg(svg);

    const exportFileNames = () => createDiagramExportFileNames({
      currentFilePath: this.renderer.getSourceFilePath?.() ?? '',
      diagramKind: 'mermaid',
      sourceLine: shell.getAttribute('data-source-line') || '',
      targetPath: shell.dataset.mermaidTarget || '',
    });
    renderedDiagram.remove();
    this.diagramChrome.mount(shell, {
      baseHeight,
      baseWidth,
      diagramElement: svg,
      exportFileNames,
      exportSvgMarkup: () => this.renderExportSvgMarkup(shell),
      kind: 'mermaid',
      sourceSelector: '.mermaid-source',
    });
    shell._diagramRenderedSource = renderedSource;
  }

  tagDiagramElements(svg) {
    const flowchartNodes = svg.querySelectorAll('g.node, g.edgePath, g.edgeLabel');
    flowchartNodes.forEach((node) => {
      const rawId = node.getAttribute('id') || '';
      const text = node.querySelector('text, foreignObject > div, g.label');
      const labelText = (text?.textContent ?? '').trim();
      const tagValue = rawId || labelText || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const sequenceParticipants = svg.querySelectorAll('g[data-et="participant"]');
    sequenceParticipants.forEach((node) => {
      const dataId = node.getAttribute('data-id') || '';
      const text = node.querySelector('text');
      const labelText = (text?.textContent ?? '').trim();
      const tagValue = dataId || labelText || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const sequenceLifelines = svg.querySelectorAll('line[data-et="life-line"]');
    sequenceLifelines.forEach((node) => {
      const dataId = node.getAttribute('data-id') || '';
      const rawId = node.getAttribute('id') || '';
      const tagValue = dataId || rawId || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const sequenceMessages = svg.querySelectorAll(
      'line[data-et="message"], path[data-et="message"]',
    );
    sequenceMessages.forEach((node) => {
      const dataId = node.getAttribute('data-id') || '';
      const dataFrom = node.getAttribute('data-from') || '';
      const dataTo = node.getAttribute('data-to') || '';
      const tagValue = dataId || `${dataFrom}-to-${dataTo}` || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const sequenceMessageTexts = svg.querySelectorAll('text.messageText');
    sequenceMessageTexts.forEach((node) => {
      const text = (node.textContent ?? '').trim();
      const tagValue = text || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const sequenceActivations = svg.querySelectorAll('rect[class*="activation"]');
    sequenceActivations.forEach((node) => {
      const parentG = node.closest('g[data-et="participant"], g[data-et="life-line"]');
      const parentId = parentG?.getAttribute('data-id') || parentG?.getAttribute('id') || '';
      const tagValue = parentId || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const ganttTasks = svg.querySelectorAll('rect.bar');
    ganttTasks.forEach((node) => {
      const rawId = node.getAttribute('id') || '';
      const tagValue = rawId || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const ganttTaskTexts = svg.querySelectorAll('text.taskText, text.taskTextOutsideRight, text.taskTextOutsideLeft');
    ganttTaskTexts.forEach((node) => {
      const text = (node.textContent ?? '').trim();
      const tagValue = text || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const gitCommits = svg.querySelectorAll('circle.commitPoint');
    gitCommits.forEach((node) => {
      const rawId = node.getAttribute('id') || '';
      const title = node.querySelector('title')?.textContent?.trim() ?? '';
      const tagValue = rawId || title || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const gitArrows = svg.querySelectorAll('path.arrow');
    gitArrows.forEach((node) => {
      const rawId = node.getAttribute('id') || '';
      const title = node.querySelector('title')?.textContent?.trim() ?? '';
      const tagValue = rawId || title || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const gitBranches = svg.querySelectorAll('line.branch');
    gitBranches.forEach((node) => {
      const rawId = node.getAttribute('id') || '';
      const title = node.querySelector('title')?.textContent?.trim() ?? '';
      const tagValue = rawId || title || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });

    const blockNodes = svg.querySelectorAll('g.blockNode');
    blockNodes.forEach((node) => {
      const rawId = node.getAttribute('id') || '';
      const text = node.querySelector('text');
      const labelText = (text?.textContent ?? '').trim();
      const tagValue = rawId || labelText || '';
      if (tagValue) {
        node.setAttribute('data-mermaid-element-id', tagValue);
      }
    });
  }

}
