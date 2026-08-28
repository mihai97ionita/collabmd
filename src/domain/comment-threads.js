import * as Y from 'yjs';

export const COMMENT_BODY_MAX_LENGTH = 2000;
export const COMMENT_EXCERPT_MAX_LENGTH = 160;
export const COMMENT_ANCHOR_QUOTE_MAX_LENGTH = 280;
export const COMMENT_REACTION_EMOJI_MAX_LENGTH = 16;

const COMMENT_ANCHOR_KINDS = new Set(['diagram-element', 'line', 'text']);

function asFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function asObject(value) {
  if (value instanceof Y.Map) {
    return value.toJSON();
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asArray(value) {
  if (value instanceof Y.Array) {
    return value.toArray();
  }

  return Array.isArray(value) ? value : [];
}

function readThreadValue(thread, key) {
  if (thread instanceof Y.Map) {
    return thread.get(key);
  }

  return thread?.[key];
}

function isResolvedThread(thread) {
  return asFiniteNumber(readThreadValue(thread, 'resolvedAt')) !== null;
}

function readRecordValue(record, key) {
  if (record instanceof Y.Map) {
    return record.get(key);
  }

  return record?.[key];
}

function normalizeAnchorKind(value) {
  return COMMENT_ANCHOR_KINDS.has(value) ? value : null;
}

function normalizeDiagramElementId(value) {
  const normalized = asString(value).trim().slice(0, 240);
  return normalized || null;
}

function normalizeDiagramKey(value) {
  const normalized = asString(value).trim().slice(0, 240);
  return normalized || null;
}

function normalizeDiagramAnchorPoint(value) {
  const point = asObject(value);
  const x = asFiniteNumber(point?.x);
  const y = asFiniteNumber(point?.y);
  return x === null || y === null ? null : { x, y };
}

function normalizeDiagramAnchorSnapshot(value) {
  const snapshot = asObject(value);
  const x = asFiniteNumber(snapshot?.x);
  const y = asFiniteNumber(snapshot?.y);
  const width = asFiniteNumber(snapshot?.width);
  const height = asFiniteNumber(snapshot?.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }

  return {
    height,
    text: normalizeCommentQuote(snapshot?.text),
    type: asString(snapshot?.type).trim() || 'element',
    width,
    x,
    y,
  };
}

export function normalizeCommentBody(value) {
  const normalized = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, COMMENT_BODY_MAX_LENGTH);

  return normalized || null;
}

export function normalizeCommentQuote(value) {
  const normalized = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, COMMENT_ANCHOR_QUOTE_MAX_LENGTH);

  return normalized || '';
}

export function normalizeCommentQuoteForComparison(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeCommentExcerpt(value, maxLength = COMMENT_EXCERPT_MAX_LENGTH) {
  const normalized = normalizeCommentQuoteForComparison(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 1, 1)).trimEnd()}…`;
}

function normalizeReactionEmoji(value) {
  return Array.from(String(value ?? '').trim())
    .slice(0, COMMENT_REACTION_EMOJI_MAX_LENGTH)
    .join('');
}

function createReactionUserRecord(user) {
  const userId = asString(readRecordValue(user, 'userId')).trim();
  if (!userId) {
    return null;
  }

  return {
    reactedAt: asFiniteNumber(readRecordValue(user, 'reactedAt')) ?? Date.now(),
    userColor: asString(readRecordValue(user, 'userColor')),
    userId,
    userName: asString(readRecordValue(user, 'userName')) || 'Anonymous',
  };
}

function createReactionGroupRecord(group) {
  const emoji = normalizeReactionEmoji(readRecordValue(group, 'emoji'));
  if (!emoji) {
    return null;
  }

  const usersById = new Map();
  asArray(readRecordValue(group, 'users')).forEach((user) => {
    const normalizedUser = createReactionUserRecord(user);
    if (normalizedUser) {
      usersById.set(normalizedUser.userId, normalizedUser);
    }
  });

  if (usersById.size === 0) {
    return null;
  }

  return {
    emoji,
    users: Array.from(usersById.values()),
  };
}

function serializeCommentReactions(reactions) {
  const groupsByEmoji = new Map();

  asArray(reactions).forEach((group) => {
    const normalizedGroup = createReactionGroupRecord(group);
    if (!normalizedGroup) {
      return;
    }

    const existing = groupsByEmoji.get(normalizedGroup.emoji);
    if (!existing) {
      groupsByEmoji.set(normalizedGroup.emoji, normalizedGroup);
      return;
    }

    const mergedUsers = new Map(existing.users.map((user) => [user.userId, user]));
    normalizedGroup.users.forEach((user) => mergedUsers.set(user.userId, user));
    groupsByEmoji.set(normalizedGroup.emoji, {
      emoji: normalizedGroup.emoji,
      users: Array.from(mergedUsers.values()),
    });
  });

  return Array.from(groupsByEmoji.values());
}

const ACTOR_TYPES = new Set(['human', 'agent']);

function normalizeActorType(value) {
  const normalized = asString(value);
  return ACTOR_TYPES.has(normalized) ? normalized : 'human';
}

function createMessageRecord(message) {
  const body = normalizeCommentBody(readRecordValue(message, 'body'));
  if (!body) {
    return null;
  }

  const editedAt = asFiniteNumber(readRecordValue(message, 'editedAt'));

  return {
    body,
    actorType: normalizeActorType(readRecordValue(message, 'actorType')),
    createdAt: asFiniteNumber(readRecordValue(message, 'createdAt')) ?? Date.now(),
    editedAt: editedAt ?? null,
    id: asString(readRecordValue(message, 'id')) || createCommentId('comment'),
    peerId: asString(readRecordValue(message, 'peerId')),
    reactions: serializeCommentReactions(readRecordValue(message, 'reactions')),
    userColor: asString(readRecordValue(message, 'userColor')),
    userId: asString(readRecordValue(message, 'userId')),
    userName: asString(readRecordValue(message, 'userName')) || 'Anonymous',
  };
}

export function editMessageRecord(message, body) {
  const normalizedBody = normalizeCommentBody(body);
  if (!normalizedBody) {
    return null;
  }

  const base = message instanceof Y.Map ? message.toJSON() : { ...message };
  return {
    ...createMessageRecord(base),
    body: normalizedBody,
    editedAt: Date.now(),
  };
}

function serializeMessages(messages) {
  return asArray(messages)
    .map((message) => createMessageRecord(message))
    .filter(Boolean);
}

export function createCommentId(prefix = 'comment') {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeCommentAnchor(record = {}) {
  const anchorKind = normalizeAnchorKind(record.anchorKind);
  if (anchorKind === 'diagram-element') {
    const anchorPoint = normalizeDiagramAnchorPoint(record.anchorPoint);
    const anchorSnapshot = normalizeDiagramAnchorSnapshot(record.anchorSnapshot);
    const diagramKey = normalizeDiagramKey(record.diagramKey);
    const elementId = normalizeDiagramElementId(record.elementId);
    if (!anchorPoint || !anchorSnapshot || !elementId) {
      return null;
    }

    return {
      anchorEndLine: asFiniteNumber(record.anchorEndLine),
      anchorKind,
      anchorPoint,
      anchorQuote: normalizeCommentQuote(record.anchorQuote || anchorSnapshot.text),
      anchorSnapshot,
      anchorStartLine: asFiniteNumber(record.anchorStartLine),
      ...(diagramKey ? { diagramKey } : {}),
      elementId,
    };
  }

  const anchorStart = asObject(record.anchorStart);
  const anchorEnd = asObject(record.anchorEnd);
  const anchorStartLine = asFiniteNumber(record.anchorStartLine);
  const anchorEndLine = asFiniteNumber(record.anchorEndLine);
  const anchorQuote = normalizeCommentQuote(record.anchorQuote);

  // Reconciled anchors clear the stale Yjs relative positions and rely on the
  // line range alone; accept a missing position pair as long as the lines are
  // present. The line fallback is authoritative for these records.
  const hasLineRange = anchorStartLine !== null && anchorEndLine !== null;
  const hasPositions = anchorStart && anchorEnd;
  if (!anchorKind || (!hasPositions && !hasLineRange) || anchorStartLine === null || anchorEndLine === null) {
    return null;
  }

  return {
    ...(anchorEnd ? { anchorEnd } : {}),
    ...(anchorStart ? { anchorStart } : {}),
    anchorEndLine: Math.max(anchorEndLine, anchorStartLine),
    anchorKind,
    anchorQuote,
    anchorStartLine: Math.max(anchorStartLine, 1),
  };
}

export function createCommentThreadSharedType(record = {}) {
  if (asFiniteNumber(record.resolvedAt) !== null) {
    return null;
  }

  const anchor = normalizeCommentAnchor(record);
  const initialMessage = createMessageRecord(record.messages?.[0]);
  if (!anchor || !initialMessage) {
    return null;
  }

  const messages = new Y.Array();
  const normalizedMessages = record.messages
    ?.map((message) => createMessageRecord(message))
    .filter(Boolean) ?? [];

  messages.push(normalizedMessages.length > 0 ? normalizedMessages : [initialMessage]);

  const thread = new Y.Map();
  thread.set('anchorKind', anchor.anchorKind);
  thread.set('anchorQuote', anchor.anchorQuote);
  if (anchor.anchorKind === 'diagram-element') {
    thread.set('anchorPoint', anchor.anchorPoint);
    thread.set('anchorSnapshot', anchor.anchorSnapshot);
    thread.set('elementId', anchor.elementId);
    if (anchor.anchorStartLine != null) {
      thread.set('anchorStartLine', anchor.anchorStartLine);
    }
    if (anchor.anchorEndLine != null) {
      thread.set('anchorEndLine', anchor.anchorEndLine);
    }
    if (anchor.diagramKey) {
      thread.set('diagramKey', anchor.diagramKey);
    }
  } else {
    if (anchor.anchorEnd) {
      thread.set('anchorEnd', anchor.anchorEnd);
    }
    thread.set('anchorEndLine', anchor.anchorEndLine);
    if (anchor.anchorStart) {
      thread.set('anchorStart', anchor.anchorStart);
    }
    thread.set('anchorStartLine', anchor.anchorStartLine);
  }
  if (asString(record.anchorStatus).trim()) {
    thread.set('anchorStatus', asString(record.anchorStatus).trim());
  }
  thread.set('createdAt', asFiniteNumber(record.createdAt) ?? Date.now());
  thread.set('createdByColor', asString(record.createdByColor));
  thread.set('createdByName', asString(record.createdByName) || initialMessage.userName);
  thread.set('createdByPeerId', asString(record.createdByPeerId) || initialMessage.peerId);
  thread.set('id', asString(record.id) || createCommentId('thread'));
  thread.set('messages', messages);
  thread.set('resolvedAt', asFiniteNumber(record.resolvedAt));
  thread.set('resolvedByColor', asString(record.resolvedByColor));
  thread.set('resolvedByName', asString(record.resolvedByName));
  thread.set('resolvedByPeerId', asString(record.resolvedByPeerId));
  return thread;
}

export function serializeCommentThread(thread, { includeResolved = false } = {}) {
  if (!includeResolved && isResolvedThread(thread)) {
    return null;
  }

  const anchor = normalizeCommentAnchor({
    anchorEnd: readThreadValue(thread, 'anchorEnd'),
    anchorEndLine: readThreadValue(thread, 'anchorEndLine'),
    anchorKind: readThreadValue(thread, 'anchorKind'),
    anchorQuote: readThreadValue(thread, 'anchorQuote'),
    anchorStart: readThreadValue(thread, 'anchorStart'),
    anchorStartLine: readThreadValue(thread, 'anchorStartLine'),
    anchorPoint: readThreadValue(thread, 'anchorPoint'),
    anchorSnapshot: readThreadValue(thread, 'anchorSnapshot'),
    diagramKey: readThreadValue(thread, 'diagramKey'),
    elementId: readThreadValue(thread, 'elementId'),
  });
  const messages = serializeMessages(readThreadValue(thread, 'messages'));

  if (!anchor || messages.length === 0) {
    return null;
  }

  const anchorStatus = asString(readThreadValue(thread, 'anchorStatus')).trim() || null;

  return {
    ...anchor,
    ...(anchorStatus ? { anchorStatus } : {}),
    createdAt: asFiniteNumber(readThreadValue(thread, 'createdAt')) ?? messages[0].createdAt,
    createdByColor: asString(readThreadValue(thread, 'createdByColor')) || messages[0].userColor,
    createdByName: asString(readThreadValue(thread, 'createdByName')) || messages[0].userName,
    createdByPeerId: asString(readThreadValue(thread, 'createdByPeerId')) || messages[0].peerId,
    id: asString(readThreadValue(thread, 'id')) || createCommentId('thread'),
    messages,
    resolvedAt: asFiniteNumber(readThreadValue(thread, 'resolvedAt')),
    resolvedByColor: asString(readThreadValue(thread, 'resolvedByColor')),
    resolvedByName: asString(readThreadValue(thread, 'resolvedByName')),
    resolvedByPeerId: asString(readThreadValue(thread, 'resolvedByPeerId')),
  };
}

export function serializeCommentThreads(source, { includeResolved = false } = {}) {
  const items = source instanceof Y.Array
    ? source.toArray()
    : Array.isArray(source)
      ? source
      : [];

  return items
    .map((thread) => serializeCommentThread(thread, { includeResolved }))
    .filter(Boolean);
}

export function populateCommentThreads(sharedArray, records = []) {
  if (!(sharedArray instanceof Y.Array) || !Array.isArray(records) || records.length === 0) {
    return;
  }

  const threads = records
    .map((record) => createCommentThreadSharedType(record))
    .filter(Boolean);

  if (threads.length > 0) {
    sharedArray.push(threads);
  }
}
