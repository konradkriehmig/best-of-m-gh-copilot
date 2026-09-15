import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { CliInvocation } from '../cli/locate';
import { commitVariantWork, diffStat, diffText } from '../git/diff';
import { headSha, currentBranch } from '../git/exec';
import { addWorktree, copyIgnoredFiles, defaultWorktreeRoot } from '../git/worktrees';
import { RunPlan } from '../ui/picker';
import { branchName, shortRunId, variantLabel } from '../util/text';
import { log } from '../util/log';
import { RankedVariant, RunRecord, VariantState } from '../util/types';
import { runAll } from './runner';
import { runAllLm } from './lmRunner';
import { buildPreview } from './preview';
import { runCheck } from '../score/checks';
import { runJudge } from '../score/judge';
import { runLmJudge } from '../score/lmJudge';
import { rankVariants } from '../score/aggregate';

export interface RunCallbacks {
  onChange: (run: RunRecord, ranking: RankedVariant[]) => void;
  onBusy: (message: string | undefined) => void;
}

function config() {
  return vscode.workspace.getConfiguration('bestOfN');
}

export class RunController {
  private run: RunRecord | undefined;
  private ranking: RankedVariant[] = [];
  private cancellation: vscode.CancellationTokenSource | undefined;
  private readonly diffs = new Map<string, string>();

  constructor(
    private readonly invocation: CliInvocation | undefined,
    private readonly storageDir: string,
    private readonly callbacks: RunCallbacks,
  ) {}

  get current(): RunRecord | undefined {
    return this.run;
  }

  get currentRanking(): RankedVariant[] {
    return this.ranking;
  }

  get isRunning(): boolean {
    return this.run?.status === 'running';
  }

  variant(id: string): VariantState | undefined {
    return this.run?.variants.find((v) => v.id === id);
  }

  cancel(): void {
    this.cancellation?.cancel();
  }

  private emit(): void {
    if (this.run) {
      this.callbacks.onChange(this.run, this.ranking);
    }
  }

  private async buildVariants(plan: RunPlan, runId: string, worktreeRoot: string): Promise<VariantState[]> {
    const variants: VariantState[] = [];
    for (const entry of plan.selection) {
      for (let replica = 1; replica <= entry.count; replica++) {
        const id = `${entry.model}-${replica}`;
        const branch = branchName(runId, entry.model, replica);
        const label = variantLabel(entry.model, replica, entry.count);
        const artifactDir = path.join(this.storageDir, runId, id.replace(/[^\w.-]+/g, '-'));
        variants.push({
          id,
          label,
          model: entry.model,
          replica,
          branch,
          worktreePath: path.join(worktreeRoot, runId, id.replace(/[^\w.-]+/g, '-')),
          sessionId: randomUUID(),
          status: 'queued',
          queuedAt: Date.now(),
          assistantText: '',
          toolCalls: [],
          transcriptPath: path.join(artifactDir, 'transcript.jsonl'),
          usagePath: path.join(artifactDir, 'usage.json'),
          sharePath: path.join(artifactDir, 'session.md'),
        });
      }
    }
    return variants;
  }

  async start(plan: RunPlan, repoRoot: string): Promise<void> {
    const runId = shortRunId();
    const configuredRoot = config().get<string>('worktreeRoot', '').trim();
    const worktreeRoot = configuredRoot.length > 0 ? configuredRoot : defaultWorktreeRoot(repoRoot);

    const baseBranch = (await currentBranch(repoRoot)) ?? plan.baseRef;
    // Pin the base to an immutable commit so later commits on the branch cannot shift
    // what each variant is diffed against.
    const baseSha = await headSha(repoRoot).catch(() => plan.baseRef);
    const baseRef = plan.baseRef === 'HEAD' ? baseSha : plan.baseRef;

    const variants = await this.buildVariants(plan, runId, worktreeRoot);
    const maxConcurrent = Math.max(
      1,
      plan.maxConcurrent ?? config().get<number>('maxConcurrent', 4),
    );

    this.run = {
      runId,
      prompt: plan.prompt,
      repoRoot,
      baseRef,
      baseBranch,
      worktreeRoot,
      createdAt: Date.now(),
      variants,
      maxConcurrent,
      status: 'running',
    };
    this.ranking = [];
    this.diffs.clear();
    this.emit();

    this.cancellation = new vscode.CancellationTokenSource();
    const token = this.cancellation.token;

    try {
      this.callbacks.onBusy(`Creating ${variants.length} worktrees...`);
      const ignoredPatterns = config().get<string[]>('copyIgnoredFiles', []);
      for (const variant of variants) {
        await addWorktree(repoRoot, variant.worktreePath, variant.branch, baseRef);
        await copyIgnoredFiles(repoRoot, variant.worktreePath, ignoredPatterns);
        await fs.mkdir(path.dirname(variant.transcriptPath), { recursive: true });
      }
      this.callbacks.onBusy(undefined);

      const engine = config().get<string>('engine', 'lm');
      if (engine === 'cli') {
        if (!this.invocation) {
          throw new Error('The CLI engine is selected but the Copilot CLI could not be found.');
        }
        await runAll(variants, {
          invocation: this.invocation,
          prompt: plan.prompt,
          maxConcurrent,
          denyTools: config().get<string[]>('denyTools', []),
          disableBuiltinMcps: config().get<boolean>('disableBuiltinMcps', true),
          maxAiCredits: config().get<number>('maxAiCredits', 0),
          onUpdate: () => this.emit(),
          onLog: (message) => log().info(message),
          token,
        });
      } else {
        await runAllLm(variants, {
          prompt: plan.prompt,
          maxConcurrent,
          onUpdate: () => this.emit(),
          onLog: (message) => log().info(message),
          token,
        });
      }

      await this.postProcess(token);
      await this.judgeAndRank(token);

      this.run.status = token.isCancellationRequested ? 'cancelled' : 'finished';
      this.run.finishedAt = Date.now();
      this.emit();
    } finally {
      this.callbacks.onBusy(undefined);
      this.cancellation?.dispose();
      this.cancellation = undefined;
    }
  }

  /** Capture each variant's work as a commit, measure it, and verify it. */
  private async postProcess(token: vscode.CancellationToken): Promise<void> {
    if (!this.run) {
      return;
    }
    const verifyCommand = config().get<string>('verifyCommand', '').trim();
    const verifyTimeout = config().get<number>('verifyTimeoutMs', 600_000);

    for (const variant of this.run.variants) {
      if (variant.status !== 'done') {
        continue;
      }
      try {
        await commitVariantWork(variant.worktreePath, `Best of N: ${variant.label}`);
        variant.diff = await diffStat(this.run.repoRoot, this.run.baseRef, variant.branch);
        this.diffs.set(variant.id, await diffText(this.run.repoRoot, this.run.baseRef, variant.branch));
        variant.preview = await buildPreview(variant.worktreePath, variant.diff.files);
      } catch (err) {
        log().warn(`Could not capture changes for ${variant.label}: ${String(err)}`);
      }
      this.emit();
    }

    if (verifyCommand.length === 0 || token.isCancellationRequested) {
      return;
    }

    this.callbacks.onBusy(`Running "${verifyCommand}" in each worktree...`);
    for (const variant of this.run.variants) {
      if (variant.status !== 'done' || !variant.diff || variant.diff.empty) {
        continue;
      }
      if (token.isCancellationRequested) {
        break;
      }
      variant.status = 'verifying';
      this.emit();
      variant.check = await runCheck(verifyCommand, variant.worktreePath, verifyTimeout);
      variant.status = 'done';
      this.emit();
    }
    this.callbacks.onBusy(undefined);
  }

  private async judgeAndRank(token: vscode.CancellationToken): Promise<void> {
    if (!this.run) {
      return;
    }

    if (config().get<boolean>('judge.enabled', true) && !token.isCancellationRequested) {
      this.callbacks.onBusy('Judging the variants...');
      const engine = config().get<string>('engine', 'lm');
      const judgeModel = config().get<string>('judge.model', '');
      const maxDiffBytes = config().get<number>('judge.maxDiffBytes', 60_000);

      this.run.judge =
        engine === 'cli' && this.invocation
          ? await runJudge(this.run.variants, {
              invocation: this.invocation,
              model: judgeModel,
              prompt: this.run.prompt,
              maxDiffBytes,
              diffs: this.diffs,
              onLog: (message) => log().warn(message),
            })
          : await runLmJudge(this.run.variants, {
              model: judgeModel,
              prompt: this.run.prompt,
              maxDiffBytes,
              diffs: this.diffs,
              token,
              onLog: (message) => log().warn(message),
            });
      this.callbacks.onBusy(undefined);
    }

    this.ranking = rankVariants(this.run.variants, this.run.judge);
    this.emit();
  }

  setWinner(variantId: string): void {
    if (this.run) {
      this.run.winnerId = variantId;
      this.emit();
    }
  }

  clear(): void {
    this.run = undefined;
    this.ranking = [];
    this.diffs.clear();
  }
}
