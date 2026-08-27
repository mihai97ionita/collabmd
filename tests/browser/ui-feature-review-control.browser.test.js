import { afterEach, describe, expect, it, vi } from 'vitest';

import { uiFeatureReviewControlMethods } from '../../src/client/application/app-shell/ui-feature-review-control.js';

describe('uiFeature review control', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function setup() {
    document.body.innerHTML = `
      <button id="reviewRelinquishBtn" class="hidden"></button>
      <dialog id="reviewControlOverlay">
        <h2 id="reviewControlTitle"></h2>
        <p id="reviewControlCopy"></p>
        <button id="reviewControlTakeoverBtn">Take control</button>
      </dialog>
    `;
    const elements = {
      reviewRelinquishButton: document.getElementById('reviewRelinquishBtn'),
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
    const context = {
      currentFilePath: null,
      isTabActive: true,
      isReviewControlRelinquished: false,
      elements,
      workspaceRouteController,
      toastController,
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
});
