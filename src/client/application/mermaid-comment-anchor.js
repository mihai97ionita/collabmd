const MERMAID_NODE_SELECTOR = 'g.node, g.edgePath, g.edgeLabel';
const ARCHITECTURE_BETA_SELECTOR = 'g.architecture-service, g.architecture-group, g.architecture-edges > path.edge';
const DIAGRAM_ELEMENT_SELECTOR = `${MERMAID_NODE_SELECTOR}, ${ARCHITECTURE_BETA_SELECTOR}, [data-mermaid-element-id]`;

function findMermaidAncestor(element) {
  return element?.closest?.('.mermaid-render-node, .mermaid, .plantuml-shell') ?? null;
}

function findDiagramSvg(scopeElement) {
  if (!scopeElement) {
    return null;
  }
  const svg = scopeElement.querySelector('svg');
  if (svg instanceof SVGSVGElement) {
    return svg;
  }
  const nested = scopeElement.querySelector(
    '.mermaid-frame svg, .plantuml-frame svg, .diagram-preview-frame svg',
  );
  if (nested instanceof SVGSVGElement) {
    return nested;
  }
  return null;
}

function findMermaidElementTarget(element) {
  return element?.closest?.(DIAGRAM_ELEMENT_SELECTOR) ?? null;
}

function getSvgUserSpaceRect(svg, clientX, clientY) {
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const ctm = svg.getScreenCTM?.();
  if (!ctm) {
    return null;
  }
  return point.matrixTransform(ctm.inverse());
}

function getElementBBoxInSvgUserSpace(target, _svg) {
  try {
    const bbox = target.getBBox?.();
    if (!bbox || !Number.isFinite(bbox.x) || !Number.isFinite(bbox.y)) {
      return null;
    }
    if (bbox.width === 0 && bbox.height === 0) {
      return null;
    }
    return { height: bbox.height, width: bbox.width, x: bbox.x, y: bbox.y };
  } catch {
    return null;
  }
}

function stripMermaidIdPrefix(id) {
  const trimmed = id.trim();
  const match = trimmed.match(/-(?:service|group)-(.+)$/);
  if (match) {
    return match[1] || null;
  }
  const edgeMatch = trimmed.match(/-L_(.+)$/);
  if (edgeMatch && edgeMatch[1]) {
    return `L_${edgeMatch[1]}`;
  }
  const stripped = trimmed.replace(/^mermaid-\d+-/, '');
  return stripped || null;
}

function readElementId(target) {
  const dataId = target.getAttribute('data-mermaid-element-id');
  if (dataId && dataId.trim()) {
    return dataId.trim();
  }
  const id = target.getAttribute('id');
  if (!id) {
    return null;
  }
  return stripMermaidIdPrefix(id);
}

function readElementText(target) {
  const label = target.querySelector('foreignObject > div, g.label, text');
  if (label) {
    const text = label.textContent ?? '';
    return text.trim();
  }
  const textEl = target.querySelector('text');
  return textEl?.textContent?.trim?.() ?? '';
}

function classifyElementType(target) {
  if (target.classList.contains('edgePath')) {
    return 'edge';
  }
  if (target.classList.contains('edgeLabel')) {
    return 'edge-label';
  }
  const dataEt = target.getAttribute('data-et') || '';
  if (dataEt === 'message') {
    return 'edge';
  }
  if (dataEt === 'life-line' || dataEt === 'participant') {
    return 'node';
  }
  if (target.classList.contains('bar')) {
    return 'node';
  }
  if (target.classList.contains('taskText') || target.classList.contains('taskTextOutsideRight') || target.classList.contains('taskTextOutsideLeft')) {
    return 'edge-label';
  }
  if (target.classList.contains('commitPoint')) {
    return 'node';
  }
  if (target.classList.contains('arrow')) {
    return 'edge';
  }
  if (target.classList.contains('branch')) {
    return 'edge';
  }
  if (target.classList.contains('blockNode')) {
    return 'node';
  }
  if (target.classList.contains('architecture-service') || target.classList.contains('architecture-group')) {
    return 'node';
  }
  if (target.classList.contains('edge') && target.tagName?.toLowerCase() === 'path') {
    return 'edge';
  }
  const id = target.getAttribute('id') || '';
  if (id.startsWith('link_') || target.classList.contains('link')) {
    return 'edge';
  }
  if (id.startsWith('elem_') || id.startsWith('ent')) {
    return 'node';
  }
  return 'node';
}

export function buildMermaidCommentAnchor({ target, clientX, clientY }) {
  const mermaidTarget = findMermaidElementTarget(target);
  if (!mermaidTarget) {
    return null;
  }
  const svg = mermaidTarget.ownerSVGElement
    ?? findDiagramSvg(findMermaidAncestor(mermaidTarget));
  if (!(svg instanceof SVGSVGElement)) {
    return null;
  }

  const elementId = readElementId(mermaidTarget);
  if (!elementId) {
    return null;
  }

  const point = getSvgUserSpaceRect(svg, clientX, clientY);
  const snapshot = getElementBBoxInSvgUserSpace(mermaidTarget, svg);
  if (!point || !snapshot) {
    return null;
  }

  const text = readElementText(mermaidTarget);
  const shell = mermaidTarget.closest('.mermaid-shell, .plantuml-shell');
  const anchorStartLine = asPositiveInt(shell?.getAttribute('data-source-line'));
  const anchorEndLine = asPositiveInt(shell?.getAttribute('data-source-line-end'));
  const diagramKey = shell?.getAttribute('data-mermaid-key')
    || shell?.getAttribute('data-plantuml-key')
    || null;
  return {
    anchorKind: 'diagram-element',
    anchorEndLine,
    anchorPoint: { x: point.x, y: point.y },
    anchorQuote: text || elementId,
    anchorSnapshot: {
      height: snapshot.height,
      text: text || elementId,
      type: classifyElementType(mermaidTarget),
      width: snapshot.width,
      x: snapshot.x,
      y: snapshot.y,
    },
    diagramKey,
    anchorStartLine,
    elementId,
  };
}

function asPositiveInt(value) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export {
  classifyElementType,
  findDiagramShell,
  findDiagramSvg,
  isCommentModeActive,
  readElementId,
  readElementText,
  stripMermaidIdPrefix,
  MERMAID_NODE_SELECTOR,
};

const LONG_PRESS_DURATION_MS = 500;
const LONG_PRESS_MOVEMENT_THRESHOLD_PX = 8;

function findDiagramShell(element) {
  return element?.closest?.('.mermaid-shell, .plantuml-shell') ?? null;
}

function isCommentModeActive(shell) {
  return shell?.dataset?.diagramCommentMode === 'true';
}

function emitAnchor(detector, event) {
  const anchor = buildMermaidCommentAnchor({
    target: event.target,
    clientX: event.clientX,
    clientY: event.clientY,
  });
  if (!anchor) {
    return false;
  }
  event.stopPropagation();
  event.preventDefault();
  detector.onAnchor(anchor);
  return true;
}

export class MermaidCommentAnchorDetector {
  constructor({ previewElement, onAnchor }) {
    this.previewElement = previewElement;
    this.onAnchor = onAnchor;
    this.longPressTimer = null;
    this.longPressStart = null;

    this.handleClick = (event) => {
      const shell = findDiagramShell(event.target);
      if (!isCommentModeActive(shell)) {
        return;
      }
      emitAnchor(this, event);
    };

    this.handleTouchStart = (event) => {
      if (event.touches.length !== 1) {
        this.clearLongPressTimer();
        return;
      }
      const shell = findDiagramShell(event.target);
      if (!isCommentModeActive(shell)) {
        return;
      }
      const touch = event.touches[0];
      this.longPressStart = { x: touch.clientX, y: touch.clientY };
      this.clearLongPressTimer();
      this.longPressTimer = setTimeout(() => {
        this.longPressTimer = null;
        const syntheticEvent = {
          target: document.elementFromPoint(touch.clientX, touch.clientY),
          clientX: touch.clientX,
          clientY: touch.clientY,
          type: 'click',
          preventDefault: () => {},
          stopPropagation: () => {},
        };
        emitAnchor(this, syntheticEvent);
      }, LONG_PRESS_DURATION_MS);
    };

    this.handleTouchMove = (event) => {
      if (!this.longPressStart || event.touches.length !== 1) {
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - this.longPressStart.x;
      const deltaY = touch.clientY - this.longPressStart.y;
      if (Math.abs(deltaX) > LONG_PRESS_MOVEMENT_THRESHOLD_PX
        || Math.abs(deltaY) > LONG_PRESS_MOVEMENT_THRESHOLD_PX) {
        this.clearLongPressTimer();
      }
    };

    this.handleTouchEnd = () => {
      this.clearLongPressTimer();
    };
  }

  clearLongPressTimer() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressStart = null;
  }

  attach() {
    this.previewElement?.addEventListener('click', this.handleClick);
    this.previewElement?.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    this.previewElement?.addEventListener('touchmove', this.handleTouchMove, { passive: true });
    this.previewElement?.addEventListener('touchend', this.handleTouchEnd, { passive: true });
    this.previewElement?.addEventListener('touchcancel', this.handleTouchEnd, { passive: true });
  }

  detach() {
    this.previewElement?.removeEventListener('click', this.handleClick);
    this.previewElement?.removeEventListener('touchstart', this.handleTouchStart);
    this.previewElement?.removeEventListener('touchmove', this.handleTouchMove);
    this.previewElement?.removeEventListener('touchend', this.handleTouchEnd);
    this.previewElement?.removeEventListener('touchcancel', this.handleTouchEnd);
    this.clearLongPressTimer();
  }
}
