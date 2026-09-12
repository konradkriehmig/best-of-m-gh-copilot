import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { branchExists, git, tryGit } from './exec';

export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  prunable: boolean;
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('worktree ')) {
      if (current) {
        entries.push(current);
      }
      current = { path: line.slice('worktree '.length), prunable: false };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'prunable' && current) {
      current.prunable = true;
    } else if (line.startsWith('prunable ') && current) {
      current.prunable = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

/**
 * Create a worktree on a new branch. The caller owns naming, so a collision is a
 * programming error rather than something to silently work around.
 */
export async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  if (await branchExists(repoRoot, branch)) {
    throw new Error(`Branch "${branch}" already exists.`);
  }
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(repoRoot, ['worktree', 'add', '--quiet', '-b', branch, worktreePath, baseRef]);
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const removed = await tryGit(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  if (!removed) {
    // The directory may already be gone, or locked by a process that has not exited yet.
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await tryGit(repoRoot, ['worktree', 'prune']);
  }
}

export async function deleteBranch(repoRoot: string, branch: string): Promise<void> {
  await tryGit(repoRoot, ['branch', '-D', branch]);
}

/**
 * Copy git-ignored files (`.env` and friends) into a fresh worktree so agents can
 * actually build and test. Missing sources are skipped, since most repos have none.
 */
export async function copyIgnoredFiles(
  repoRoot: string,
  worktreePath: string,
  patterns: string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const relative of patterns) {
    if (!relative || path.isAbsolute(relative) || relative.includes('..')) {
      continue;
    }
    const source = path.join(repoRoot, relative);
    const destination = path.join(worktreePath, relative);
    try {
      const stat = await fs.stat(source);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (stat.isDirectory()) {
        await fs.cp(source, destination, { recursive: true, force: true });
      } else {
        await fs.copyFile(source, destination);
      }
      copied.push(relative);
    } catch {
      // Not present in this repository; nothing to copy.
    }
  }
  return copied;
}

export function defaultWorktreeRoot(repoRoot: string): string {
  return path.join(path.dirname(repoRoot), '.best-of-n', path.basename(repoRoot));
}

/** Find worktrees created by this extension that are no longer tracked by an active run. */
export async function findOrphans(repoRoot: string, activePaths: Set<string>): Promise<WorktreeInfo[]> {
  const all = await listWorktrees(repoRoot);
  return all.filter((entry) => {
    if (path.resolve(entry.path) === path.resolve(repoRoot)) {
      return false;
    }
    const isOurs = entry.branch?.startsWith('bon/') ?? false;
    return isOurs && !activePaths.has(path.resolve(entry.path));
  });
}
