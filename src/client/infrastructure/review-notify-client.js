import { resolveApiUrl } from '../domain/runtime-paths.js';
import { parseApiResponse } from './api-client-utils.js';

/**
 * Thin HTTP client for the review wait/notify endpoints.
 * Keeps fetch out of the application-layer review control feature.
 */

function buildReviewPath(reviewId, suffix) {
  return `/review/${encodeURIComponent(reviewId)}${suffix}`;
}

/**
 * GET /api/review/<id>/waiting → `{ agentWaiting: boolean }`.
 *
 * @param {string} reviewId
 * @returns {Promise<{ agentWaiting: boolean }>}
 */
export async function fetchReviewWaiting(reviewId) {
  const response = await fetch(resolveApiUrl(buildReviewPath(reviewId, '/waiting')));
  const data = await parseApiResponse(response, 'Failed to read review waiting state');
  return { agentWaiting: Boolean(data?.agentWaiting) };
}

/**
 * POST /api/review/<id>/notify with `{ mode, canProceed }` → `{ ok: boolean }`.
 *
 * @param {string} reviewId
 * @param {'peek' | 'handoff' | 'approve' | 'deny'} mode
 * @param {boolean} [canProceed=false] — only meaningful for "approve"
 * @returns {Promise<{ ok: boolean }>}
 */
export async function postReviewNotify(reviewId, mode, canProceed = false) {
  const response = await fetch(resolveApiUrl(buildReviewPath(reviewId, '/notify')), {
    body: JSON.stringify({ mode, canProceed }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const data = await parseApiResponse(response, 'Failed to notify review');
  return { ok: Boolean(data?.ok) };
}
