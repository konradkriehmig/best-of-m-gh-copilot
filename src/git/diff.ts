import * as path from 'node:path';
import { git, tryGit } from './exec';
import { DiffStat } from '../util/types';

/**
 * Stage everything the agent produced so the variant's work is capturable as a single
 * diff, regardless of whether the agent committed. Agents frequently leave changes
 * uncommitted, and an uncommitted worktree cannot be merged.
 */
export async function commitVariantWork(
  worktreePath: string,
  message: string,
): Promise<{ committed: boolean }> {
  await git(worktreePath, ['add', '-A']);
  const { stdout } = await git(worktreePath, ['status', '--porcelain']);
  if (stdout.trim().length === 0) {
    return { committed: false };
  }
  await git(worktreePath, [
    '-c',
    'user.name=Best of M',
    '-c',
    'user.email=best-of-m@localhost',
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    message,
  ]);
  return { committed: true };
}

export async function diffStat(
  repoRoot: string,
  baseRef: string,
  branch: string,
): Promise<DiffStat> {
  const { stdout } = await git(repoRoot, ['diff', '--numstat', `${baseRef}...${branch}`]);
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [added, removed, file] = trimmed.split('\t');
    // Binary files report "-" instead of a count.
    insertions += Number.parseInt(added, 10) || 0;
    deletions += Number.parseInt(removed, 10) || 0;
    if (file) {
      files.push(file);
    }
  }

  return {
    filesChanged: files.length,
    insertions,
    deletions,
    files,
    empty: files.length === 0,
  };
}

export async function diffText(
  repoRoot: string,
  baseRef: string,
  branch: string,
): Promise<string> {
  const result = await tryGit(repoRoot, ['diff', `${baseRef}...${branch}`]);
  return result?.stdout ?? '';
}

/** Content of a file at a ref, used to populate the read-only side of a diff editor. */
export async function fileAtRef(
  repoRoot: string,
  ref: string,
  file: string,
): Promise<string | undefined> {
  const result = await tryGit(repoRoot, ['show', `${ref}:${file.split(path.sep).join('/')}`]);
  return result?.stdout;
}
