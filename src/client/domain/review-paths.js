/**
 * Pure helpers for review file paths (tmp/review/<slug>-<uuid>.md).
 * No imports, no side effects — belongs in the client domain layer.
 */

const REVIEW_UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;

/**
 * Extracts the full uuid from a review file path of the form
 * `tmp/review/<slug>-<uuid>.md`. Returns `null` for non-review paths,
 * non-string input, or paths without a trailing `<uuid>.md` segment.
 *
 * @param {string | null | undefined} vaultPath
 * @returns {string | null}
 */
export function extractReviewIdFromPath(vaultPath) {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    return null;
  }

  const match = vaultPath.match(REVIEW_UUID_PATTERN);
  return match ? match[1] : null;
}
