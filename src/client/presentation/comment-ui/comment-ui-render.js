import {
  createCommentOverviewThread,
  formatAnchorLabel,
  getLatestGroupMessage,
  getReactionAccentColor,
} from './comment-ui-shared.js';

/**
 * @typedef {object} CommentUiRenderContext
 * @property {boolean} supported
 * @property {boolean} drawerOpen
 * @property {Array<any>} threads
 * @property {any} session
 * @property {any} activeCard
 * @property {HTMLElement | null} commentSelectionButton
 * @property {HTMLElement | null} commentsToggleButton
 * @property {HTMLElement | null} commentsDrawer
 * @property {HTMLElement | null} commentsDrawerList
 * @property {HTMLElement | null} commentsDrawerEmpty
 * @property {HTMLElement | null} cardRoot
 * @property {{ matches: boolean }} mobileBreakpointQuery
 * @property {HTMLElement | null} pendingCardFocusElement
 * @property {any} reactionPicker
 * @property {() => Array<any>} getThreadGroups
 * @property {() => void} renderToolbar
 * @property {() => void} renderDrawer
 * @property {() => void} renderCard
 * @property {() => void} scheduleLayoutRefresh
 * @property {(value: number) => string} formatTimestamp
 * @property {(group: any, options: { anchor: any, origin: string, sourceRect: DOMRect }) => void} openThreadGroup
 */

/** @this {CommentUiRenderContext} */
function render() {
  this.renderToolbar();
  this.renderDrawer();
  this.renderCard();
  this.scheduleLayoutRefresh();
}

/** @this {CommentUiRenderContext} */
function renderToolbar() {
  const totalCount = this.threads.length;
  const showControls = this.supported && Boolean(this.session);
  this.commentSelectionButton?.classList.toggle('hidden', !showControls);
  this.commentsToggleButton?.classList.toggle('hidden', !this.supported);
  if (this.commentSelectionButton) {
    this.commentSelectionButton.disabled = !this.selectionAnchor;
  }
  if (this.commentsToggleButton) {
    this.commentsToggleButton.classList.toggle('active', this.drawerOpen);
    this.commentsToggleButton.setAttribute('aria-expanded', String(this.drawerOpen));
    const label = totalCount > 0 ? `Comments ${totalCount}` : 'Comments';
    const labelElement = this.commentsToggleButton.querySelector('.ui-action-label');
    if (labelElement) {
      labelElement.textContent = label;
    } else {
      this.commentsToggleButton.textContent = label;
    }
  }
}

/** @this {CommentUiRenderContext} */
function renderDrawer() {
  if (!this.commentsDrawer || !this.commentsDrawerList) {
    return;
  }

  this.commentsDrawer.classList.toggle('hidden', !this.supported || !this.drawerOpen);
  if (!this.supported || !this.drawerOpen) {
    return;
  }

  this.commentsDrawerList.replaceChildren();
  const groups = this.getThreadGroups();
  this.commentsDrawerEmpty?.classList.toggle('hidden', groups.length > 0);
  if (groups.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();
  groups.forEach((group) => {
    const latestMessage = getLatestGroupMessage(group);
    const messageCount = group.threads.reduce(
      (count, thread) => count + (Array.isArray(thread.messages) ? thread.messages.length : 0),
      0,
    );
    const button = createCommentOverviewThread({
      authorName: latestMessage?.userName || group.threads[0]?.createdByName || 'Anonymous',
      buttonClassName: 'comment-overview-thread comments-drawer-item',
      footerClassName: 'comment-overview-thread-footer comments-drawer-item-footer',
      headerClassName: 'comment-overview-thread-header comments-drawer-item-header',
      lineClassName: 'comment-overview-thread-line comments-drawer-item-title',
      lineLabel: formatAnchorLabel(group.anchor),
      messageCount,
      previewBody: latestMessage?.body || '',
      previewClassName: 'comment-markdown comment-overview-thread-preview comments-drawer-item-preview',
      quote: group.anchor?.quote || group.anchor?.excerpt || 'Source anchored comment',
      quoteClassName: 'comment-overview-thread-quote comments-drawer-item-quote',
      timestamp: latestMessage ? this.formatTimestamp(latestMessage.createdAt) : '',
    });
    button.classList.toggle('is-active', this.activeCard?.groupKey === group.key);
    button.classList.toggle('is-unread', group.isUnread);
    button.classList.toggle('is-read', !group.isUnread);
    if (group.isUnread) {
      const accent = getReactionAccentColor(group.lastReactionEmoji);
      if (accent) {
        button.style.setProperty('--unread-accent', accent);
      }
    }
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
    });
    button.addEventListener('click', () => {
      this.onNavigateToLine?.(group.anchor?.startLine ?? 1);
      if (this.mobileBreakpointQuery?.matches) {
        this.setDrawerOpen(false);
      }
      this.openThreadGroup(group, {
        anchor: group.anchor,
        origin: 'editor',
        sourceRect: this.session?.getCommentAnchorClientRect?.(group.anchor)
          ?? button.getBoundingClientRect(),
      });
    });
    fragment.appendChild(button);
  });

  this.commentsDrawerList.appendChild(fragment);
}

/** @this {CommentUiRenderContext} */
function formatTimestamp(value) {
  if (!Number.isFinite(value)) {
    return '';
  }

  try {
    return this.timeFormatter.format(new Date(value));
  } catch {
    return '';
  }
}

export const commentUiRenderMethods = {
  formatTimestamp,
  render,
  renderDrawer,
  renderToolbar,
};
