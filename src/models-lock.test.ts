import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelLockError, ensureModelLock } from './models-lock.js';

const created: string[] = [];

async function tempLockPath(contents?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-lock-'));
  created.push(dir);
  const path = join(dir, 'models.lock.json');
  if (contents !== undefined) await writeFile(path, JSON.stringify(contents, null, 2));
  return path;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ensureModelLock', () => {
  it('writes the lockfile on the first run, resolving the revision', async () => {
    const lockPath = await tempLockPath();

    const entry = await ensureModelLock({
      slot: 'embedding',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'fp32',
      lockPath,
      resolveRevision: () => Promise.resolve('abc123'),
    });

    expect(entry).toEqual({
      modelId: 'Xenova/all-MiniLM-L6-v2',
      revision: 'abc123',
      dtype: 'fp32',
    });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({ embedding: entry });
  });

  it('records a null revision rather than inventing one when resolution fails', async () => {
    const lockPath = await tempLockPath();

    const entry = await ensureModelLock({
      slot: 'embedding',
      modelId: 'some/model',
      dtype: 'fp32',
      lockPath,
      resolveRevision: () => Promise.resolve(null),
    });

    /* A fabricated hash would claim a guarantee the run did not have. */
    expect(entry.revision).toBeNull();
  });

  it('returns the locked entry unchanged on a matching run', async () => {
    const lockPath = await tempLockPath({
      embedding: { modelId: 'm', revision: 'rev-1', dtype: 'fp32' },
    });

    const entry = await ensureModelLock({ slot: 'embedding', modelId: 'm', dtype: 'fp32', lockPath });

    expect(entry.revision).toBe('rev-1');
  });

  it('fails on a different model id, explaining why scores are not comparable', async () => {
    const lockPath = await tempLockPath({
      embedding: { modelId: 'old/model', revision: 'rev-1', dtype: 'fp32' },
    });

    /* A silent embedding-model swap shifts every score in the suite at once,
       which is indistinguishable from the subject regressing. */
    await expect(
      ensureModelLock({ slot: 'embedding', modelId: 'new/model', dtype: 'fp32', lockPath }),
    ).rejects.toThrow(/not comparable across model revisions/);
  });

  it('fails on a different dtype, since quantisation changes the numbers', async () => {
    const lockPath = await tempLockPath({
      embedding: { modelId: 'm', revision: 'rev-1', dtype: 'fp32' },
    });

    await expect(
      ensureModelLock({ slot: 'embedding', modelId: 'm', dtype: 'q8', lockPath }),
    ).rejects.toThrow(/locked dtype "fp32", run used "q8"/);
  });

  it('fails on an explicitly requested revision that differs from the lock', async () => {
    const lockPath = await tempLockPath({
      embedding: { modelId: 'm', revision: 'rev-1', dtype: 'fp32' },
    });

    await expect(
      ensureModelLock({
        slot: 'embedding',
        modelId: 'm',
        dtype: 'fp32',
        revision: 'rev-2',
        lockPath,
      }),
    ).rejects.toThrow(/locked revision "rev-1", run used "rev-2"/);
  });

  it('keeps other slots when writing a new one', async () => {
    const lockPath = await tempLockPath({
      judge: { modelId: 'claude-opus-5', revision: null, dtype: 'n/a' },
    });

    await ensureModelLock({
      slot: 'embedding',
      modelId: 'm',
      dtype: 'fp32',
      lockPath,
      resolveRevision: () => Promise.resolve('rev-9'),
    });

    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(lock.judge.modelId).toBe('claude-opus-5');
    expect(lock.embedding.revision).toBe('rev-9');
  });

  it('reports a corrupt lockfile clearly', async () => {
    const lockPath = await tempLockPath();
    await writeFile(lockPath, '{ not json');

    await expect(
      ensureModelLock({ slot: 'embedding', modelId: 'm', dtype: 'fp32', lockPath }),
    ).rejects.toThrow(ModelLockError);
  });
});
