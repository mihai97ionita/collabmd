import {
  createCommentId,
  normalizeCommentBodyWithTruncation,
  serializeCommentThreads,
} from '../../../domain/comment-threads.js';
import { moveCommentThreadAnchors, reconcileCommentThreads } from '../../../domain/comment-anchors.js';
import { serializeReviewToMarkdown } from '../../../domain/review-markdown-serializer.js';
import { handleApiError } from './http-request-helpers.js';
import { jsonResponse, sendResponse } from './http-response.js';
import { parseJsonBody, REQUEST_BODY_LIMIT_BYTES } from './request-body.js';

const REVIEW_REQUEST_LIMIT_BYTES = REQUEST_BODY_LIMIT_BYTES;
const TEXT_MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
const AGENT_USER_NAME = 'Agent';

function buildAbsoluteReviewUrl(req, basePath, vaultPath, publicBaseUrl = '') {
  if (publicBaseUrl) {
    const base = basePath ? `${publicBaseUrl}${basePath}` : publicBaseUrl;
    return `${base}/#file=${encodeURIComponent(vaultPath)}`;
  }
  const host = req.headers.host || 'localhost';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const base = basePath ? `${protocol}://${host}${basePath}` : `${protocol}://${host}`;
  return `${base}/#file=${encodeURIComponent(vaultPath)}`;
}

function readReviewIdFromPath(pathname) {
  const prefix = '/api/review/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const segment = pathname.slice(prefix.length);
  const safeSegment = segment.split('/')[0];
  return safeSegment || null;
}

function readWaitReviewId(pathname) {
  const prefix = '/api/review/';
  const suffix = '/wait';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const reviewId = pathname.slice(prefix.length, pathname.length - suffix.length);
  return reviewId && !reviewId.includes('/') ? reviewId : null;
}

function readNotifyReviewId(pathname) {
  const prefix = '/api/review/';
  const suffix = '/notify';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const reviewId = pathname.slice(prefix.length, pathname.length - suffix.length);
  return reviewId && !reviewId.includes('/') ? reviewId : null;
}

function readWaitingReviewId(pathname) {
  const prefix = '/api/review/';
  const suffix = '/waiting';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const reviewId = pathname.slice(prefix.length, pathname.length - suffix.length);
  return reviewId && !reviewId.includes('/') ? reviewId : null;
}

function readReplyTargetFromPath(pathname) {
  // /api/review/<id>/threads/<threadId>/reply
  const prefix = '/api/review/';
  const suffix = '/reply';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const middle = pathname.slice(prefix.length, pathname.length - suffix.length);
  const parts = middle.split('/');
  if (parts.length !== 3 || parts[1] !== 'threads') {
    return null;
  }
  const reviewId = parts[0];
  const threadId = parts[2];
  if (!reviewId || !threadId) {
    return null;
  }
  return { reviewId, threadId };
}

function readAnchorMoveReviewId(pathname) {
  const prefix = '/api/review/';
  const suffix = '/anchors';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const reviewId = pathname.slice(prefix.length, pathname.length - suffix.length);
  return reviewId && !reviewId.includes('/') ? reviewId : null;
}

function isReviewPostPath(pathname) {
  return pathname === '/api/review';
}

function isReviewGetPath(pathname) {
  return pathname.startsWith('/api/review/');
}

function isReviewPutPath(pathname) {
  return pathname.startsWith('/api/review/');
}

function isReviewReplyPath(pathname) {
  return pathname.includes('/threads/') && pathname.endsWith('/reply');
}

function isReviewAnchorMovePath(pathname) {
  return readAnchorMoveReviewId(pathname) !== null;
}

function isReviewWaitPath(pathname) {
  return readWaitReviewId(pathname) !== null;
}

function isReviewNotifyPath(pathname) {
  return readNotifyReviewId(pathname) !== null;
}

function isReviewWaitingPath(pathname) {
  return readWaitingReviewId(pathname) !== null;
}

function hasActiveCollaborationSession(roomRegistry, vaultPath) {
  if (!roomRegistry || typeof roomRegistry.get !== 'function') {
    return false;
  }
  const room = roomRegistry.get(vaultPath);
  if (!room || room.isDeleted?.()) {
    return false;
  }
  const clientCount = typeof room.clients?.size === 'number' ? room.clients.size : 0;
  return clientCount > 0;
}

function sendActiveReviewConflict(req, res, vaultPath) {
  jsonResponse(req, res, 409, {
    error: 'Review file is open in a browser collaboration session',
    vaultPath,
  });
}

async function reserveExternalReviewMutation(context, req, res, vaultPath) {
  const roomRegistry = context.roomRegistry;
  if (!roomRegistry || typeof roomRegistry.reserveExternalMutation !== 'function') {
    if (hasActiveCollaborationSession(roomRegistry, vaultPath)) {
      sendActiveReviewConflict(req, res, vaultPath);
      return null;
    }
    return { release: async () => {} };
  }

  const reservation = await roomRegistry.reserveExternalMutation(vaultPath);
  if (!reservation.ok) {
    sendActiveReviewConflict(req, res, vaultPath);
    return null;
  }
  return reservation;
}

async function handleReviewCreate(context, req, res) {
  try {
    const body = await parseJsonBody(req, REVIEW_REQUEST_LIMIT_BYTES);
    if (!body || typeof body.markdown !== 'string' || body.markdown.trim() === '') {
      jsonResponse(req, res, 400, { error: 'Missing "markdown" in request body' });
      return true;
    }

    const reviewStore = context.reviewStore;
    if (!reviewStore) {
      jsonResponse(req, res, 503, { error: 'Review store is not configured' });
      return true;
    }

    const result = await reviewStore.create({
      markdown: body.markdown,
      title: typeof body.title === 'string' ? body.title : null,
    });
    if (!result.ok) {
      jsonResponse(req, res, 500, { error: result.error || 'Failed to create review' });
      return true;
    }

    jsonResponse(req, res, 201, {
      ok: true,
      reviewId: result.reviewId,
      vaultPath: result.vaultPath,
      url: buildAbsoluteReviewUrl(req, context.basePath, result.vaultPath, context.publicBaseUrl),
    });
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to create review:', 'Failed to create review');
  }
  return true;
}

async function handleReviewRead(context, req, res, requestUrl) {
  try {
    const reviewId = readReviewIdFromPath(requestUrl.pathname);
    if (!reviewId) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const reviewStore = context.reviewStore;
    const vaultFileStore = context.vaultFileStore;
    if (!reviewStore || !vaultFileStore) {
      jsonResponse(req, res, 503, { error: 'Review store is not configured' });
      return true;
    }

    const meta = await reviewStore.readMeta(reviewId);
    if (!meta) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const includeResolved = requestUrl.searchParams.get('resolved') === 'true';
    const proposalMarkdown = await reviewStore.readProposal(reviewId);
    if (proposalMarkdown === null) {
      jsonResponse(req, res, 404, { error: 'Review proposal not found' });
      return true;
    }

    const rawThreads = await vaultFileStore.readCommentThreads(meta.vaultPath);
    const serialized = serializeCommentThreads(rawThreads, { includeResolved });
    const reviewStatus = context.reviewWaitingState?.getLastNotify?.(reviewId) ?? null;
    const markdown = serializeReviewToMarkdown({
      proposalMarkdown,
      threads: serialized,
      includeResolved,
      reviewStatus,
    });

    const reviewUrl = buildAbsoluteReviewUrl(req, context.basePath, meta.vaultPath, context.publicBaseUrl);
    sendResponse(req, res, {
      body: markdown,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': TEXT_MARKDOWN_CONTENT_TYPE,
        'X-Content-Type-Options': 'nosniff',
        'X-Review-Url': reviewUrl,
      },
      statusCode: 200,
    });
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to read review:', 'Failed to read review');
  }
  return true;
}

async function handleReviewUpdate(context, req, res, requestUrl) {
  try {
    const reviewId = readReviewIdFromPath(requestUrl.pathname);
    if (!reviewId) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const reviewStore = context.reviewStore;
    if (!reviewStore) {
      jsonResponse(req, res, 503, { error: 'Review store is not configured' });
      return true;
    }

    const meta = await reviewStore.readMeta(reviewId);
    if (!meta) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const reservation = await reserveExternalReviewMutation(context, req, res, meta.vaultPath);
    if (!reservation) {
      return true;
    }
    let wrote = false;
    try {
      const body = await parseJsonBody(req, REVIEW_REQUEST_LIMIT_BYTES);
      if (!body || typeof body.markdown !== 'string' || body.markdown.trim() === '') {
        jsonResponse(req, res, 422, { error: 'Missing or empty "markdown" in request body' });
        return true;
      }

      // Reconcile comment anchors against the new proposal before writing, so
      // line/text threads follow their quoted content across a revision. Diagram
      // anchors are deferred (validated by the browser after render).
      const existingThreads = await context.vaultFileStore.readCommentThreads(meta.vaultPath);
      const reconciliation = reconcileCommentThreads(existingThreads, body.markdown);

      const result = await reviewStore.writeProposal(reviewId, body.markdown);
      if (!result.ok) {
        jsonResponse(req, res, result.status ?? 500, { error: result.error || 'Failed to update review' });
        return true;
      }
      wrote = true;

      if (Array.isArray(existingThreads) && existingThreads.length > 0) {
        const writeResult = await context.vaultFileStore.writeCommentThreads(meta.vaultPath, reconciliation.threads);
        if (!writeResult.ok) {
          // Proposal is already written; surface the failure but do not pretend
          // the anchors reconciled.
          jsonResponse(req, res, 200, {
            ok: true,
            vaultPath: result.vaultPath,
            updatedAt: result.updatedAt,
            warning: 'Proposal written but comment anchors could not be reconciled',
            reconciliation: null,
          });
          return true;
        }
      }

      jsonResponse(req, res, 200, {
        ok: true,
        vaultPath: result.vaultPath,
        updatedAt: result.updatedAt,
        reconciliation: reconciliation.report,
      });
    } finally {
      await reservation.release({ refreshFromDisk: wrote });
    }
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to update review:', 'Failed to update review');
  }
  return true;
}

async function handleReviewAnchorMove(context, req, res, requestUrl) {
  try {
    const reviewId = readAnchorMoveReviewId(requestUrl.pathname);
    const reviewStore = context.reviewStore;
    const vaultFileStore = context.vaultFileStore;
    if (!reviewId || !reviewStore || !vaultFileStore) {
      jsonResponse(req, res, reviewId ? 503 : 404, { error: reviewId ? 'Review store is not configured' : 'Review not found' });
      return true;
    }

    const meta = await reviewStore.readMeta(reviewId);
    if (!meta) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const reservation = await reserveExternalReviewMutation(context, req, res, meta.vaultPath);
    if (!reservation) {
      return true;
    }
    let wrote = false;
    try {
      const proposalMarkdown = await reviewStore.readProposal(reviewId);
      if (proposalMarkdown === null) {
        jsonResponse(req, res, 404, { error: 'Review proposal not found' });
        return true;
      }

      const body = await parseJsonBody(req, REVIEW_REQUEST_LIMIT_BYTES);
      const existingThreads = await vaultFileStore.readCommentThreads(meta.vaultPath);
      const moved = moveCommentThreadAnchors(existingThreads, body?.moves, proposalMarkdown);
      if (!moved.ok) {
        const statusCode = moved.code === 'thread-not-found' ? 404 : 422;
        jsonResponse(req, res, statusCode, { error: moved.error, code: moved.code, threadId: moved.threadId ?? null });
        return true;
      }

      const writeResult = await vaultFileStore.writeCommentThreads(meta.vaultPath, moved.threads);
      if (!writeResult.ok) {
        console.error('[api] Failed to persist comment anchors:', writeResult.error);
        jsonResponse(req, res, 500, { error: 'Failed to persist comment anchors' });
        return true;
      }
      wrote = true;

      jsonResponse(req, res, 200, { ok: true, moved: moved.moved });
    } finally {
      await reservation.release({ refreshFromDisk: wrote });
    }
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to move review thread anchors:', 'Failed to move review thread anchors');
  }
  return true;
}

const REVIEW_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const REVIEW_WAIT_REASON_LIVE_SESSION = 'human still owns the live session; PUT will 409';

function resolveWaitTimeoutMs(requestUrl) {
  if (process.env.COLLABMD_TESTING === '1') {
    const override = Number(requestUrl.searchParams.get('timeoutMs'));
    if (Number.isFinite(override) && override > 0) {
      return override;
    }
  }
  return REVIEW_WAIT_TIMEOUT_MS;
}

function buildReviewWaitResult(context, meta, notify) {
  const mode = notify.mode;
  const liveSession = hasActiveCollaborationSession(context.roomRegistry, meta.vaultPath);
  // handoff is the only mode that grants edit rights; approve/deny are terminal
  // so canEdit is always false for them.
  const canEdit = mode === 'handoff' && !liveSession;
  // Distinguish "peek does not grant edit" from "handoff blocked by a live session"
  // so the agent does not wait for a session to close that does not exist.
  const reason = canEdit
    ? null
    : mode === 'approve'
      ? 'approved'
      : mode === 'deny'
        ? 'denied'
        : mode !== 'handoff'
          ? 'peek mode does not grant edit'
          : REVIEW_WAIT_REASON_LIVE_SESSION;
  return {
    mode,
    canReply: true,
    canEdit,
    reason,
    since: String(notify.at),
    reviewConcluded: mode === 'approve' || mode === 'deny',
    canProceed: mode === 'approve' && Boolean(notify.canProceed),
  };
}

async function handleReviewWait(context, req, res, requestUrl) {
  try {
    const reviewId = readWaitReviewId(requestUrl.pathname);
    if (!reviewId) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const reviewStore = context.reviewStore;
    const reviewWaitingState = context.reviewWaitingState;
    if (!reviewStore || !reviewWaitingState) {
      jsonResponse(req, res, 503, { error: 'Review wait is not configured' });
      return true;
    }

    const meta = await reviewStore.readMeta(reviewId);
    if (!meta) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const since = requestUrl.searchParams.get('since') || null;

    // Sticky delivery: if a notify fired while the agent was between polls,
    // consume it immediately and respond without holding the connection.
    const pending = reviewWaitingState.consumePendingNotify(reviewId, since);
    if (pending) {
      jsonResponse(req, res, 200, buildReviewWaitResult(context, meta, pending));
      return true;
    }

    reviewWaitingState.markWaiting(reviewId);
    const { promise, cancel } = reviewWaitingState.registerWaiter(reviewId, since);

    let settled = false;
    const timeoutMs = resolveWaitTimeoutMs(requestUrl);
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cancel();
      reviewWaitingState.clearWaiting(reviewId);
      sendResponse(req, res, { statusCode: 202, body: '', headers: { 'Cache-Control': 'no-store' } });
    }, timeoutMs);

    req.on('close', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      cancel();
      // Clear waiting so the /waiting endpoint stops reporting this review.
      // If other concurrent waiters exist they remain in the array and will
      // still be resolved by a future postNotify; agentWaiting=false is a
      // minor inconsistency in that rare multi-waiter edge case.
      reviewWaitingState.clearWaiting(reviewId);
    });

    try {
      const notify = await promise;
      clearTimeout(timeoutId);
      if (settled) {
        return true;
      }
      settled = true;

      if (notify) {
        jsonResponse(req, res, 200, buildReviewWaitResult(context, meta, notify));
      } else {
        // Clean clear (e.g. no notify) — respond 202 with an empty body.
        sendResponse(req, res, { statusCode: 202, body: '', headers: { 'Cache-Control': 'no-store' } });
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (!settled && !res.headersSent) {
        handleApiError(req, res, error, '[api] Failed to wait for review:', 'Failed to wait for review');
      }
    }
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to wait for review:', 'Failed to wait for review');
  }
  return true;
}

async function handleReviewNotify(context, req, res, requestUrl) {
  try {
    const reviewId = readNotifyReviewId(requestUrl.pathname);
    if (!reviewId) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const reviewStore = context.reviewStore;
    const reviewWaitingState = context.reviewWaitingState;
    if (!reviewStore || !reviewWaitingState) {
      jsonResponse(req, res, 503, { error: 'Review notify is not configured' });
      return true;
    }

    const meta = await reviewStore.readMeta(reviewId);
    if (!meta) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const body = await parseJsonBody(req, REVIEW_REQUEST_LIMIT_BYTES);
    const mode = body?.mode;
    if (mode !== 'peek' && mode !== 'handoff' && mode !== 'approve' && mode !== 'deny') {
      jsonResponse(req, res, 422, { error: 'mode must be "peek", "handoff", "approve", or "deny"' });
      return true;
    }

    // approve may carry an optional canProceed flag; other modes ignore it.
    const canProceed = mode === 'approve' ? Boolean(body?.canProceed) : false;
    reviewWaitingState.postNotify(reviewId, mode, canProceed);
    jsonResponse(req, res, 200, { ok: true });
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to notify review:', 'Failed to notify review');
  }
  return true;
}

async function handleReviewWaiting(context, req, res, requestUrl) {
  try {
    const reviewId = readWaitingReviewId(requestUrl.pathname);
    if (!reviewId) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const reviewStore = context.reviewStore;
    const reviewWaitingState = context.reviewWaitingState;
    if (!reviewStore || !reviewWaitingState) {
      jsonResponse(req, res, 503, { error: 'Review waiting is not configured' });
      return true;
    }

    const meta = await reviewStore.readMeta(reviewId);
    if (!meta) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    jsonResponse(req, res, 200, { agentWaiting: reviewWaitingState.isWaiting(reviewId) });
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to read review waiting state:', 'Failed to read review waiting state');
  }
  return true;
}

async function handleReviewReply(context, req, res, requestUrl) {
  try {
    const target = readReplyTargetFromPath(requestUrl.pathname);
    if (!target) {
      jsonResponse(req, res, 404, { error: 'Review thread not found' });
      return true;
    }

    const reviewStore = context.reviewStore;
    const vaultFileStore = context.vaultFileStore;
    if (!reviewStore || !vaultFileStore) {
      jsonResponse(req, res, 503, { error: 'Review store is not configured' });
      return true;
    }

    const meta = await reviewStore.readMeta(target.reviewId);
    if (!meta) {
      jsonResponse(req, res, 404, { error: 'Review not found' });
      return true;
    }

    const body = await parseJsonBody(req, REVIEW_REQUEST_LIMIT_BYTES);
    const normalization = normalizeCommentBodyWithTruncation(body?.body);
    if (!normalization.body) {
      jsonResponse(req, res, 422, { error: 'Missing or empty "body" in request body' });
      return true;
    }

    const message = {
      actorType: 'agent',
      body: normalization.body,
      createdAt: Date.now(),
      editedAt: null,
      id: createCommentId('comment'),
      peerId: '',
      reactions: [],
      userColor: '',
      userId: '',
      userName: AGENT_USER_NAME,
    };

    // Shared 200 payload: includes truncation metadata so the MCP agent can
    // detect that its reply was silently sliced to COMMENT_BODY_MAX_LENGTH.
    const successPayload = {
      ok: true,
      messageId: message.id,
      threadId: target.threadId,
      truncated: normalization.truncated,
      bodyLength: normalization.body.length,
      maxLength: normalization.maxLength,
    };

    // Route through the live Yjs room when a browser session is open so the
    // reply appears in real time and the room's debounced persist won't
    // clobber it. Fall back to a direct sidecar write when no room is active.
    const room = context.roomRegistry?.get?.(meta.vaultPath);
    if (room && !room.isDeleted?.() && room.clients.size > 0) {
      const liveThreads = room.getLiveCommentThreads();
      const threadIndex = liveThreads.findIndex((thread) => thread?.id === target.threadId);
      if (threadIndex < 0) {
        jsonResponse(req, res, 404, { error: 'Comment thread not found' });
        return true;
      }

      const mergedThreads = liveThreads.map((thread, index) => (
        index === threadIndex
          ? { ...thread, messages: [...(thread.messages ?? []), message] }
          : thread
      ));

      const liveContent = room.getLiveContent() ?? '';
      const applyResult = await room.applyExternalContent(liveContent, {
        commentThreads: mergedThreads,
        replaceCommentThreads: true,
      });
      if (!applyResult?.ok) {
        jsonResponse(req, res, 409, {
          error: applyResult?.reason === 'room-unavailable'
            ? 'Review collaboration session became unavailable'
            : 'Failed to apply reply to live session',
          vaultPath: meta.vaultPath,
        });
        return true;
      }

      jsonResponse(req, res, 200, successPayload);
      return true;
    }

    const reservation = await reserveExternalReviewMutation(context, req, res, meta.vaultPath);
    if (!reservation) {
      return true;
    }
    let wrote = false;
    try {
      const rawThreads = await vaultFileStore.readCommentThreads(meta.vaultPath);
      const threadIndex = rawThreads.findIndex((thread) => thread?.id === target.threadId);
      if (threadIndex < 0) {
        jsonResponse(req, res, 404, { error: 'Comment thread not found' });
        return true;
      }

      const updatedThreads = rawThreads.map((thread, index) => (
        index === threadIndex
          ? { ...thread, messages: [...(thread.messages ?? []), message] }
          : thread
      ));

      const writeResult = await vaultFileStore.writeCommentThreads(meta.vaultPath, updatedThreads);
      if (!writeResult.ok) {
        jsonResponse(req, res, 500, { error: writeResult.error || 'Failed to persist reply' });
        return true;
      }
      wrote = true;

      jsonResponse(req, res, 200, successPayload);
    } finally {
      await reservation.release({ refreshFromDisk: wrote });
    }
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to reply to review thread:', 'Failed to reply to review thread');
  }
  return true;
}

const ROUTE_TABLE = [
  { method: 'POST', path: '/api/review', handler: handleReviewCreate },
  { method: 'GET', path: '/api/review/:id', handler: handleReviewRead },
  { method: 'PUT', path: '/api/review/:id', handler: handleReviewUpdate },
  { method: 'POST', path: '/api/review/:id/threads/:threadId/reply', handler: handleReviewReply },
  { method: 'PATCH', path: '/api/review/:id/anchors', handler: handleReviewAnchorMove },
  { method: 'GET', path: '/api/review/:id/wait', handler: handleReviewWait },
  { method: 'POST', path: '/api/review/:id/notify', handler: handleReviewNotify },
  { method: 'GET', path: '/api/review/:id/waiting', handler: handleReviewWaiting },
];

export function createReviewApiHandler({
  reviewStore,
  vaultFileStore,
  roomRegistry = null,
  reviewWaitingState = null,
  basePath = '',
  publicBaseUrl = '',
} = {}) {
  const context = { reviewStore, vaultFileStore, roomRegistry, reviewWaitingState, basePath, publicBaseUrl };

  return async function handleReviewApi(req, res, requestUrl) {
    if (isReviewPostPath(requestUrl.pathname) && req.method === 'POST') {
      return ROUTE_TABLE[0].handler(context, req, res);
    }
    if (isReviewReplyPath(requestUrl.pathname) && req.method === 'POST') {
      return ROUTE_TABLE[3].handler(context, req, res, requestUrl);
    }
    if (isReviewAnchorMovePath(requestUrl.pathname) && req.method === 'PATCH') {
      return ROUTE_TABLE[4].handler(context, req, res, requestUrl);
    }
    if (isReviewWaitPath(requestUrl.pathname) && req.method === 'GET') {
      return ROUTE_TABLE[5].handler(context, req, res, requestUrl);
    }
    if (isReviewNotifyPath(requestUrl.pathname) && req.method === 'POST') {
      return ROUTE_TABLE[6].handler(context, req, res, requestUrl);
    }
    if (isReviewWaitingPath(requestUrl.pathname) && req.method === 'GET') {
      return ROUTE_TABLE[7].handler(context, req, res, requestUrl);
    }
    if (isReviewGetPath(requestUrl.pathname) && req.method === 'GET') {
      return ROUTE_TABLE[1].handler(context, req, res, requestUrl);
    }
    if (isReviewPutPath(requestUrl.pathname) && req.method === 'PUT') {
      return ROUTE_TABLE[2].handler(context, req, res, requestUrl);
    }
    return false;
  };
}
