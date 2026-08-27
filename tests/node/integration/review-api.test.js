import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { startTestServer } from '../helpers/test-server.js';

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

test('POST /api/review creates a vault file and returns a secret-gated URL; GET returns the two-part markdown', async () => {
  const server = await startTestServer();
  try {
    const proposal = [
      '# Agent Proposal',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[Client] --> B[API]',
      '```',
      '',
      'The cache will store all responses indefinitely.',
      '',
    ].join('\n');

    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: proposal, title: 'Review 1' }),
    });
    assert.equal(createResponse.statusCode, 201);
    const created = JSON.parse(createResponse.body);
    assert.ok(created.reviewId, 'reviewId must be returned');
    assert.ok(created.secret, 'secret must be returned');
    assert.ok(created.vaultPath.startsWith('tmp/review/'), 'vaultPath must live under tmp/review');
    assert.ok(
      created.url.includes(`#file=${encodeURIComponent(created.vaultPath)}`),
      'url must deep-link into the UI',
    );
    assert.ok(created.url.startsWith('http'), 'url must be absolute');

    const proposalOnDisk = await readFile(join(server.vaultDir, created.vaultPath), 'utf-8');
    assert.equal(proposalOnDisk, proposal, 'proposal must be written verbatim into the vault');

    const getResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}`,
    );
    assert.equal(getResponse.statusCode, 200);
    assert.match(getResponse.headers['content-type'], /text\/markdown/);
    assert.ok(
      getResponse.headers['x-review-url'].includes(`#file=${encodeURIComponent(created.vaultPath)}`),
      'GET must expose the review URL via X-Review-Url header',
    );
    assert.ok(getResponse.body.startsWith(proposal), 'GET must return the proposal verbatim at the top');
    assert.equal(getResponse.body, proposal, 'GET with no comments returns just the proposal (no appendix)');
  } finally {
    await server.close();
  }
});

test('GET /api/review/:id rejects an invalid secret with 403', async () => {
  const server = await startTestServer();
  try {
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Hello' }),
    });
    const created = JSON.parse(createResponse.body);

    const badSecretResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=not-the-secret`,
    );
    assert.equal(badSecretResponse.statusCode, 403);
  } finally {
    await server.close();
  }
});

test('GET /api/review/:id with a valid secret but stored comments weaves them into the appendix', async () => {
  const server = await startTestServer();
  try {
    const proposal = '# Plan\n\nDo the thing on line 2.\n';
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: proposal }),
    });
    const created = JSON.parse(createResponse.body);

    const commentPath = join(server.vaultDir, '.collabmd/comments', `${created.vaultPath}.json`);
    await mkdir(dirname(commentPath), { recursive: true });
    await writeFile(commentPath, JSON.stringify({
      version: 1,
      threads: [{
        id: 'thread-test-1',
        anchorKind: 'line',
        anchorStartLine: 2,
        anchorEndLine: 2,
        anchorStart: { type: 'relative', tname: 'ytext', item: null, n: null, rel: null },
        anchorEnd: { type: 'relative', tname: 'ytext', item: null, n: null, rel: null },
        anchorQuote: 'Do the thing on line 2.',
        createdAt: Date.parse('2026-08-26T14:00:00Z'),
        createdByName: 'imihai',
        createdByColor: '',
        createdByPeerId: 'peer-1',
        resolvedAt: null,
        messages: [{
          id: 'comment-test-1',
          body: 'Reword this — it is ambiguous.',
          createdAt: Date.parse('2026-08-26T14:01:00Z'),
          userName: 'imihai',
          userColor: '',
          peerId: 'peer-1',
          reactions: [],
        }],
      }],
    }), 'utf-8');

    const getResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}`,
    );
    assert.equal(getResponse.statusCode, 200);
    assert.ok(getResponse.body.includes('### Line 2'), 'appendix must reference the anchored line');
    assert.ok(getResponse.body.includes('Reword this — it is ambiguous.'), 'comment body must appear');
    assert.ok(getResponse.body.includes('@imihai'), 'comment author must appear');
  } finally {
    await server.close();
  }
});

test('POST /api/review rejects an empty markdown body with 400', async () => {
  const server = await startTestServer();
  try {
    const response = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '   ' }),
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await server.close();
  }
});

test('POST /api/review and GET /api/review/:id use publicBaseUrl when configured', async () => {
  const publicBaseUrl = 'https://collabmd.example.internal';
  const server = await startTestServer({
    publicBaseUrl,
  });
  try {
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Public Base URL test' }),
    });
    assert.equal(createResponse.statusCode, 201);
    const created = JSON.parse(createResponse.body);
    assert.ok(
      created.url.startsWith(`${publicBaseUrl}/#file=`),
      `url "${created.url}" must start with publicBaseUrl "${publicBaseUrl}"`,
    );

    const getResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}`,
    );
    assert.equal(getResponse.statusCode, 200);
    assert.ok(
      getResponse.headers['x-review-url'].startsWith(`${publicBaseUrl}/#file=`),
      'X-Review-Url header must start with publicBaseUrl',
    );
  } finally {
    await server.close();
  }
});

test('PUT /api/review/:id replaces the proposal markdown when no session is active', async () => {
  const server = await startTestServer();
  try {
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# V1\n\nFirst draft.\n' }),
    });
    const created = JSON.parse(createResponse.body);

    const putResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '# V2\n\nRevised draft.\n' }),
      },
    );
    assert.equal(putResponse.statusCode, 200);
    const updated = JSON.parse(putResponse.body);
    assert.equal(updated.ok, true);
    assert.equal(updated.vaultPath, created.vaultPath);
    assert.ok(Number.isFinite(updated.updatedAt), 'updatedAt must be set');

    const proposalOnDisk = await readFile(join(server.vaultDir, created.vaultPath), 'utf-8');
    assert.equal(proposalOnDisk, '# V2\n\nRevised draft.\n', 'PUT must overwrite the proposal file verbatim');

    const getResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}`,
    );
    assert.ok(getResponse.body.startsWith('# V2'), 'GET after PUT must reflect the new proposal');
  } finally {
    await server.close();
  }
});

test('PUT /api/review/:id rejects an invalid secret with 403', async () => {
  const server = await startTestServer();
  try {
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Hello' }),
    });
    const created = JSON.parse(createResponse.body);

    const putResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=not-the-secret`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '# Tampered' }),
      },
    );
    assert.equal(putResponse.statusCode, 403);
  } finally {
    await server.close();
  }
});

test('PUT /api/review/:id returns 404 for an unknown review id', async () => {
  const server = await startTestServer();
  try {
    const putResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/nonexistent-id?secret=anything`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '# Whatever' }),
      },
    );
    assert.equal(putResponse.statusCode, 404);
  } finally {
    await server.close();
  }
});

test('PUT /api/review/:id rejects an empty markdown body with 422', async () => {
  const server = await startTestServer();
  try {
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Original' }),
    });
    const created = JSON.parse(createResponse.body);

    const putResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '   ' }),
      },
    );
    assert.equal(putResponse.statusCode, 422);
  } finally {
    await server.close();
  }
});

test('GET /api/review/:id with resolved=true includes resolved threads, default excludes them', async () => {
  const server = await startTestServer();
  try {
    const proposal = '# Plan\n\nDo the thing on line 2.\n';
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: proposal }),
    });
    const created = JSON.parse(createResponse.body);

    const commentPath = join(server.vaultDir, '.collabmd/comments', `${created.vaultPath}.json`);
    await mkdir(dirname(commentPath), { recursive: true });
    await writeFile(commentPath, JSON.stringify({
      version: 1,
      threads: [{
        id: 'thread-resolved-1',
        anchorKind: 'line',
        anchorStartLine: 2,
        anchorEndLine: 2,
        anchorStart: { type: 'relative', tname: 'ytext', item: null, n: null, rel: null },
        anchorEnd: { type: 'relative', tname: 'ytext', item: null, n: null, rel: null },
        anchorQuote: 'Do the thing on line 2.',
        createdAt: Date.parse('2026-08-26T14:00:00Z'),
        createdByName: 'reviewer',
        createdByColor: '',
        createdByPeerId: 'peer-1',
        resolvedAt: Date.parse('2026-08-26T15:00:00Z'),
        resolvedByName: 'reviewer',
        resolvedByColor: '',
        resolvedByPeerId: 'peer-1',
        messages: [{
          id: 'comment-resolved-1',
          body: 'Addressed in v2.',
          createdAt: Date.parse('2026-08-26T14:01:00Z'),
          userName: 'reviewer',
          userColor: '',
          peerId: 'peer-1',
          reactions: [],
        }],
      }],
    }), 'utf-8');

    const defaultResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}`,
    );
    assert.equal(defaultResponse.statusCode, 200);
    assert.ok(!defaultResponse.body.includes('## Review Comments'), 'default GET must exclude resolved threads');

    const resolvedResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}&resolved=true`,
    );
    assert.equal(resolvedResponse.statusCode, 200);
    assert.ok(resolvedResponse.body.includes('### Line 2'), 'resolved=true must include the resolved thread heading');
    assert.ok(resolvedResponse.body.includes('(resolved by reviewer)'), 'resolved thread must carry the (resolved by <name>) marker');
  } finally {
    await server.close();
  }
});

test('POST /api/review/:id/threads/:threadId/reply appends an Agent reply to the sidecar', async () => {
  const server = await startTestServer();
  try {
    const proposal = '# Plan\n\nDo the thing on line 2.\n';
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: proposal }),
    });
    const created = JSON.parse(createResponse.body);

    const commentPath = join(server.vaultDir, '.collabmd/comments', `${created.vaultPath}.json`);
    await mkdir(dirname(commentPath), { recursive: true });
    await writeFile(commentPath, JSON.stringify({
      version: 1,
      threads: [{
        id: 'thread-reply-1',
        anchorKind: 'line',
        anchorStartLine: 2,
        anchorEndLine: 2,
        anchorStart: { type: 'relative', tname: 'ytext', item: null, n: null, rel: null },
        anchorEnd: { type: 'relative', tname: 'ytext', item: null, n: null, rel: null },
        anchorQuote: 'Do the thing on line 2.',
        createdAt: Date.parse('2026-08-26T14:00:00Z'),
        createdByName: 'reviewer',
        createdByColor: '',
        createdByPeerId: 'peer-1',
        resolvedAt: null,
        messages: [{
          id: 'comment-original',
          body: 'This is ambiguous.',
          createdAt: Date.parse('2026-08-26T14:01:00Z'),
          editedAt: null,
          userName: 'reviewer',
          userColor: '',
          peerId: 'peer-1',
          reactions: [],
        }],
      }],
    }), 'utf-8');

    const replyResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/threads/thread-reply-1/reply?secret=${encodeURIComponent(created.secret)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Good point — reworded in v2.' }),
      },
    );
    assert.equal(replyResponse.statusCode, 200);
    const replied = JSON.parse(replyResponse.body);
    assert.equal(replied.ok, true);
    assert.ok(replied.messageId, 'must return a messageId');
    assert.equal(replied.threadId, 'thread-reply-1');

    const getResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}?secret=${encodeURIComponent(created.secret)}`,
    );
    assert.equal(getResponse.statusCode, 200);
    assert.ok(getResponse.body.includes('@Agent'), 'reply author must be Agent');
    assert.ok(getResponse.body.includes('Good point — reworded in v2.'), 'reply body must appear in the appendix');
  } finally {
    await server.close();
  }
});

test('POST /api/review/:id/threads/:threadId/reply rejects an invalid secret with 403', async () => {
  const server = await startTestServer();
  try {
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Hello' }),
    });
    const created = JSON.parse(createResponse.body);

    const replyResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/threads/any-thread/reply?secret=wrong`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'reply' }),
      },
    );
    assert.equal(replyResponse.statusCode, 403);
  } finally {
    await server.close();
  }
});

test('POST /api/review/:id/threads/:threadId/reply returns 404 for an unknown thread', async () => {
  const server = await startTestServer();
  try {
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Hello' }),
    });
    const created = JSON.parse(createResponse.body);

    const replyResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/threads/nonexistent-thread/reply?secret=${encodeURIComponent(created.secret)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'reply' }),
      },
    );
    assert.equal(replyResponse.statusCode, 404);
  } finally {
    await server.close();
  }
});

test('POST /api/review/:id/threads/:threadId/reply rejects an empty body with 422', async () => {
  const server = await startTestServer();
  try {
    const createResponse = await httpRequest(`${server.appBaseUrl}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Hello' }),
    });
    const created = JSON.parse(createResponse.body);

    const replyResponse = await httpRequest(
      `${server.appBaseUrl}/api/review/${created.reviewId}/threads/any-thread/reply?secret=${encodeURIComponent(created.secret)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '   ' }),
      },
    );
    assert.equal(replyResponse.statusCode, 422);
  } finally {
    await server.close();
  }
});

