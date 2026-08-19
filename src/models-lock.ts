/**
 * Pinning the models a run depends on, in a committed lockfile.
 *
 * WHY
 * ---
 * A cosine similarity is only comparable to another cosine similarity from the
 * same encoder. Swap the model, the revision, or the quantisation and every
 * semantic score in the suite shifts at once — uniformly, silently, and in a
 * way that looks exactly like the subject getting worse. That is the most
 * expensive false positive an eval harness can produce: an afternoon spent
 * bisecting prompt changes to explain a regression caused by `npm update`.
 *
 * A lockfile turns that into an explicit, reviewable change. The first run
 * writes what it resolved; every later run compares and fails on a mismatch.
 * Updating the model then means committing a lockfile diff — which is exactly
 * the property the baseline gate relies on, applied one level down.
 */

import { readFile, writeFile } from 'node:fs/promises';

export const MODELS_LOCK_PATH = 'models.lock.json';

/**
 * `revision` is `null` when it could not be resolved — offline, or a mirror
 * that does not report a commit. Recorded honestly rather than invented: a
 * fabricated hash would claim a guarantee the run did not have.
 */
export type LockedModel = {
  modelId: string;
  revision: string | null;
  dtype: string;
};

export type ModelsLock = {
  embedding?: LockedModel;
  judge?: LockedModel;
};

export class ModelLockError extends Error {
  override readonly name = 'ModelLockError';
}

/** Resolves a repo's current commit. Injected so tests never hit the network,
 *  and so an offline run degrades to `null` rather than failing. */
export type RevisionResolver = (modelId: string) => Promise<string | null>;

/**
 * Looks up the current commit of a Hugging Face repo.
 *
 * Only ever called on the first run, when the lockfile is being written. A
 * failure returns `null` rather than throwing: not being able to reach the Hub
 * is a reason to record an unpinned run, not a reason to stop the suite.
 */
export const huggingFaceRevision: RevisionResolver = async (modelId) => {
  try {
    const response = await fetch(`https://huggingface.co/api/models/${modelId}`);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const sha = (body as { sha?: unknown }).sha;
    return typeof sha === 'string' ? sha : null;
  } catch {
    return null;
  }
};

export type EnsureLockOptions = {
  /** Which slot in the lockfile this model occupies. */
  readonly slot: keyof ModelsLock;
  readonly modelId: string;
  readonly dtype: string;
  /** Pinned revision, if the caller already knows it. When omitted, the
   *  resolver is asked — but only on the run that writes the lock. */
  readonly revision?: string | null;
  readonly lockPath?: string;
  readonly resolveRevision?: RevisionResolver;
};

/**
 * Reads the lockfile and either verifies this model against it or writes it.
 *
 * @returns the locked entry, which is what the run should record in its
 * metadata — the lock is the authority, not the caller's request.
 * @throws {ModelLockError} when the lockfile names a different model.
 */
export async function ensureModelLock(options: EnsureLockOptions): Promise<LockedModel> {
  const lockPath = options.lockPath ?? MODELS_LOCK_PATH;
  const lock = await readLock(lockPath);
  const existing = lock[options.slot];

  if (existing !== undefined) {
    const mismatches = describeMismatches(existing, options);
    if (mismatches.length > 0) {
      throw new ModelLockError(
        `${options.slot} model does not match ${lockPath}: ${mismatches.join('; ')}. ` +
          `Scores are not comparable across model revisions — a different encoder or ` +
          `judge shifts every score in the suite at once, which is indistinguishable ` +
          `from the subject regressing. Either restore the locked model, or update ` +
          `${lockPath} and re-record the baseline in the same commit so the change is ` +
          `reviewable.`,
      );
    }
    return existing;
  }

  /* First run for this slot: resolve and write. */
  const resolve = options.resolveRevision ?? huggingFaceRevision;
  const revision =
    options.revision !== undefined ? options.revision : await resolve(options.modelId);

  const entry: LockedModel = { modelId: options.modelId, revision, dtype: options.dtype };
  await writeFile(lockPath, `${JSON.stringify({ ...lock, [options.slot]: entry }, null, 2)}\n`);
  return entry;
}

function describeMismatches(existing: LockedModel, options: EnsureLockOptions): string[] {
  const mismatches: string[] = [];
  if (existing.modelId !== options.modelId) {
    mismatches.push(`locked modelId "${existing.modelId}", run used "${options.modelId}"`);
  }
  if (existing.dtype !== options.dtype) {
    mismatches.push(`locked dtype "${existing.dtype}", run used "${options.dtype}"`);
  }
  /* An explicitly requested revision that differs is a mismatch. A caller that
     passes nothing is accepting whatever the lock says, which is the point. */
  if (
    options.revision !== undefined &&
    options.revision !== null &&
    existing.revision !== null &&
    existing.revision !== options.revision
  ) {
    mismatches.push(`locked revision "${existing.revision}", run used "${options.revision}"`);
  }
  return mismatches;
}

async function readLock(lockPath: string): Promise<ModelsLock> {
  let contents: string;
  try {
    contents = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  try {
    return JSON.parse(contents) as ModelsLock;
  } catch (error) {
    throw new ModelLockError(
      `${lockPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
