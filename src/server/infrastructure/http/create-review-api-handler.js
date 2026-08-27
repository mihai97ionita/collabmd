import { serializeCommentThreads } from '../../../domain/comment-threads.js';
import { serializeReviewToMarkdown } from '../../../domain/review-markdown-serializer.js';
import { handleApiError } from './http-request-helpers.js';
import { jsonResponse, sendResponse } from './http-response.js';
import { parseJsonBody, REQUEST_BODY_LIMIT_BYTES } from './request-body.js';

const REVIEW_REQUEST_LIMIT_BYTES = REQUEST_BODY_LIMIT_BYTES;
const TEXT_MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';

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

function isReviewPostPath(pathname) {
  return pathname === '/api/review';
}

function isReviewGetPath(pathname) {
  return pathname.startsWith('/api/review/');
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
    const serialized = serializeCommentThreads(rawThreads);
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

const ROUTE_TABLE = [
  { method: 'POST', path: '/api/review', handler: handleReviewCreate },
  { method: 'GET', path: '/api/review/:id', handler: handleReviewRead },
];

export function createReviewApiHandler({ reviewStore, vaultFileStore, basePath = '', publicBaseUrl = '' } = {}) {
  const context = { reviewStore, vaultFileStore, basePath, publicBaseUrl };

  return async function handleReviewApi(req, res, requestUrl) {
    if (isReviewPostPath(requestUrl.pathname) && req.method === 'POST') {
      return ROUTE_TABLE[0].handler(context, req, res);
    }
    if (isReviewGetPath(requestUrl.pathname) && req.method === 'GET') {
      return ROUTE_TABLE[1].handler(context, req, res, requestUrl);
    }
    return false;
  };
}
