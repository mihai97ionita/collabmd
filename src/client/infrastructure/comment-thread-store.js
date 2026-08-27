import * as Y from 'yjs';

import {
  createCommentId,
  createCommentThreadSharedType,
  editMessageRecord,
  normalizeCommentAnchor,
  normalizeCommentBody,
  normalizeCommentQuote,
  serializeCommentThreads,
  summarizeCommentExcerpt,
} from '../../domain/comment-threads.js';

function createCommentMessage({ body, user }) {
  return {
    body,
    createdAt: Date.now(),
    id: createCommentId('comment'),
    peerId: user?.peerId ?? '',
    reactions: [],
    userColor: user?.color ?? '',
    userName: user?.name ?? 'Anonymous',
  };
}

function readRecordValue(record, key) {
  if (record instanceof Y.Map) {
    return record.get(key);
  }

  return record?.[key];
}

function cloneReactionGroups(source = []) {
  return Array.isArray(source)
    ? source.map((group) => ({
      emoji: typeof group?.emoji === 'string' ? group.emoji : '',
      users: Array.isArray(group?.users)
        ? group.users.map((user) => ({
          reactedAt: Number.isFinite(user?.reactedAt) ? user.reactedAt : Date.now(),
          userColor: typeof user?.userColor === 'string' ? user.userColor : '',
          userId: typeof user?.userId === 'string' ? user.userId : '',
          userName: typeof user?.userName === 'string' && user.userName ? user.userName : 'Anonymous',
        })).filter((user) => user.userId)
        : [],
    })).filter((group) => group.emoji && group.users.length > 0)
    : [];
}

function normalizeSelectionAnchorPayload(payload, state) {
  const doc = state?.doc;
  if (!doc) {
    return null;
  }

  const anchor = payload?.anchor ?? payload;
  const anchorKind = anchor?.anchorKind === 'text' ? 'text' : 'line';
  const lineCount = doc.lines;
  const startLine = Math.min(Math.max(Math.round(anchor?.startLine ?? 1), 1), lineCount);
  const endLine = Math.min(
    Math.max(Math.round(anchor?.endLine ?? startLine), startLine),
    lineCount,
  );
  const defaultStartIndex = doc.line(startLine).from;
  const defaultEndIndex = doc.line(endLine).to;
  const startIndex = Math.min(
    Math.max(Math.round(anchor?.startIndex ?? defaultStartIndex), 0),
    doc.length,
  );
  const endIndex = Math.min(
    Math.max(Math.round(anchor?.endIndex ?? defaultEndIndex), startIndex),
    doc.length,
  );

  return {
    anchorEndLine: endLine,
    anchorKind,
    anchorQuote: normalizeCommentQuote(anchor?.anchorQuote || doc.sliceString(startIndex, endIndex)),
    anchorStartLine: startLine,
    endIndex,
    startIndex,
  };
}

export class CommentThreadStore {
  constructor({
    canWrite = () => true,
    createAnchor = null,
    getDoc,
    getEditorState,
    getLocalUser,
    onCommentsChange = null,
    resolveThread = null,
  }) {
    this.canWrite = canWrite;
    this.createAnchor = createAnchor;
    this.getDoc = getDoc;
    this.getEditorState = getEditorState;
    this.getLocalUser = getLocalUser;
    this.onCommentsChange = onCommentsChange;
    this.resolveThread = resolveThread;
    this.commentThreads = null;
    this.ydoc = null;
    this.ytext = null;
    this.handleCommentThreadsChange = null;
    this.handleTextChange = null;
  }

  bind({ commentThreads, ydoc, ytext }) {
    this.unbind();
    this.commentThreads = commentThreads;
    this.ydoc = ydoc;
    this.ytext = ytext;
    this.handleCommentThreadsChange = () => {
      this.emitCommentsChange();
    };
    this.handleTextChange = () => {
      this.emitCommentsChange();
    };
    this.commentThreads.observeDeep(this.handleCommentThreadsChange);
    this.ytext?.observe?.(this.handleTextChange);
    this.emitCommentsChange();
  }

  unbind() {
    if (this.commentThreads && this.handleCommentThreadsChange) {
      this.commentThreads.unobserveDeep(this.handleCommentThreadsChange);
    }
    if (this.ytext && this.handleTextChange) {
      this.ytext.unobserve(this.handleTextChange);
    }

    this.commentThreads = null;
    this.ydoc = null;
    this.ytext = null;
    this.handleCommentThreadsChange = null;
    this.handleTextChange = null;
  }

  emitCommentsChange() {
    this.onCommentsChange?.(this.getCommentThreads());
  }

  refreshComments() {
    this.emitCommentsChange();
  }

  getCommentThreads() {
    if (!this.commentThreads) {
      return [];
    }

    return serializeCommentThreads(this.commentThreads)
      .map((thread) => this.resolveThread
        ? this.resolveThread(thread)
        : this.resolveThreadForUi(thread))
      .filter(Boolean);
  }

  createCommentThread({ anchor, body }) {
    if (!this.canWrite() || !this.commentThreads || !this.ydoc) {
      return null;
    }

    const state = this.getEditorState?.();
    const normalizedBody = normalizeCommentBody(body);
    if (!this.createAnchor && (!state || !this.ytext)) {
      return null;
    }

    let usedCreateAnchor = false;
    let normalizedAnchor = null;
    if (this.createAnchor) {
      const created = this.createAnchor(anchor);
      if (created) {
        normalizedAnchor = created;
        usedCreateAnchor = true;
      }
    }
    if (!normalizedAnchor) {
      if (!state || !this.ytext) {
        return null;
      }
      normalizedAnchor = normalizeSelectionAnchorPayload(anchor, state);
    }
    if (!normalizedBody || !normalizedAnchor) {
      return null;
    }

    const thread = createCommentThreadSharedType({
      ...normalizedAnchor,
      ...(usedCreateAnchor ? {} : {
        anchorEnd: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(this.ytext, normalizedAnchor.endIndex),
        ),
      }),
      anchorKind: normalizedAnchor.anchorKind,
      anchorQuote: normalizedAnchor.anchorQuote,
      ...(usedCreateAnchor ? {} : {
        anchorStart: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(this.ytext, normalizedAnchor.startIndex),
        ),
      }),
      createdAt: Date.now(),
      createdByColor: this.getLocalUser()?.color ?? '',
      createdByName: this.getLocalUser()?.name ?? 'Anonymous',
      createdByPeerId: this.getLocalUser()?.peerId ?? '',
      id: createCommentId('thread'),
      messages: [createCommentMessage({
        body: normalizedBody,
        user: this.getLocalUser(),
      })],
    });

    if (!thread) {
      return null;
    }

    this.ydoc.transact(() => {
      this.commentThreads.push([thread]);
    }, 'comment-thread-create');

    return thread.get('id');
  }

  replyToCommentThread(threadId, body) {
    if (!this.canWrite()) {
      return null;
    }

    const normalizedBody = normalizeCommentBody(body);
    if (!normalizedBody || !this.ydoc) {
      return null;
    }

    const thread = this.findSharedCommentThread(threadId);
    const messages = thread?.get('messages');
    if (!(messages instanceof Y.Array)) {
      return null;
    }

    const message = createCommentMessage({
      body: normalizedBody,
      user: this.getLocalUser(),
    });

    this.ydoc.transact(() => {
      messages.push([message]);
    }, 'comment-thread-reply');

    return message.id;
  }

  toggleCommentReaction(threadId, messageId, emoji) {
    if (!this.ydoc || !threadId || !messageId || typeof emoji !== 'string' || !emoji.trim()) {
      return false;
    }

    const localUser = this.getLocalUser?.();
    const localUserId = typeof localUser?.userId === 'string' ? localUser.userId : '';
    if (!localUserId) {
      return false;
    }

    const thread = this.findSharedCommentThread(threadId);
    const messages = thread?.get('messages');
    if (!(messages instanceof Y.Array)) {
      return false;
    }

    const items = messages.toArray();
    const messageIndex = items.findIndex((message) => readRecordValue(message, 'id') === messageId);
    if (messageIndex < 0) {
      return false;
    }

    const messageRecord = items[messageIndex] instanceof Y.Map
      ? items[messageIndex].toJSON()
      : { ...items[messageIndex] };
    const reactions = cloneReactionGroups(messageRecord.reactions);
    const reactionIndex = reactions.findIndex((reaction) => reaction.emoji === emoji);

    if (reactionIndex >= 0) {
      const nextUsers = reactions[reactionIndex].users.filter((user) => user.userId !== localUserId);
      if (nextUsers.length === reactions[reactionIndex].users.length) {
        nextUsers.push({
          reactedAt: Date.now(),
          userColor: localUser?.color ?? '',
          userId: localUserId,
          userName: localUser?.name ?? 'Anonymous',
        });
      }

      if (nextUsers.length === 0) {
        reactions.splice(reactionIndex, 1);
      } else {
        reactions[reactionIndex] = {
          ...reactions[reactionIndex],
          users: nextUsers,
        };
      }
    } else {
      reactions.push({
        emoji,
        users: [{
          reactedAt: Date.now(),
          userColor: localUser?.color ?? '',
          userId: localUserId,
          userName: localUser?.name ?? 'Anonymous',
        }],
      });
    }

    const nextMessage = {
      ...messageRecord,
      reactions,
    };

    this.ydoc.transact(() => {
      messages.delete(messageIndex, 1);
      messages.insert(messageIndex, [nextMessage]);
    }, 'comment-reaction-toggle');

    return true;
  }

  editCommentMessage(threadId, messageId, body) {
    if (!this.ydoc || !threadId || !messageId) {
      return false;
    }

    const normalizedBody = normalizeCommentBody(body);
    if (!normalizedBody) {
      return false;
    }

    const thread = this.findSharedCommentThread(threadId);
    const messages = thread?.get('messages');
    if (!(messages instanceof Y.Array)) {
      return false;
    }

    const items = messages.toArray();
    const messageIndex = items.findIndex((message) => readRecordValue(message, 'id') === messageId);
    if (messageIndex < 0) {
      return false;
    }

    const existingRecord = items[messageIndex] instanceof Y.Map
      ? items[messageIndex].toJSON()
      : { ...items[messageIndex] };
    const nextMessage = editMessageRecord(existingRecord, normalizedBody);
    if (!nextMessage) {
      return false;
    }

    this.ydoc.transact(() => {
      messages.delete(messageIndex, 1);
      messages.insert(messageIndex, [nextMessage]);
    }, 'comment-message-edit');

    return true;
  }

  resolveCommentThread(threadId) {
    if (!this.canWrite() || !this.commentThreads || !this.ydoc) {
      return false;
    }

    const thread = this.findSharedCommentThread(threadId);
    if (!thread) {
      return false;
    }

    const user = this.getLocalUser();
    this.ydoc.transact(() => {
      thread.set('resolvedAt', Date.now());
      thread.set('resolvedByColor', user?.color ?? '');
      thread.set('resolvedByName', user?.name ?? 'Anonymous');
      thread.set('resolvedByPeerId', user?.peerId ?? '');
    }, 'comment-thread-resolve');

    return true;
  }

  deleteCommentThread(threadId) {
    if (!this.canWrite() || !this.commentThreads || !this.ydoc) {
      return false;
    }

    const threadIndex = this.findSharedCommentThreadIndex(threadId);
    if (threadIndex < 0) {
      return false;
    }

    this.ydoc.transact(() => {
      this.commentThreads.delete(threadIndex, 1);
    }, 'comment-thread-delete');

    return true;
  }

  findSharedCommentThread(threadId) {
    if (!this.commentThreads) {
      return null;
    }

    return this.commentThreads.toArray().find((thread) => (
      thread instanceof Y.Map && thread.get('id') === threadId
    )) ?? null;
  }

  findSharedCommentThreadIndex(threadId) {
    if (!this.commentThreads) {
      return -1;
    }

    return this.commentThreads.toArray().findIndex((thread) => (
      thread instanceof Y.Map && thread.get('id') === threadId
    ));
  }

  resolveThreadForUi(thread) {
    const state = this.getEditorState();
    if (!thread || !state || !this.ydoc) {
      return null;
    }

    const normalizedAnchor = normalizeCommentAnchor(thread);
    if (!normalizedAnchor) {
      return null;
    }

    if (normalizedAnchor.anchorKind === 'diagram-element') {
      return {
        ...thread,
        anchor: {
          excerpt: normalizedAnchor.anchorQuote,
          kind: normalizedAnchor.anchorKind,
          quote: normalizedAnchor.anchorQuote,
        },
        anchorKind: normalizedAnchor.anchorKind,
        anchorPoint: normalizedAnchor.anchorPoint,
        anchorQuote: normalizedAnchor.anchorQuote,
        anchorSnapshot: normalizedAnchor.anchorSnapshot,
        elementId: normalizedAnchor.elementId,
      };
    }

    const anchorStart = this.resolveCommentPosition(normalizedAnchor.anchorStart);
    const anchorEnd = this.resolveCommentPosition(normalizedAnchor.anchorEnd);
    const startIndex = anchorStart?.index ?? state.doc.line(normalizedAnchor.anchorStartLine).from;
    const fallbackEndLine = Math.min(
      Math.max(normalizedAnchor.anchorEndLine ?? normalizedAnchor.anchorStartLine, normalizedAnchor.anchorStartLine),
      state.doc.lines,
    );
    const endIndex = anchorEnd?.index ?? state.doc.line(fallbackEndLine).to;
    const startLine = state.doc.lineAt(startIndex).number;
    const safeEndIndex = Math.min(Math.max(endIndex, startIndex), state.doc.length);
    const endLine = state.doc.lineAt(safeEndIndex).number;
    const rawExcerpt = state.doc.sliceString(
      startIndex,
      normalizedAnchor.anchorKind === 'text' ? Math.max(endIndex, startIndex) : state.doc.line(endLine).to,
    );
    const excerpt = summarizeCommentExcerpt(rawExcerpt) || normalizedAnchor.anchorQuote;

    return {
      ...thread,
      anchor: {
        endIndex,
        endLine,
        excerpt,
        quote: normalizedAnchor.anchorQuote,
        startIndex,
        startLine,
        kind: normalizedAnchor.anchorKind,
      },
      anchorEnd: normalizedAnchor.anchorEnd,
      anchorEndLine: normalizedAnchor.anchorEndLine,
      anchorKind: normalizedAnchor.anchorKind,
      anchorQuote: normalizedAnchor.anchorQuote,
      anchorStart: normalizedAnchor.anchorStart,
      anchorStartLine: normalizedAnchor.anchorStartLine,
    };
  }

  resolveCommentPosition(positionJson) {
    if (!positionJson || !this.ydoc || !this.ytext) {
      return null;
    }

    try {
      const position = Y.createRelativePositionFromJSON(positionJson);
      const absolute = Y.createAbsolutePositionFromRelativePosition(position, this.ydoc);
      if (!absolute || absolute.type !== this.ytext) {
        return null;
      }

      return absolute;
    } catch {
      return null;
    }
  }
}
