/**
 * Review session control: lets a human relinquish the live collaboration
 * session on a review file (tmp/review/<uuid>.md) so an AI agent can PUT a
 * new proposal via the review API, then take control again to re-open the
 * file. Reuses the tab-lock overlay visual style for a consistent "blurred
 * background, take control" experience.
 *
 * @typedef {object} UiReviewControlContext
 * @property {string | null} currentFilePath
 * @property {boolean} isTabActive
 * @property {boolean} [isReviewControlRelinquished]
 * @property {{ reviewRelinquishButton?: HTMLElement | null, reviewControlOverlay?: HTMLDialogElement | null, reviewControlTakeoverButton?: HTMLElement | null, reviewControlTitle?: HTMLElement | null, reviewControlCopy?: HTMLElement | null }} elements
 * @property {{ cleanupSession(): void, handleHashChange(): Promise<void> }} workspaceRouteController
 * @property {{ show(message: string): void }} toastController
 */

const REVIEW_PATH_PREFIX = 'tmp/review/';

export function isReviewFilePath(filePath) {
  return typeof filePath === 'string' && filePath.startsWith(REVIEW_PATH_PREFIX);
}

/** @this {UiReviewControlContext} */
function syncReviewRelinquishButton({
  filePath = this.currentFilePath,
  mode = 'editor',
} = {}) {
  const button = this.elements?.reviewRelinquishButton;
  if (!button) {
    return;
  }

  const shouldShow = Boolean(
    this.isTabActive
    && !this.isReviewControlRelinquished
    && mode === 'editor'
    && isReviewFilePath(filePath),
  );

  button.classList.toggle('hidden', !shouldShow);
}

/** @this {UiReviewControlContext} */
function handleReviewRelinquishControl() {
  if (!this.isTabActive) {
    return;
  }

  const filePath = this.currentFilePath;
  if (!isReviewFilePath(filePath)) {
    return;
  }

  // Destroy the per-file Yjs collaboration session so the server-side room
  // drops to zero clients — that unblocks PUT /api/review/<id>.
  this.workspaceRouteController?.cleanupSession?.();
  this.isReviewControlRelinquished = true;
  this.syncReviewRelinquishButton({ filePath, mode: 'editor' });
  this.showReviewControlOverlay();
  this.toastController?.show('Relinquished control — the AI agent can now edit this file');
}

/** @this {UiReviewControlContext} */
function handleReviewTakeControl() {
  this.hideReviewControlOverlay();
  this.isReviewControlRelinquished = false;
  this.syncReviewRelinquishButton({ mode: 'editor' });
  // Re-open the file from the hash route, recreating the collaboration session.
  void this.workspaceRouteController?.handleHashChange?.();
  this.toastController?.show('You have taken control again');
}

/** @this {UiReviewControlContext} */
function showReviewControlOverlay() {
  const overlay = this.elements?.reviewControlOverlay;
  if (!overlay) {
    return;
  }

  document.dispatchEvent(new Event('collabmd:close-custom-modals'));
  document.querySelectorAll('dialog[open]').forEach((dialog) => {
    if (dialog !== overlay) dialog.close();
  });

  if (!overlay.open) {
    this.reviewControlPreviouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    overlay.showModal();
  }
  this.elements?.reviewControlTakeoverButton?.focus();
}

/** @this {UiReviewControlContext} */
function hideReviewControlOverlay() {
  if (this.elements?.reviewControlOverlay?.open) {
    this.elements.reviewControlOverlay.close();
  }
  this.reviewControlPreviouslyFocusedElement?.focus?.();
  this.reviewControlPreviouslyFocusedElement = null;
}

export const uiFeatureReviewControlMethods = {
  handleReviewRelinquishControl,
  handleReviewTakeControl,
  hideReviewControlOverlay,
  isReviewFilePath,
  showReviewControlOverlay,
  syncReviewRelinquishButton,
};
