import { dirname, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { resolveVaultFilePath } from './path-utils.js';

const REVIEW_STORAGE_ROOT = '.collabmd/review';
const REVIEW_PATH_PREFIX = 'tmp/review/';
const REVIEW_PATH_SUFFIX = '.md';
const META_FILE = 'meta.json';

function slugifyTitle(title) {
  return String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function buildVaultPath(reviewId, title = null) {
  const slug = slugifyTitle(title);
  return `${REVIEW_PATH_PREFIX}${slug}-${reviewId}${REVIEW_PATH_SUFFIX}`;
}

function resolveReviewRoot(vaultDir) {
  return resolve(vaultDir, REVIEW_STORAGE_ROOT);
}

function resolveReviewDir(vaultDir, reviewId) {
  return resolve(resolveReviewRoot(vaultDir), reviewId);
}

export class ReviewStore {
  constructor({ vaultDir }) {
    this.vaultDir = vaultDir;
  }

  async create({ markdown, title = null } = {}) {
    const reviewId = randomUUID();
    const normalizedTitle = typeof title === 'string' && title.trim() ? title.trim() : null;
    const vaultPath = buildVaultPath(reviewId, normalizedTitle);
    const reviewDir = resolveReviewDir(this.vaultDir, reviewId);

    const { absolute: proposalAbsolute, error: proposalError } = resolveVaultFilePath(this.vaultDir, vaultPath);
    if (!proposalAbsolute) {
      return { ok: false, error: proposalError };
    }

    const meta = {
      createdAt: Date.now(),
      reviewId,
      title: normalizedTitle,
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

    return { ok: true, reviewId, vaultPath };
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

  getVaultPath(reviewId, title = null) {
    return buildVaultPath(reviewId, title);
  }
}

export { REVIEW_PATH_PREFIX, REVIEW_STORAGE_ROOT };
