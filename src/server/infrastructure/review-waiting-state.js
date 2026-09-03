// In-memory, per-review waiting-state manager for the agent review loop.
// NO disk persistence — waiting is transient; the filesystem stays the
// source of truth. If the server restarts, waiting state is lost and the
// agent simply re-calls wait_for_review.
//
// Sticky-notify + since-token semantics:
//   - `since` is an opaque string the client passes back on re-poll.
//   - A notify with `at > since` is "newer" and must be delivered.
//   - A notify with `at <= since` was already consumed and must not re-fire.
//   - A notify that fires while no waiter is registered is kept in the
//     pending slot so the next register/consume call delivers it immediately.

function parseSince(since) {
  if (since === null || since === undefined || since === '') {
    return -Infinity;
  }
  const numeric = Number(since);
  return Number.isFinite(numeric) ? numeric : -Infinity;
}

export class ReviewWaitingStateManager {
  constructor() {
    this._state = new Map();
  }

  _ensure(reviewId) {
    let entry = this._state.get(reviewId);
    if (!entry) {
      entry = { agentWaiting: false, waiters: [], pendingNotify: null, lastNotify: null };
      this._state.set(reviewId, entry);
    }
    return entry;
  }

  _maybeCleanup(reviewId) {
    const entry = this._state.get(reviewId);
    // Keep the entry alive while a lastNotify (terminal conclusion) exists
    // so get_review can render the ## Review Status section even after the
    // waiting/notify cycle completes and waiters drain.
    if (entry && !entry.agentWaiting && entry.waiters.length === 0 && !entry.pendingNotify && !entry.lastNotify) {
      this._state.delete(reviewId);
    }
  }

  markWaiting(reviewId) {
    const entry = this._ensure(reviewId);
    entry.agentWaiting = true;
    return String(Date.now());
  }

  clearWaiting(reviewId) {
    const entry = this._state.get(reviewId);
    if (!entry) {
      return;
    }
    entry.agentWaiting = false;
    this._maybeCleanup(reviewId);
  }

  isWaiting(reviewId) {
    const entry = this._state.get(reviewId);
    return Boolean(entry?.agentWaiting);
  }

  // Returns { promise, cancel }. The promise resolves with the pending
  // notify `{ mode, canProceed, at }` when a notify arrives, or `null` when
  // the waiter is cancelled (client disconnect / timeout). If a sticky
  // pending notify newer than `since` exists, the promise resolves immediately.
  registerWaiter(reviewId, since) {
    const entry = this._ensure(reviewId);
    const sinceNum = parseSince(since);

    if (entry.pendingNotify && entry.pendingNotify.at > sinceNum) {
      const notify = entry.pendingNotify;
      entry.pendingNotify = null;
      entry.agentWaiting = false;
      this._maybeCleanup(reviewId);
      return { promise: Promise.resolve(notify), cancel: () => {} };
    }

    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const waiter = { resolve: resolveFn, since: sinceNum, cancelled: false };
    entry.waiters.push(waiter);

    const cancel = () => {
      if (waiter.cancelled) {
        return;
      }
      waiter.cancelled = true;
      const index = entry.waiters.indexOf(waiter);
      if (index >= 0) {
        entry.waiters.splice(index, 1);
      }
      waiter.resolve(null);
      this._maybeCleanup(reviewId);
    };

    return { promise, cancel };
  }

  // Stores the notify and wakes any current waiters. If no waiter is
  // registered, the notify is kept in the pending slot for sticky delivery
  // on the next register/consume call. The notify object is also retained
  // in `lastNotify` so get_review can render a ## Review Status section.
  postNotify(reviewId, mode, canProceed = false) {
    const entry = this._ensure(reviewId);
    const notify = { mode, canProceed: Boolean(canProceed), at: Date.now() };
    entry.lastNotify = notify;

    if (entry.waiters.length > 0) {
      const waiters = entry.waiters.splice(0);
      for (const waiter of waiters) {
        if (!waiter.cancelled) {
          waiter.resolve(notify);
        }
      }
      entry.agentWaiting = false;
      this._maybeCleanup(reviewId);
    } else {
      entry.pendingNotify = notify;
    }
  }

  // Returns the last notify `{ mode, canProceed, at }` for a review, or null.
  // Used by handleReviewRead to render the ## Review Status section. The value
  // persists in memory for the life of the entry; terminal modes (approve/deny)
  // are not consumed — get_review should always see the conclusion.
  getLastNotify(reviewId) {
    const entry = this._state.get(reviewId);
    return entry?.lastNotify ?? null;
  }

  // Called at the start of a wait to check for a sticky pending notify.
  // Returns the notify if one exists with `at > since`, else null. The
  // notify is consumed (removed) when returned.
  consumePendingNotify(reviewId, since) {
    const entry = this._state.get(reviewId);
    if (!entry || !entry.pendingNotify) {
      return null;
    }
    const sinceNum = parseSince(since);
    if (entry.pendingNotify.at > sinceNum) {
      const notify = entry.pendingNotify;
      entry.pendingNotify = null;
      entry.agentWaiting = false;
      this._maybeCleanup(reviewId);
      return notify;
    }
    return null;
  }
}
