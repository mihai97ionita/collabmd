import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uiFeatureReviewControlMethods } from '../../src/client/application/app-shell/ui-feature-review-control.js';
import { extractReviewIdFromPath } from '../../src/client/domain/review-paths.js';

describe('uiFeature review control', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function setup() {
    document.body.innerHTML = `
      <button id="reviewRelinquishBtn" class="hidden"></button>
      <button id="reviewNotifyPeekBtn" class="hidden"></button>
      <dialog id="reviewControlOverlay">
        <h2 id="reviewControlTitle"></h2>
        <p id="reviewControlCopy"></p>
        <div class="tab-lock-actions">
          <button id="reviewControlTakeoverBtn">Take control</button>
          <button id="reviewNotifyHandoffBtn" class="hidden">Notify Agent</button>
          <button id="reviewApproveBtn" class="hidden">Approve</button>
          <button id="reviewApproveProceedBtn" class="hidden">Approve & Proceed</button>
          <button id="reviewDenyBtn" class="hidden">Deny</button>
        </div>
      </dialog>
    `;
    const elements = {
      reviewRelinquishButton: document.getElementById('reviewRelinquishBtn'),
      reviewNotifyPeekBtn: document.getElementById('reviewNotifyPeekBtn'),
      reviewNotifyHandoffBtn: document.getElementById('reviewNotifyHandoffBtn'),
      reviewApproveBtn: document.getElementById('reviewApproveBtn'),
      reviewApproveProceedBtn: document.getElementById('reviewApproveProceedBtn'),
      reviewDenyBtn: document.getElementById('reviewDenyBtn'),
      reviewControlCopy: document.getElementById('reviewControlCopy'),
      reviewControlOverlay: document.getElementById('reviewControlOverlay'),
      reviewControlTakeoverButton: document.getElementById('reviewControlTakeoverBtn'),
      reviewControlTitle: document.getElementById('reviewControlTitle'),
    };
    const workspaceRouteController = {
      cleanupSession: vi.fn(),
      handleHashChange: vi.fn(() => Promise.resolve()),
    };
    const toastController = { show: vi.fn() };
    const reviewNotifyClient = {
      fetchReviewWaiting: vi.fn(() => Promise.resolve({ agentWaiting: false })),
      postReviewNotify: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const context = {
      currentFilePath: null,
      isTabActive: true,
      isReviewControlRelinquished: false,
      agentWaiting: false,
      notifyAgentPollTimer: null,
      elements,
      workspaceRouteController,
      toastController,
      reviewNotifyClient,
    };
    Object.assign(context, uiFeatureReviewControlMethods);
    return context;
  }

  it('isReviewFilePath detects review paths under tmp/review/', () => {
    const { isReviewFilePath } = uiFeatureReviewControlMethods;
    expect(isReviewFilePath('tmp/review/abc-12345678.md')).toBe(true);
    expect(isReviewFilePath('tmp/review/proposal-deadbeef.md')).toBe(true);
    expect(isReviewFilePath('README.md')).toBe(false);
    expect(isReviewFilePath(null)).toBe(false);
    expect(isReviewFilePath(undefined)).toBe(false);
    expect(isReviewFilePath('tmp/other/foo.md')).toBe(false);
  });

  it('syncReviewRelinquishButton shows the button for an active review file in editor mode', () => {
    const context = setup();
    context.currentFilePath = 'tmp/review/proposal-deadbeef.md';
    context.syncReviewRelinquishButton({ mode: 'editor' });
    expect(context.elements.reviewRelinquishButton.classList.contains('hidden')).toBe(false);
  });

  it('syncReviewRelinquishButton hides the button for non-review files', () => {
    const context = setup();
    context.currentFilePath = 'README.md';
    context.syncReviewRelinquishButton({ mode: 'editor' });
    expect(context.elements.reviewRelinquishButton.classList.contains('hidden')).toBe(true);
  });

  it('syncReviewRelinquishButton hides the button when tab is inactive', () => {
    const context = setup();
    context.currentFilePath = 'tmp/review/proposal-deadbeef.md';
    context.isTabActive = false;
    context.syncReviewRelinquishButton({ mode: 'editor' });
    expect(context.elements.reviewRelinquishButton.classList.contains('hidden')).toBe(true);
  });

  it('syncReviewRelinquishButton hides the button when control is already relinquished', () => {
    const context = setup();
    context.currentFilePath = 'tmp/review/proposal-deadbeef.md';
    context.isReviewControlRelinquished = true;
    context.syncReviewRelinquishButton({ mode: 'editor' });
    expect(context.elements.reviewRelinquishButton.classList.contains('hidden')).toBe(true);
  });

  it('handleReviewRelinquishControl destroys the session and shows the overlay', () => {
    const context = setup();
    context.currentFilePath = 'tmp/review/proposal-deadbeef.md';
    context.handleReviewRelinquishControl();
    expect(context.workspaceRouteController.cleanupSession).toHaveBeenCalledTimes(1);
    expect(context.isReviewControlRelinquished).toBe(true);
    expect(context.elements.reviewControlOverlay.open).toBe(true);
    expect(context.elements.reviewRelinquishButton.classList.contains('hidden')).toBe(true);
    expect(context.toastController.show).toHaveBeenCalled();
  });

  it('handleReviewRelinquishControl is a no-op for non-review files', () => {
    const context = setup();
    context.currentFilePath = 'README.md';
    context.handleReviewRelinquishControl();
    expect(context.workspaceRouteController.cleanupSession).not.toHaveBeenCalled();
    expect(context.elements.reviewControlOverlay.open).toBe(false);
  });

  it('handleReviewTakeControl hides the overlay and re-opens the file', () => {
    const context = setup();
    context.currentFilePath = 'tmp/review/proposal-deadbeef.md';
    context.handleReviewRelinquishControl();
    expect(context.elements.reviewControlOverlay.open).toBe(true);

    context.handleReviewTakeControl();
    expect(context.elements.reviewControlOverlay.open).toBe(false);
    expect(context.isReviewControlRelinquished).toBe(false);
    expect(context.workspaceRouteController.handleHashChange).toHaveBeenCalledTimes(1);
  });

  it('showReviewControlOverlay closes other open dialogs first', () => {
    document.body.innerHTML = `
      <dialog id="otherDialog" open></dialog>
      <dialog id="reviewControlOverlay">
        <button id="reviewControlTakeoverBtn"></button>
      </dialog>
    `;
    const context = {
      elements: {
        reviewControlOverlay: document.getElementById('reviewControlOverlay'),
        reviewControlTakeoverButton: document.getElementById('reviewControlTakeoverBtn'),
      },
    };
    Object.assign(context, uiFeatureReviewControlMethods);
    const otherDialog = document.getElementById('otherDialog');
    expect(otherDialog.open).toBe(true);

    context.showReviewControlOverlay();
    expect(otherDialog.open).toBe(false);
    expect(context.elements.reviewControlOverlay.open).toBe(true);
    expect(document.activeElement).toBe(context.elements.reviewControlTakeoverButton);
  });

  describe('extractReviewIdFromPath', () => {
    it('returns the full uuid for a review path with slug-uuid.md', () => {
      expect(extractReviewIdFromPath('tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md'))
        .toBe('12345678-1234-1234-1234-123456789abc');
    });

    it('returns null for a non-review path', () => {
      expect(extractReviewIdFromPath('README.md')).toBeNull();
    });

    it('returns null for a review path without a full uuid', () => {
      expect(extractReviewIdFromPath('tmp/review/proposal-deadbeef.md')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(extractReviewIdFromPath(null)).toBeNull();
      expect(extractReviewIdFromPath(undefined)).toBeNull();
      expect(extractReviewIdFromPath('')).toBeNull();
    });
  });

  describe('syncNotifyAgentButtons', () => {
    it('hides both buttons when agentWaiting is false', () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.agentWaiting = false;
      context.syncNotifyAgentButtons({ mode: 'editor' });
      expect(context.elements.reviewNotifyPeekBtn.classList.contains('hidden')).toBe(true);
      expect(context.elements.reviewNotifyHandoffBtn.classList.contains('hidden')).toBe(true);
    });

    it('shows the peek button when agentWaiting is true, tab active, review file, editor mode', () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.agentWaiting = true;
      context.syncNotifyAgentButtons({ mode: 'editor' });
      expect(context.elements.reviewNotifyPeekBtn.classList.contains('hidden')).toBe(false);
      expect(context.elements.reviewNotifyHandoffBtn.classList.contains('hidden')).toBe(false);
    });

    it('hides the peek button when the tab is inactive even if agentWaiting is true', () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.agentWaiting = true;
      context.isTabActive = false;
      context.syncNotifyAgentButtons({ mode: 'editor' });
      expect(context.elements.reviewNotifyPeekBtn.classList.contains('hidden')).toBe(true);
    });

    it('hides the peek button for non-review files even if agentWaiting is true', () => {
      const context = setup();
      context.currentFilePath = 'README.md';
      context.agentWaiting = true;
      context.syncNotifyAgentButtons({ mode: 'editor' });
      expect(context.elements.reviewNotifyPeekBtn.classList.contains('hidden')).toBe(true);
    });

    it('hides the peek button in preview mode', () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.agentWaiting = true;
      context.syncNotifyAgentButtons({ mode: 'preview' });
      expect(context.elements.reviewNotifyPeekBtn.classList.contains('hidden')).toBe(true);
    });

    it('shows approve/deny buttons when agentWaiting is true', () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.agentWaiting = true;
      context.syncNotifyAgentButtons({ mode: 'editor' });
      expect(context.elements.reviewApproveBtn.classList.contains('hidden')).toBe(false);
      expect(context.elements.reviewApproveProceedBtn.classList.contains('hidden')).toBe(false);
      expect(context.elements.reviewDenyBtn.classList.contains('hidden')).toBe(false);
    });

    it('hides approve/deny buttons when agentWaiting is false', () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.agentWaiting = false;
      context.syncNotifyAgentButtons({ mode: 'editor' });
      expect(context.elements.reviewApproveBtn.classList.contains('hidden')).toBe(true);
      expect(context.elements.reviewApproveProceedBtn.classList.contains('hidden')).toBe(true);
      expect(context.elements.reviewDenyBtn.classList.contains('hidden')).toBe(true);
    });
  });

  describe('handleReviewNotifyPeek', () => {
    it('calls postReviewNotify with peek and does NOT call cleanupSession', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      await context.handleReviewNotifyPeek();
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        'peek',
      );
      expect(context.workspaceRouteController.cleanupSession).not.toHaveBeenCalled();
      expect(context.toastController.show).toHaveBeenCalled();
    });

    it('is a no-op for non-review files', async () => {
      const context = setup();
      context.currentFilePath = 'README.md';
      await context.handleReviewNotifyPeek();
      expect(context.reviewNotifyClient.postReviewNotify).not.toHaveBeenCalled();
    });
  });

  describe('handleReviewNotifyHandoff', () => {
    it('calls cleanupSession THEN postReviewNotify with handoff', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      const callOrder = [];
      context.workspaceRouteController.cleanupSession.mockImplementation(() => {
        callOrder.push('cleanup');
      });
      context.reviewNotifyClient.postReviewNotify.mockImplementation(() => {
        callOrder.push('notify');
        return Promise.resolve({ ok: true });
      });

      await context.handleReviewNotifyHandoff();

      expect(callOrder).toEqual(['cleanup', 'notify']);
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        'handoff',
      );
      expect(context.isReviewControlRelinquished).toBe(true);
      expect(context.elements.reviewControlOverlay.open).toBe(true);
    });

    it('is a no-op for non-review files', async () => {
      const context = setup();
      context.currentFilePath = 'README.md';
      await context.handleReviewNotifyHandoff();
      expect(context.workspaceRouteController.cleanupSession).not.toHaveBeenCalled();
      expect(context.reviewNotifyClient.postReviewNotify).not.toHaveBeenCalled();
    });

    it('works even when isReviewControlRelinquished is already true (Relinquish Control was clicked first)', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.isReviewControlRelinquished = true; // Relinquish Control already ran
      context.reviewNotifyClient.postReviewNotify.mockImplementation(() => {
        return Promise.resolve({ ok: true });
      });

      await context.handleReviewNotifyHandoff();

      // The handoff notify MUST fire — the guard is reviewHandoffNotifySent,
      // not isReviewControlRelinquished, so the legitimate click goes through.
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        'handoff',
      );
      expect(context.reviewHandoffNotifySent).toBe(true);
    });

    it('guards against a double-click firing a second handoff notify', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.reviewNotifyClient.postReviewNotify.mockImplementation(() => {
        return Promise.resolve({ ok: true });
      });

      await context.handleReviewNotifyHandoff();
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledTimes(1);

      // Second click must be a no-op — the flag was set on the first send.
      await context.handleReviewNotifyHandoff();
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledTimes(1);
    });

    it('retries when the first notify fails (clears the guard on error)', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      let shouldFail = true;
      context.reviewNotifyClient.postReviewNotify.mockImplementation(() => {
        if (shouldFail) {
          shouldFail = false;
          return Promise.reject(new Error('network down'));
        }
        return Promise.resolve({ ok: true });
      });

      await context.handleReviewNotifyHandoff();
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledTimes(1);
      expect(context.reviewHandoffNotifySent).toBe(false); // cleared on error
      expect(context.toastController.show).toHaveBeenCalledWith('Failed to notify the agent');

      // Retry succeeds — the guard was cleared so the click is not blocked.
      await context.handleReviewNotifyHandoff();
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledTimes(2);
      expect(context.reviewHandoffNotifySent).toBe(true);
    });
  });

  describe('handleReviewApprove', () => {
    it('calls cleanupSession THEN postReviewNotify with approve, canProceed: false', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      const callOrder = [];
      context.workspaceRouteController.cleanupSession.mockImplementation(() => {
        callOrder.push('cleanup');
      });
      context.reviewNotifyClient.postReviewNotify.mockImplementation(() => {
        callOrder.push('notify');
        return Promise.resolve({ ok: true });
      });

      await context.handleReviewApprove();

      expect(callOrder).toEqual(['cleanup', 'notify']);
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        'approve',
        false,
      );
      expect(context.isReviewControlRelinquished).toBe(true);
      expect(context.elements.reviewControlOverlay.open).toBe(false);
      expect(context.reviewHandoffNotifySent).toBe(true);
    });

    it('is a no-op for non-review files', async () => {
      const context = setup();
      context.currentFilePath = 'README.md';
      await context.handleReviewApprove();
      expect(context.workspaceRouteController.cleanupSession).not.toHaveBeenCalled();
      expect(context.reviewNotifyClient.postReviewNotify).not.toHaveBeenCalled();
    });

    it('guards against a double-click firing a second approve notify', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.reviewNotifyClient.postReviewNotify.mockImplementation(() => {
        return Promise.resolve({ ok: true });
      });

      await context.handleReviewApprove();
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledTimes(1);

      // Second click must be a no-op — the flag was set on the first send.
      await context.handleReviewApprove();
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleReviewApproveProceed', () => {
    it('calls cleanupSession THEN postReviewNotify with approve, canProceed: true', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      const callOrder = [];
      context.workspaceRouteController.cleanupSession.mockImplementation(() => {
        callOrder.push('cleanup');
      });
      context.reviewNotifyClient.postReviewNotify.mockImplementation(() => {
        callOrder.push('notify');
        return Promise.resolve({ ok: true });
      });

      await context.handleReviewApproveProceed();

      expect(callOrder).toEqual(['cleanup', 'notify']);
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        'approve',
        true,
      );
      expect(context.isReviewControlRelinquished).toBe(true);
      expect(context.reviewHandoffNotifySent).toBe(true);
    });

    it('is a no-op for non-review files', async () => {
      const context = setup();
      context.currentFilePath = 'README.md';
      await context.handleReviewApproveProceed();
      expect(context.workspaceRouteController.cleanupSession).not.toHaveBeenCalled();
      expect(context.reviewNotifyClient.postReviewNotify).not.toHaveBeenCalled();
    });
  });

  describe('handleReviewDeny', () => {
    it('calls cleanupSession THEN postReviewNotify with deny', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      const callOrder = [];
      context.workspaceRouteController.cleanupSession.mockImplementation(() => {
        callOrder.push('cleanup');
      });
      context.reviewNotifyClient.postReviewNotify.mockImplementation(() => {
        callOrder.push('notify');
        return Promise.resolve({ ok: true });
      });

      await context.handleReviewDeny();

      expect(callOrder).toEqual(['cleanup', 'notify']);
      expect(context.reviewNotifyClient.postReviewNotify).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        'deny',
        false,
      );
      expect(context.isReviewControlRelinquished).toBe(true);
      expect(context.reviewHandoffNotifySent).toBe(true);
    });

    it('is a no-op for non-review files', async () => {
      const context = setup();
      context.currentFilePath = 'README.md';
      await context.handleReviewDeny();
      expect(context.workspaceRouteController.cleanupSession).not.toHaveBeenCalled();
      expect(context.reviewNotifyClient.postReviewNotify).not.toHaveBeenCalled();
    });
  });

  describe('notify agent polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('startNotifyAgentPolling starts an interval that polls fetchReviewWaiting', async () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.reviewNotifyClient.fetchReviewWaiting.mockImplementation(() => {
        // First poll flips agentWaiting false -> true, so syncNotifyAgentButtons runs.
        return Promise.resolve({ agentWaiting: true });
      });

      context.startNotifyAgentPolling();
      expect(context.notifyAgentPollTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(3000);
      expect(context.reviewNotifyClient.fetchReviewWaiting).toHaveBeenCalledTimes(1);
      expect(context.agentWaiting).toBe(true);
      expect(context.elements.reviewNotifyPeekBtn.classList.contains('hidden')).toBe(false);

      context.stopNotifyAgentPolling();
      expect(context.notifyAgentPollTimer).toBeNull();
    });

    it('startNotifyAgentPolling is idempotent and does not start a second interval', () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.startNotifyAgentPolling();
      const firstTimer = context.notifyAgentPollTimer;
      context.startNotifyAgentPolling();
      expect(context.notifyAgentPollTimer).toBe(firstTimer);
      context.stopNotifyAgentPolling();
    });

    it('stopNotifyAgentPolling is safe to call when not running', () => {
      const context = setup();
      expect(() => context.stopNotifyAgentPolling()).not.toThrow();
      expect(context.notifyAgentPollTimer).toBeNull();
    });

    it('stopNotifyAgentPolling resets agentWaiting and hides buttons', () => {
      const context = setup();
      context.currentFilePath = 'tmp/review/proposal-12345678-1234-1234-1234-123456789abc.md';
      context.agentWaiting = true;
      context.elements.reviewNotifyPeekBtn.classList.remove('hidden');
      context.notifyAgentPollTimer = 12345;
      context.stopNotifyAgentPolling();
      expect(context.agentWaiting).toBe(false);
      expect(context.notifyAgentPollTimer).toBeNull();
      expect(context.elements.reviewNotifyPeekBtn.classList.contains('hidden')).toBe(true);
    });
  });
});
