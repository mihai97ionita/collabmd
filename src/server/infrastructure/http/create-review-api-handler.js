import { createCommentId, normalizeCommentBody, serializeCommentThreads } from '../../../domain/comment-threads.js';
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
      secret: result.secret,
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

    const providedSecret = requestUrl.searchParams.get('secret') || req.headers['x-review-secret'];
    if (typeof providedSecret !== 'string' || providedSecret !== meta.secret) {
      jsonResponse(req, res, 403, { error: 'Invalid review secret' });
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
    const markdown = serializeReviewToMarkdown({
      proposalMarkdown,
      threads: serialized,
      includeResolved,
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

    const providedSecret = requestUrl.searchParams.get('secret') || req.headers['x-review-secret'];
    if (typeof providedSecret !== 'string' || providedSecret !== meta.secret) {
      jsonResponse(req, res, 403, { error: 'Invalid review secret' });
      return true;
    }

    if (hasActiveCollaborationSession(context.roomRegistry, meta.vaultPath)) {
      jsonResponse(req, res, 409, {
        error: 'Review file is open in a browser collaboration session',
        vaultPath: meta.vaultPath,
      });
      return true;
    }

    const body = await parseJsonBody(req, REVIEW_REQUEST_LIMIT_BYTES);
    if (!body || typeof body.markdown !== 'string' || body.markdown.trim() === '') {
      jsonResponse(req, res, 422, { error: 'Missing or empty "markdown" in request body' });
      return true;
    }

    const result = await reviewStore.writeProposal(reviewId, body.markdown);
    if (!result.ok) {
      jsonResponse(req, res, result.status ?? 500, { error: result.error || 'Failed to update review' });
      return true;
    }

    jsonResponse(req, res, 200, {
      ok: true,
      vaultPath: result.vaultPath,
      updatedAt: result.updatedAt,
    });
  } catch (error) {
    handleApiError(req, res, error, '[api] Failed to update review:', 'Failed to update review');
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

    const providedSecret = requestUrl.searchParams.get('secret') || req.headers['x-review-secret'];
    if (typeof providedSecret !== 'string' || providedSecret !== meta.secret) {
      jsonResponse(req, res, 403, { error: 'Invalid review secret' });
      return true;
    }

    const body = await parseJsonBody(req, REVIEW_REQUEST_LIMIT_BYTES);
    const normalizedBody = normalizeCommentBody(body?.body);
    if (!normalizedBody) {
      jsonResponse(req, res, 422, { error: 'Missing or empty "body" in request body' });
      return true;
    }

    const message = {
      actorType: 'agent',
      body: normalizedBody,
      createdAt: Date.now(),
      editedAt: null,
      id: createCommentId('comment'),
      peerId: '',
      reactions: [],
      userColor: '',
      userId: '',
      userName: AGENT_USER_NAME,
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

      jsonResponse(req, res, 200, {
        ok: true,
        messageId: message.id,
        threadId: target.threadId,
      });
      return true;
    }

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

    jsonResponse(req, res, 200, {
      ok: true,
      messageId: message.id,
      threadId: target.threadId,
    });
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
];

export function createReviewApiHandler({
  reviewStore,
  vaultFileStore,
  roomRegistry = null,
  basePath = '',
  publicBaseUrl = '',
} = {}) {
  const context = { reviewStore, vaultFileStore, roomRegistry, basePath, publicBaseUrl };

  return async function handleReviewApi(req, res, requestUrl) {
    if (isReviewPostPath(requestUrl.pathname) && req.method === 'POST') {
      return ROUTE_TABLE[0].handler(context, req, res);
    }
    if (isReviewReplyPath(requestUrl.pathname) && req.method === 'POST') {
      return ROUTE_TABLE[3].handler(context, req, res, requestUrl);
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
