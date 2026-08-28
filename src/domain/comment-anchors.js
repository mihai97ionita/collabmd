import { normalizeCommentQuoteForComparison } from './comment-threads.js';

export const ANCHOR_STATUS = Object.freeze({
  AMBIGUOUS: 'ambiguous',
  DEFERRED: 'deferred',
  MISSING: 'missing',
  RESOLVED: 'resolved',
  UNSUPPORTED: 'unsupported',
});

export const ANCHOR_PROVIDER = Object.freeze({
  EXCALIDRAW: 'excalidraw',
  MERMAID: 'mermaid',
  PLANTUML: 'plantuml',
  TEXT: 'text',
});

// Below this length a quote is too weak to relocate deterministically; a short
// phrase could match an unrelated line and put the comment on a plausible but
// wrong location.
export const MIN_REANCHOR_QUOTE_LENGTH = 10;

function normalizeAnchorKindValue(value) {
  return typeof value === 'string' ? value : '';
}

// Determines which reconciliation strategy applies to a thread. Derived from
// the persisted record shape, not a stored field, so existing sidecars need no
// migration. Excalidraw records are diagram-element anchors with no diagramKey.
export function detectAnchorProvider(anchor = {}) {
  const kind = normalizeAnchorKindValue(anchor.anchorKind ?? anchor.kind);
  if (kind === 'line' || kind === 'text') {
    return ANCHOR_PROVIDER.TEXT;
  }

  if (kind === 'diagram-element') {
    if (!anchor.diagramKey) {
      return ANCHOR_PROVIDER.EXCALIDRAW;
    }
    if (typeof anchor.diagramKey === 'string' && anchor.diagramKey.startsWith('plantuml')) {
      return ANCHOR_PROVIDER.PLANTUML;
    }
    return ANCHOR_PROVIDER.MERMAID;
  }

  return null;
}

function findUniqueLineMatch(documentText, quote) {
  const normalizedQuote = normalizeCommentQuoteForComparison(quote);
  if (!documentText || !normalizedQuote) {
    return { matchCount: 0, startLine: null, endLine: null };
  }

  // Preserve original line structure; normalize each line only for comparison.
  const originalLines = String(documentText).split('\n');
  const matchedStartLines = new Set();
  const matchedEndLines = new Set();

  originalLines.forEach((line, index) => {
    if (normalizeCommentQuoteForComparison(line).includes(normalizedQuote)) {
      matchedStartLines.add(index + 1);
      matchedEndLines.add(index + 1);
    }
  });

  // A text anchor can span multiple lines; if no single line matched, try a
  // whole-document normalized match and derive the line range from char offset.
  if (matchedStartLines.size === 0) {
    const normalizedDoc = normalizeCommentQuoteForComparison(documentText);
    const charIndex = normalizedDoc.indexOf(normalizedQuote);
    if (charIndex >= 0) {
      const startLine = normalizedDoc.slice(0, charIndex).split('\n').length;
      const endLine = normalizedDoc
        .slice(0, charIndex + normalizedQuote.length)
        .split('\n').length;
      matchedStartLines.add(startLine);
      matchedEndLines.add(endLine);
    }
  }

  if (matchedStartLines.size !== 1) {
    return { matchCount: matchedStartLines.size, startLine: null, endLine: null };
  }

  return {
    matchCount: 1,
    startLine: matchedStartLines.values().next().value,
    endLine: matchedEndLines.values().next().value,
  };
}

// Reconciles a line/text anchor against a new document by quote matching.
// Only a unique, sufficiently long quote relocates the anchor; anything else
// is preserved and marked so it surfaces as unanchored instead of landing on a
// plausible but wrong line.
function reconcileTextAnchor(anchor, nextDocumentText) {
  const quote = anchor.anchorQuote ?? anchor.quote ?? '';
  const normalizedQuote = normalizeCommentQuoteForComparison(quote);

  if (normalizedQuote.length < MIN_REANCHOR_QUOTE_LENGTH) {
    return {
      anchor: null,
      reason: 'quote-too-short',
      status: ANCHOR_STATUS.MISSING,
    };
  }

  const match = findUniqueLineMatch(nextDocumentText, quote);
  if (match.matchCount === 1 && match.startLine !== null) {
    // Clear stale Yjs relative positions so the line fallback is authoritative
    // after reconciliation; the old positions resolve against a replaced doc.
    return {
      anchor: {
        ...anchor,
        anchorEnd: null,
        anchorEndLine: match.endLine,
        anchorStart: null,
        anchorStartLine: match.startLine,
      },
      status: ANCHOR_STATUS.RESOLVED,
    };
  }

  return {
    anchor: null,
    reason: match.matchCount === 0 ? 'quote-not-found' : 'quote-ambiguous',
    status: match.matchCount === 0 ? ANCHOR_STATUS.MISSING : ANCHOR_STATUS.AMBIGUOUS,
  };
}

const TEXT_STRATEGY = Object.freeze({
  provider: ANCHOR_PROVIDER.TEXT,
  // Text anchors are reconciled on the server against the new document text.
  reconcile: reconcileTextAnchor,
});

const MERMAID_STRATEGY = Object.freeze({
  provider: ANCHOR_PROVIDER.MERMAID,
  // Rendered-diagram anchors are validated in the browser after hydration;
  // the server cannot resolve them from markdown source alone.
  reconcile: () => ({ anchor: null, status: ANCHOR_STATUS.DEFERRED }),
});

const PLANTUML_STRATEGY = Object.freeze({
  provider: ANCHOR_PROVIDER.PLANTUML,
  reconcile: () => ({ anchor: null, status: ANCHOR_STATUS.DEFERRED }),
});

const EXCALIDRAW_STRATEGY = Object.freeze({
  provider: ANCHOR_PROVIDER.EXCALIDRAW,
  // Excalidraw comments belong to the .excalidraw file's sidecar, not a
  // review-markdown PUT; leave them untouched.
  reconcile: () => ({ anchor: null, status: ANCHOR_STATUS.DEFERRED }),
});

const STRATEGIES = Object.freeze({
  [ANCHOR_PROVIDER.EXCALIDRAW]: EXCALIDRAW_STRATEGY,
  [ANCHOR_PROVIDER.MERMAID]: MERMAID_STRATEGY,
  [ANCHOR_PROVIDER.PLANTUML]: PLANTUML_STRATEGY,
  [ANCHOR_PROVIDER.TEXT]: TEXT_STRATEGY,
});

export function getAnchorStrategy(anchor) {
  const provider = detectAnchorProvider(anchor);
  return provider ? STRATEGIES[provider] : null;
}

// Reconciles a single persisted thread record against a new document text.
// Returns the thread unchanged apart from reconciliation fields; never throws.
// The thread's existing anchor fields are the input; the output record always
// carries an anchorStatus so the UI can surface unanchored threads explicitly.
export function reconcileCommentThread(thread, nextDocumentText) {
  const anchor = thread ?? {};
  const strategy = getAnchorStrategy(anchor);

  if (!strategy) {
    return { status: ANCHOR_STATUS.UNSUPPORTED, thread: { ...anchor, anchorStatus: ANCHOR_STATUS.UNSUPPORTED } };
  }

  const result = strategy.reconcile(anchor, nextDocumentText);

  if (result.status === ANCHOR_STATUS.RESOLVED && result.anchor) {
    return {
      status: ANCHOR_STATUS.RESOLVED,
      thread: { ...anchor, ...result.anchor, anchorStatus: ANCHOR_STATUS.RESOLVED },
    };
  }

  if (result.status === ANCHOR_STATUS.DEFERRED) {
    return {
      status: ANCHOR_STATUS.DEFERRED,
      thread: { ...anchor, anchorStatus: ANCHOR_STATUS.DEFERRED },
    };
  }

  return {
    status: result.status,
    reason: result.reason,
    thread: { ...anchor, anchorStatus: result.status },
  };
}

// Reconciles all threads and returns both the updated records and a report the
// PUT endpoint can surface to the caller. Pure — no I/O.
export function reconcileCommentThreads(threads = [], nextDocumentText) {
  const report = {
    ambiguous: [],
    deferred: [],
    missing: [],
    reanchored: [],
    unsupported: [],
  };

  const reconciled = (Array.isArray(threads) ? threads : []).map((thread) => {
    const result = reconcileCommentThread(thread, nextDocumentText);
    const id = thread?.id ?? null;
    if (result.status === ANCHOR_STATUS.RESOLVED && id) {
      report.reanchored.push(id);
    } else if (result.status === ANCHOR_STATUS.AMBIGUOUS && id) {
      report.ambiguous.push(id);
    } else if (result.status === ANCHOR_STATUS.MISSING && id) {
      report.missing.push(id);
    } else if (result.status === ANCHOR_STATUS.DEFERRED && id) {
      report.deferred.push(id);
    } else if (result.status === ANCHOR_STATUS.UNSUPPORTED && id) {
      report.unsupported.push(id);
    }
    return result.thread;
  });

  return { report, threads: reconciled };
}
