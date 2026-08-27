import { dirname, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { resolveVaultFilePath } from './path-utils.js';

const REVIEW_STORAGE_ROOT = '.collabmd/review';
const REVIEW_PATH_PREFIX = 'tmp/review/';
const REVIEW_PATH_SUFFIX = '.md';
const META_FILE = 'meta.json';

function resolveReviewRoot(vaultDir) {
  return resolve(vaultDir, REVIEW_STORAGE_ROOT);
}

function resolveReviewDir(vaultDir, reviewId) {
  return resolve(resolveReviewRoot(vaultDir), reviewId);
}

function buildVaultPath(reviewId) {
  return `${REVIEW_PATH_PREFIX}${reviewId}${REVIEW_PATH_SUFFIX}`;
}

export class ReviewStore {
  constructor({ vaultDir }) {
    this.vaultDir = vaultDir;
  }

  async create({ markdown, title = null } = {}) {
    const reviewId = randomUUID();
    const secret = randomUUID();
    const vaultPath = buildVaultPath(reviewId);
    const reviewDir = resolveReviewDir(this.vaultDir, reviewId);

    const { absolute: proposalAbsolute, error: proposalError } = resolveVaultFilePath(this.vaultDir, vaultPath);
    if (!proposalAbsolute) {
      return { ok: false, error: proposalError };
    }

    const meta = {
      createdAt: Date.now(),
      reviewId,
      secret,
      title: typeof title === 'string' && title.trim() ? title.trim() : null,
      vaultPath,
    };

    await mkdir(dirname(proposalAbsolute), { recursive: true });
    await writeFile(proposalAbsolute, markdown ?? '', 'utf-8');

    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      resolve(reviewDir, META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
      'utf-8',
    );

    return { ok: true, reviewId, secret, vaultPath };
  }

  async readMeta(reviewId) {
    const metaPath = resolve(resolveReviewDir(this.vaultDir, reviewId), META_FILE);
    try {
      const raw = await readFile(metaPath, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async readProposal(reviewId) {
    const meta = await this.readMeta(reviewId);
    if (!meta) {
      return null;
    }
    const { absolute } = resolveVaultFilePath(this.vaultDir, meta.vaultPath);
    if (!absolute) {
      return null;
    }
    try {
      return await readFile(absolute, 'utf-8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async writeProposal(reviewId, markdown) {
    const meta = await this.readMeta(reviewId);
    if (!meta) {
      return { ok: false, error: 'Review not found', status: 404 };
    }
    const { absolute, error } = resolveVaultFilePath(this.vaultDir, meta.vaultPath);
    if (!absolute) {
      return { ok: false, error, status: 400 };
    }
    try {
      await writeFile(absolute, markdown, 'utf-8');
      return { ok: true, vaultPath: meta.vaultPath, updatedAt: Date.now() };
    } catch (writeError) {
      return { ok: false, error: writeError.message, status: 500 };
    }
  }

  async delete(reviewId) {
    const reviewDir = resolveReviewDir(this.vaultDir, reviewId);
    const meta = await this.readMeta(reviewId);
    if (meta?.vaultPath) {
      const { absolute } = resolveVaultFilePath(this.vaultDir, meta.vaultPath);
      if (absolute) {
        await rm(absolute, { force: true });
      }
    }
    await rm(reviewDir, { recursive: true, force: true });
    return { ok: true };
  }

  getVaultPath(reviewId) {
    return buildVaultPath(reviewId);
  }
}

export { REVIEW_PATH_PREFIX, REVIEW_STORAGE_ROOT };
