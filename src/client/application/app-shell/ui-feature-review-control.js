/**
 * Review session control: lets a human relinquish the live collaboration
 * session on a review file (tmp/review/<uuid>.md) so an AI agent can PUT a
 * new proposal via the review API, then take control again to re-open the
 * file. Reuses the tab-lock overlay visual style for a consistent "blurred
 * background, take control" experience.
 *
 * Also owns the "Notify Agent" buttons (peek + handoff): the human can ping
 * an agent that is currently waiting on `/api/review/<id>/wait`. The buttons
 * render only while `agentWaiting` is true (polled from `/waiting`), so no
 * agent-facing actions are shown when no agent is waiting.
 *
 * @typedef {object} UiReviewControlContext
 * @property {string | null} currentFilePath
 * @property {boolean} isTabActive
 * @property {boolean} [isReviewControlRelinquished]
 * @property {boolean} [agentWaiting]
 * @property {number | null} [notifyAgentPollTimer]
 * @property {{ reviewRelinquishButton?: HTMLElement | null, reviewControlOverlay?: HTMLDialogElement | null, reviewControlTakeoverButton?: HTMLElement | null, reviewControlTitle?: HTMLElement | null, reviewControlCopy?: HTMLElement | null, reviewNotifyPeekBtn?: HTMLElement | null, reviewNotifyHandoffBtn?: HTMLElement | null }} elements
 * @property {{ cleanupSession(): void, handleHashChange(): Promise<void> }} workspaceRouteController
 * @property {{ show(message: string): void }} toastController
 * @property {{ fetchReviewWaiting(reviewId: string): Promise<{ agentWaiting: boolean }>, postReviewNotify(reviewId: string, mode: 'peek' | 'handoff'): Promise<{ ok: boolean }> }} [reviewNotifyClient]
 */

import { extractReviewIdFromPath } from '../../domain/review-paths.js';

const REVIEW_PATH_PREFIX = 'tmp/review/';
const NOTIFY_AGENT_POLL_INTERVAL_MS = 3000;

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
  this.reviewHandoffNotifySent = false;
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

/**
 * Shows/hides the peek and handoff entry buttons. Buttons render ONLY when
 * an agent is waiting (`agentWaiting === true`), the tab is active, the
 * current file is a review file, and the view mode is `editor`. When hidden,
 * the overlay's handoff button is also hidden so a stale overlay cannot fire
 * a handoff.
 *
 * @this {UiReviewControlContext}
 */
function syncNotifyAgentButtons({
  filePath = this.currentFilePath,
  mode = 'editor',
} = {}) {
  const peekButton = this.elements?.reviewNotifyPeekBtn;
  const handoffButton = this.elements?.reviewNotifyHandoffBtn;

  const shouldShow = Boolean(
    this.isTabActive
    && mode === 'editor'
    && isReviewFilePath(filePath)
    && this.agentWaiting === true,
  );

  peekButton?.classList.toggle('hidden', !shouldShow);
  // The handoff button lives inside the relinquish overlay. Only reveal it
  // when an agent is actually waiting; otherwise hide it even if the overlay
  // were shown, so the human sees no agent-facing action to confirm.
  handoffButton?.classList.toggle('hidden', !shouldShow);
}

/**
 * Fires a `peek` notify. The human keeps control of the live session —
 * `cleanupSession` is NOT called. The agent wakes, sees `canEdit: false`,
 * and stays in review-only mode.
 *
 * @this {UiReviewControlContext}
 */
async function handleReviewNotifyPeek() {
  if (!this.isTabActive) {
    return;
  }

  const reviewId = extractReviewIdFromPath(this.currentFilePath);
  if (!reviewId) {
    return;
  }

  try {
    await this.reviewNotifyClient?.postReviewNotify(reviewId, 'peek');
    this.toastController?.show('Notified the agent (peek) — review-only');
  } catch (error) {
    console.error('[review-control] peek notify failed:', error);
    this.toastController?.show('Failed to notify the agent');
  }
}

/**
 * Fires a `handoff` notify. Two-step: FIRST release the live collaboration
 * session (`cleanupSession`) so the server-side room empties and the agent's
 * PUT will succeed, mark relinquished, THEN POST the notify. The agent wakes
 * with `canEdit: true`.
 *
 * @this {UiReviewControlContext}
 */
async function handleReviewNotifyHandoff() {
  if (!this.isTabActive) {
    return;
  }

  // L1: guard against a rapid double-click firing a second handoff notify
  // (the second would re-set pendingNotify and the agent's next wait would
  // consume a stale handoff). NOTE: isReviewControlRelinquished is NOT the
  // right guard here — it is set by handleReviewRelinquishControl (the click
  // that opens this overlay), so it would block the legitimate handoff click.
  // Use a dedicated flag that only flips when the handoff notify is sent.
  if (this.reviewHandoffNotifySent) {
    return;
  }

  const reviewId = extractReviewIdFromPath(this.currentFilePath);
  if (!reviewId) {
    return;
  }

  // Step 1: release the live session so the agent's PUT is unblocked.
  // (If the user came through Relinquish Control first, cleanupSession was
  // already called and isReviewControlRelinquished is already true — that's
  // fine, cleanupSession is idempotent and the flag is already set.)
  this.workspaceRouteController?.cleanupSession?.();
  this.isReviewControlRelinquished = true;
  this.syncReviewRelinquishButton({ filePath: this.currentFilePath, mode: 'editor' });
  this.showReviewControlOverlay();

  // Step 2: tell the agent it can take over.
  this.reviewHandoffNotifySent = true;
  try {
    await this.reviewNotifyClient?.postReviewNotify(reviewId, 'handoff');
    this.toastController?.show('Notified the agent — handoff. You can close this tab.');
  } catch (error) {
    // Notify failed — clear the flag so the user can retry by clicking again.
    this.reviewHandoffNotifySent = false;
    console.error('[review-control] handoff notify failed:', error);
    this.toastController?.show('Failed to notify the agent');
    return;
  }

  // L2: the human is done; stop polling and hide the toolbar peek button so the
  // agent-owned session does not offer notify actions.
  this.stopNotifyAgentPolling?.();
  this.syncNotifyAgentButtons({ filePath: this.currentFilePath, mode: 'editor' });
}

/**
 * Begins polling `/api/review/<id>/waiting` every
 * `NOTIFY_AGENT_POLL_INTERVAL_MS` and updates `this.agentWaiting` + button
 * visibility. Idempotent — safe to call when already running.
 *
 * @this {UiReviewControlContext}
 */
function startNotifyAgentPolling() {
  if (this.notifyAgentPollTimer) {
    return;
  }

  const tick = async () => {
    const reviewId = extractReviewIdFromPath(this.currentFilePath);
    if (!reviewId || !this.isTabActive) {
      return;
    }

    // M1: capture the poll generation so a tick whose fetch resolves after
    // stopNotifyAgentPolling (or a file switch) cannot flip agentWaiting back
    // and re-show buttons on the wrong file.
    const token = this.notifyAgentPollTimer;
    try {
      const result = await this.reviewNotifyClient?.fetchReviewWaiting(reviewId);
      if (token !== this.notifyAgentPollTimer) {
        return;
      }
      if (extractReviewIdFromPath(this.currentFilePath) !== reviewId) {
        return;
      }
      const nextWaiting = Boolean(result?.agentWaiting);
      if (this.agentWaiting !== nextWaiting) {
        this.agentWaiting = nextWaiting;
        this.syncNotifyAgentButtons({ filePath: this.currentFilePath, mode: 'editor' });
      }
    } catch (error) {
      console.error('[review-control] waiting poll failed:', error);
    }
  };

  this.notifyAgentPollTimer = setInterval(() => {
    void tick();
  }, NOTIFY_AGENT_POLL_INTERVAL_MS);
}

/**
 * Stops the waiting poll. Safe to call when not running.
 *
 * @this {UiReviewControlContext}
 */
function stopNotifyAgentPolling() {
  if (this.notifyAgentPollTimer) {
    clearInterval(this.notifyAgentPollTimer);
    this.notifyAgentPollTimer = null;
  }
  if (this.agentWaiting) {
    this.agentWaiting = false;
    this.syncNotifyAgentButtons?.({ filePath: this.currentFilePath, mode: 'editor' });
  }
}

export const uiFeatureReviewControlMethods = {
  handleReviewNotifyHandoff,
  handleReviewNotifyPeek,
  handleReviewRelinquishControl,
  handleReviewTakeControl,
  hideReviewControlOverlay,
  isReviewFilePath,
  showReviewControlOverlay,
  startNotifyAgentPolling,
  stopNotifyAgentPolling,
  syncNotifyAgentButtons,
  syncReviewRelinquishButton,
};
