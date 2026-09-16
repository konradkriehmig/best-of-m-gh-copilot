import * as vscode from 'vscode';
import { git, isDirty, tryGit } from '../git/exec';
import { deleteBranch, removeWorktree } from '../git/worktrees';
import { RunRecord, VariantState } from '../util/types';

export interface MergeOutcome {
  merged: boolean;
  message: string;
}

/**
 * Merge the winning variant's branch into the branch the run started from.
 *
 * Conflicts are surfaced rather than resolved: the merge is aborted and the user is told
 * to merge manually, because silently picking a side would destroy work.
 */
export async function mergeWinner(
  run: RunRecord,
  winner: VariantState,
): Promise<MergeOutcome> {
  if (await isDirty(run.repoRoot)) {
    return {
      merged: false,
      message:
        'The main working tree has uncommitted changes. Commit or stash them, then merge ' +
        `"${winner.branch}" yourself.`,
    };
  }

  const current = await tryGit(run.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const currentBranchName = current?.stdout.trim();
  if (currentBranchName && currentBranchName !== run.baseBranch) {
    return {
      merged: false,
      message:
        `The repository is on "${currentBranchName}" but the run started from ` +
        `"${run.baseBranch}". Switch back and merge "${winner.branch}" yourself.`,
    };
  }

  try {
    await git(run.repoRoot, ['merge', '--no-ff', '-m', `Best of M: ${winner.label}`, winner.branch]);
    return { merged: true, message: `Merged ${winner.label} into ${run.baseBranch}.` };
  } catch (err) {
    await tryGit(run.repoRoot, ['merge', '--abort']);
    return {
      merged: false,
      message:
        `Merging "${winner.branch}" hit conflicts, so nothing was changed. ` +
        `Merge it manually to resolve them. (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Remove every worktree for the run. Branches are kept unless the user opts out, so a
 * rejected variant can still be inspected or recovered later.
 */
export async function cleanupRun(
  run: RunRecord,
  winnerId: string | undefined,
  deleteLoserBranches: boolean,
): Promise<void> {
  for (const variant of run.variants) {
    await removeWorktree(run.repoRoot, variant.worktreePath);
  }
  if (!deleteLoserBranches) {
    return;
  }
  for (const variant of run.variants) {
    if (variant.id !== winnerId) {
      await deleteBranch(run.repoRoot, variant.branch);
    }
  }
}

export async function confirmWinner(
  run: RunRecord,
  winner: VariantState,
): Promise<'merge' | 'branch-only' | undefined> {
  const choice = await vscode.window.showInformationMessage(
    `Keep ${winner.label}?`,
    {
      modal: true,
      detail:
        `Its branch is "${winner.branch}".\n\n` +
        `Merge into "${run.baseBranch}" now, or keep the branch and merge it yourself later. ` +
        `Either way the worktrees are removed.`,
    },
    'Merge now',
    'Keep branch only',
  );
  if (choice === 'Merge now') {
    return 'merge';
  }
  if (choice === 'Keep branch only') {
    return 'branch-only';
  }
  return undefined;
}
