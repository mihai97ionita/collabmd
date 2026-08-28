import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomRegistry } from '../../src/server/domain/collaboration/room-registry.js';

test('RoomRegistry reset destroys active rooms and clears the registry', async () => {
  const destroyed = [];
  const registry = new RoomRegistry({
    createRoom: ({ name }) => ({
      destroy() {
        destroyed.push(name);
      },
    }),
  });

  registry.getOrCreate('README.md');
  registry.getOrCreate('sample-mermaid.mmd');

  await registry.reset();

  assert.deepEqual(destroyed.sort(), ['README.md', 'sample-mermaid.mmd']);
  assert.equal(registry.rooms.size, 0);
});

test('RoomRegistry replaces deleted rooms without letting stale room cleanup remove the replacement', () => {
  const callbacks = new Map();
  let roomId = 0;
  const registry = new RoomRegistry({
    createRoom: ({ onEmpty }) => {
      const room = {
        deleted: false,
        id: ++roomId,
        isDeleted() {
          return this.deleted;
        },
        markDeleted() {
          this.deleted = true;
        },
      };
      callbacks.set(room, onEmpty);
      return room;
    },
  });

  const originalRoom = registry.getOrCreate('README.md');
  originalRoom.markDeleted();

  const replacementRoom = registry.getOrCreate('README.md');

  assert.notEqual(replacementRoom, originalRoom);
  assert.equal(registry.get('README.md'), replacementRoom);

  callbacks.get(originalRoom)?.('README.md');
  assert.equal(registry.get('README.md'), replacementRoom);

  callbacks.get(replacementRoom)?.('README.md');
  assert.equal(registry.get('README.md'), undefined);
});

test('RoomRegistry reconciles workspace changes by reloading changed rooms, destroying deletions, and preserving renames', async () => {
  const events = [];
  const registry = new RoomRegistry({
    createRoom: ({ name }) => ({
      name,
      async destroy() {
        events.push(['destroy', name]);
      },
      isDeleted() {
        return false;
      },
      markDeleted() {
        events.push(['mark-deleted', name]);
      },
      async reloadFromDisk() {
        events.push(['reload', name]);
      },
    }),
  });

  registry.getOrCreate('changed.md');
  registry.getOrCreate('deleted.md');
  registry.getOrCreate('renamed-old.md');

  await registry.reconcileWorkspaceChange({
    changedPaths: ['changed.md'],
    deletedPaths: ['deleted.md'],
    renamedPaths: [{ oldPath: 'renamed-old.md', newPath: 'renamed-new.md' }],
  });

  assert.deepEqual(events, [
    ['mark-deleted', 'deleted.md'],
    ['destroy', 'deleted.md'],
    ['reload', 'changed.md'],
  ]);
  assert.equal(registry.get('deleted.md'), undefined);
  assert.equal(registry.get('renamed-old.md'), undefined);
  assert.notEqual(registry.get('renamed-new.md'), undefined);
});

test('RoomRegistry serializes external mutations and releases the path after every reservation', async () => {
  let reloads = 0;
  const registry = new RoomRegistry({
    createRoom: () => ({
      clients: new Set(),
      hasActiveOrPendingClients() {
        return false;
      },
      async awaitExternalMutationBarrier() {},
      async reloadFromDisk() {
        reloads += 1;
      },
    }),
  });
  registry.getOrCreate('review.md');

  const first = await registry.reserveExternalMutation('review.md');
  let secondAcquired = false;
  const secondPending = registry.reserveExternalMutation('review.md').then((reservation) => {
    secondAcquired = true;
    return reservation;
  });

  await Promise.resolve();
  assert.equal(first.ok, true);
  assert.equal(secondAcquired, false);
  assert.equal(registry.isExternalMutationReserved('review.md'), true);

  await first.release({ refreshFromDisk: true });
  const second = await secondPending;
  assert.equal(second.ok, true);
  assert.equal(reloads, 1);
  assert.equal(registry.isExternalMutationReserved('review.md'), true);

  await second.release();
  assert.equal(registry.isExternalMutationReserved('review.md'), false);
});

test('RoomRegistry evicts and destroys a room when refresh after external mutation fails', async () => {
  const events = [];
  let roomId = 0;
  const registry = new RoomRegistry({
    createRoom: ({ name }) => {
      const id = ++roomId;
      return {
        clients: new Set(),
        hasActiveOrPendingClients() {
          return false;
        },
        async awaitExternalMutationBarrier() {},
        async reloadFromDisk() {
          events.push(['reload', name, id]);
          if (id === 1) {
            throw new Error('reload failed');
          }
        },
        markDeleted() {
          events.push(['mark-deleted', name, id]);
        },
        async destroy() {
          events.push(['destroy', name, id]);
        },
      };
    },
  });

  const originalRoom = registry.getOrCreate('review.md');
  const reservation = await registry.reserveExternalMutation('review.md');

  await assert.doesNotReject(() => reservation.release({ refreshFromDisk: true }));

  assert.deepEqual(events, [['reload', 'review.md', 1], ['destroy', 'review.md', 1]]);
  assert.equal(registry.get('review.md'), undefined);
  assert.equal(registry.isExternalMutationReserved('review.md'), false);

  const freshRoom = registry.getOrCreate('review.md');
  assert.notEqual(freshRoom, originalRoom);
  assert.equal(freshRoom, registry.get('review.md'));
});

test('RoomRegistry rejects an external mutation while a room has active or hydrating clients', async () => {
  const registry = new RoomRegistry({
    createRoom: () => ({
      hasActiveOrPendingClients() {
        return true;
      },
    }),
  });
  registry.getOrCreate('review.md');

  const reservation = await registry.reserveExternalMutation('review.md');

  assert.deepEqual(reservation, { ok: false, reason: 'active-collaboration' });
  assert.equal(registry.isExternalMutationReserved('review.md'), false);
});
