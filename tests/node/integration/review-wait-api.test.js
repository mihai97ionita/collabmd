import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import WebSocket from 'ws';

import { startTestServer, waitForCondition } from '../helpers/test-server.js';
import { waitForOpen } from '../helpers/collaboration-protocol.js';

function httpRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request(url, { agent: false, headers, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        resolveRequest({
          body: bodyBuffer.toString('utf-8'),
          headers: res.headers,
          statusCode: res.statusCode,
        });
      });
    });
    req.on('error', rejectRequest);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function createReview(server, markdown = '# Proposal\n\nReview this.\n', title = 'Wait Test') {
  const response = await httpRequest(`${server.appBaseUrl}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, title }),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body);
}

test('GET /api/review/:id/wait blocks until POST /api/review/:id/notify fires', async () => {
  const server = await startTestServer();
  try {
    process.env.COLLABMD_TESTING = '1';
    const created = await createReview(server);

    const waitPending = httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/wait?timeoutMs=5000`,
    );

    // Wait until the server marks the agent as waiting.
    await waitForCondition(async () => {
      const status = await httpRequest(
        `${server.appBaseUrl}/api/review/${created.reviewId}/waiting`,
      );
      return JSON.parse(status.body).agentWaiting === true;
    });

    const notifyResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/notify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'handoff' }),
      },
    );
    assert.equal(notifyResponse.statusCode, 200);
    assert.deepEqual(JSON.parse(notifyResponse.body), { ok: true });

    const waitResponse = await waitPending;
    assert.equal(waitResponse.statusCode, 200);
    const result = JSON.parse(waitResponse.body);
    assert.equal(result.mode, 'handoff');
    assert.equal(result.canReply, true);
    assert.equal(result.canEdit, true);
    assert.equal(result.reason, null);
    assert.ok(result.since, 'since token must be returned');
  } finally {
    delete process.env.COLLABMD_TESTING;
    await server.close();
  }
});

test('GET /api/review/:id/wait returns 202 after the timeout', async () => {
  const server = await startTestServer();
  try {
    process.env.COLLABMD_TESTING = '1';
    const created = await createReview(server);

    const waitResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/wait?timeoutMs=300`,
    );
    assert.equal(waitResponse.statusCode, 202);
    assert.equal(waitResponse.body, '');

    const status = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/waiting`,
    );
    assert.equal(JSON.parse(status.body).agentWaiting, false);
  } finally {
    delete process.env.COLLABMD_TESTING;
    await server.close();
  }
});

test('POST /api/review/:id/notify with no agent waiting is delivered on the next wait (sticky)', async () => {
  const server = await startTestServer();
  try {
    process.env.COLLABMD_TESTING = '1';
    const created = await createReview(server);

    // Fire a notify before any agent is waiting.
    const notifyResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/notify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'peek' }),
      },
    );
    assert.equal(notifyResponse.statusCode, 200);

    // The next wait must resolve immediately with the sticky notify.
    const waitResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/wait?timeoutMs=5000`,
    );
    assert.equal(waitResponse.statusCode, 200);
    const result = JSON.parse(waitResponse.body);
    assert.equal(result.mode, 'peek');
    assert.equal(result.canEdit, false, 'peek must never allow edit');
    assert.equal(result.reason, 'peek mode does not grant edit', 'peek reason must explain the mode limit, not a live session');
    assert.ok(result.since, 'since token must be returned');
  } finally {
    delete process.env.COLLABMD_TESTING;
    await server.close();
  }
});

test('GET /api/review/:id/waiting returns agentWaiting true while a wait is open, false after it resolves', async () => {
  const server = await startTestServer();
  try {
    process.env.COLLABMD_TESTING = '1';
    const created = await createReview(server);

    const waitPending = httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/wait?timeoutMs=5000`,
    );

    await waitForCondition(async () => {
      const status = await httpRequest(
        `${server.appBaseUrl}/api/review/${created.reviewId}/waiting`,
      );
      return JSON.parse(status.body).agentWaiting === true;
    });

    await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/notify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'handoff' }),
      },
    );

    await waitPending;

    const finalStatus = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/waiting`,
    );
    assert.equal(JSON.parse(finalStatus.body).agentWaiting, false);
  } finally {
    delete process.env.COLLABMD_TESTING;
    await server.close();
  }
});

test('POST /api/review/:id/notify with invalid mode returns 422', async () => {
  const server = await startTestServer();
  try {
    const created = await createReview(server);

    const response = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/notify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'bogus' }),
      },
    );
    assert.equal(response.statusCode, 422);
  } finally {
    await server.close();
  }
});

test('Unknown reviewId returns 404 for wait, notify, and waiting endpoints', async () => {
  const server = await startTestServer();
  try {
    process.env.COLLABMD_TESTING = '1';
    const waitResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/nonexistent-id/wait?timeoutMs=200`,
    );
    assert.equal(waitResponse.statusCode, 404);

    const notifyResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/nonexistent-id/notify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'peek' }),
      },
    );
    assert.equal(notifyResponse.statusCode, 404);

    const waitingResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/nonexistent-id/waiting`,
    );
    assert.equal(waitingResponse.statusCode, 404);
  } finally {
    delete process.env.COLLABMD_TESTING;
    await server.close();
  }
});

test('canEdit is false with a reason when a live room has clients on handoff', async () => {
  const server = await startTestServer();
  let socket;
  try {
    process.env.COLLABMD_TESTING = '1';
    const created = await createReview(server);

    // Open a WebSocket so the collaboration room is live with clients > 0.
    socket = new WebSocket(server.wsUrl(created.vaultPath));
    await waitForOpen(socket);
    await waitForCondition(() => server.server.roomRegistry.get(created.vaultPath)?.clients?.size > 0);

    const waitPending = httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/wait?timeoutMs=5000`,
    );
    await waitForCondition(async () => {
      const status = await httpRequest(
        `${server.appBaseUrl}/api/review/${created.reviewId}/waiting`,
      );
      return JSON.parse(status.body).agentWaiting === true;
    });

    await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/notify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'handoff' }),
      },
    );

    const waitResponse = await waitPending;
    assert.equal(waitResponse.statusCode, 200);
    const result = JSON.parse(waitResponse.body);
    assert.equal(result.mode, 'handoff');
    assert.equal(result.canEdit, false, 'canEdit must be false when a live session is open');
    assert.ok(result.reason, 'reason must be present when canEdit is false');
    assert.match(result.reason, /live session/i, 'handoff-blocked reason must point at the live session, not the mode');
    assert.equal(result.canReply, true);
  } finally {
    socket?.close();
    delete process.env.COLLABMD_TESTING;
    await server.close();
  }
});

test('GET /api/review/:id/wait passes since token through and does not re-deliver consumed notifies', async () => {
  const server = await startTestServer();
  try {
    process.env.COLLABMD_TESTING = '1';
    const created = await createReview(server);

    // First wait — deliver a notify.
    const firstWait = httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/wait?timeoutMs=5000`,
    );
    await waitForCondition(async () => {
      const status = await httpRequest(
        `${server.appBaseUrl}/api/review/${created.reviewId}/waiting`,
      );
      return JSON.parse(status.body).agentWaiting === true;
    });
    await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/notify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'handoff' }),
      },
    );
    const firstResult = JSON.parse((await firstWait).body);
    assert.equal(firstResult.mode, 'handoff');
    const since = firstResult.since;

    // Second wait with the since token — no new notify, so it should time out (202).
    const secondResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/wait?timeoutMs=300&since=${since}`,
    );
    assert.equal(secondResponse.statusCode, 202);
  } finally {
    delete process.env.COLLABMD_TESTING;
    await server.close();
  }
});
