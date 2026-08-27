import {
  COMMENT_ANCHOR_QUOTE_MAX_LENGTH,
  normalizeCommentQuoteForComparison,
  summarizeCommentExcerpt,
} from './comment-threads.js';

const REVIEW_HEADING = '## Review Comments';
const REVIEW_SEPARATOR = '\n\n---\n\n';
const THREAD_HEADING_PREFIX = '### ';
const NO_COMMENTS_SENTINEL = '_No comments yet._';

function formatCommentDate(createdAt) {
  if (!Number.isFinite(createdAt)) {
    return '';
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function truncateQuote(quote) {
  const normalized = normalizeCommentQuoteForComparison(quote);
  if (!normalized) {
    return '';
  }
  return summarizeCommentExcerpt(normalized, COMMENT_ANCHOR_QUOTE_MAX_LENGTH);
}

function renderThreadHeading(thread) {
  const startLine = thread.anchorStartLine;
  const endLine = thread.anchorEndLine ?? startLine;
  const quote = truncateQuote(thread.anchorQuote);
  const quoteSuffix = quote ? ` — "${quote}"` : '';
  const resolvedSuffix = Number.isFinite(thread.resolvedAt)
    ? ` (resolved${thread.resolvedByName ? ` by ${thread.resolvedByName}` : ''})`
    : '';

  if (thread.anchorKind === 'diagram-element') {
    const elementId = typeof thread.elementId === 'string' ? thread.elementId : 'element';
    return `${THREAD_HEADING_PREFIX}Diagram ${elementId}${quoteSuffix}${resolvedSuffix}`;
  }

  const lineRange = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;
  return `${THREAD_HEADING_PREFIX}${lineRange}${quoteSuffix}${resolvedSuffix}`;
}

function renderMessage(message) {
  const author = message.userName || 'Anonymous';
  const date = formatCommentDate(message.createdAt);
  const dateSuffix = date ? ` (${date})` : '';
  const editedSuffix = Number.isFinite(message.editedAt) ? ' (edited)' : '';
  const body = typeof message.body === 'string' ? message.body.trim() : '';
  return `- **@${author}**${dateSuffix}${editedSuffix}: ${body}`;
}

function renderThreadId(thread) {
  const id = typeof thread.id === 'string' ? thread.id : '';
  return id ? `<!-- thread-id: ${id} -->` : '';
}

function renderThread(thread) {
  const heading = renderThreadHeading(thread);
  const idComment = renderThreadId(thread);
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const renderedMessages = messages
    .slice()
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map(renderMessage);
  const parts = [heading];
  if (idComment) {
    parts.push(idComment);
  }
  parts.push(...renderedMessages);
  return parts.join('\n\n');
}

function filterThreads(threads, includeResolved) {
  return threads.filter((thread) => includeResolved || !Number.isFinite(thread.resolvedAt));
}

function sortThreads(threads) {
  return threads.slice().sort((a, b) => {
    const aLine = a.anchorStartLine ?? Number.POSITIVE_INFINITY;
    const bLine = b.anchorStartLine ?? Number.POSITIVE_INFINITY;
    if (aLine !== bLine) {
      return aLine - bLine;
    }
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

export function serializeReviewToMarkdown({
  proposalMarkdown,
  threads = [],
  includeResolved = false,
} = {}) {
  const proposal = typeof proposalMarkdown === 'string' ? proposalMarkdown : '';
  const filtered = filterThreads(threads, includeResolved);
  if (filtered.length === 0) {
    return proposal;
  }

  const sorted = sortThreads(filtered);
  const renderedThreads = sorted.map(renderThread).join('\n\n');
  return `${proposal}${REVIEW_SEPARATOR}${REVIEW_HEADING}\n\n${renderedThreads}\n`;
}

export { NO_COMMENTS_SENTINEL, REVIEW_HEADING };
