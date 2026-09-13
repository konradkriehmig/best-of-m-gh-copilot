import * as vscode from 'vscode';
import { RunPlan } from './picker';
import { ChatRunHost, promptForFanOut } from './chatParticipant';
import { parseFanOut, formatDuration } from '../util/text';
import { summarizeCheck } from '../score/aggregate';
import { RankedVariant, RunRecord } from '../util/types';

export const TOOL_NAME = 'run_best_of_n';

export interface BestOfNToolInput {
  prompt?: string;
  models?: string[];
}

function config() {
  return vscode.workspace.getConfiguration('bestOfN');
}

/** The fan-out set for this invocation: the model's suggestion, else settings, else ask. */
async function resolveSelection(
  input: BestOfNToolInput,
): Promise<Array<{ model: string; count: number }> | undefined> {
  const requested = parseFanOut(input.models ?? []);
  if (requested.length > 0) {
    return requested;
  }
  const configured = parseFanOut(config().get<string[]>('chat.fanOut', []));
  if (configured.length > 0) {
    return configured;
  }
  return await promptForFanOut();
}

function renderResult(run: RunRecord, ranking: RankedVariant[]): string {
  const ordered = ranking.length > 0 ? ranking.map((r) => r.variant) : run.variants;
  const lines = [
    `Ran ${run.variants.length} parallel attempts at the same task, each in its own git worktree.`,
    '',
    '| # | Model | Branch | Result | Diff | Checks | Time |',
    '|---|---|---|---|---|---|---|',
  ];

  for (const [index, variant] of ordered.entries()) {
    const diff =
      variant.diff && !variant.diff.empty
        ? `${variant.diff.filesChanged} files +${variant.diff.insertions}/-${variant.diff.deletions}`
        : '-';
    const time =
      variant.startedAt && variant.endedAt
        ? formatDuration(variant.endedAt - variant.startedAt)
        : '-';
    const outcome =
      variant.status === 'done'
        ? variant.diff && !variant.diff.empty
          ? 'changed files'
          : 'no changes'
        : (variant.error ?? variant.status);
    lines.push(
      `| ${index + 1} | ${variant.model} | \`${variant.branch}\` | ${outcome} | ${diff} | ` +
        `${summarizeCheck(variant.check)} | ${time} |`,
    );
  }

  for (const entry of run.judge?.ranking ?? []) {
    const variant = run.variants.find((v) => v.id === entry.variantId);
    if (variant && entry.reasoning) {
      lines.push('', `${variant.label} - judge ${entry.score}/10: ${entry.reasoning}`);
    }
  }
  if (run.judge?.caveats) {
    lines.push('', `Caveats before merging: ${run.judge.caveats}`);
  }
  if (run.judge?.error) {
    lines.push('', `The judge did not run: ${run.judge.error}`);
  }

  const best = ordered.find((v) => v.status === 'done' && v.diff && !v.diff.empty);
  lines.push(
    '',
    'The attempts are ranked best first. Nothing has been merged into the working tree.',
    best
      ? `To take the top result, run the "Best of N: Show Dashboard" command and press "Keep this one" on ${best.label}, ` +
          `or merge its branch \`${best.branch}\` yourself.`
      : 'No attempt produced any changes, so there is nothing to merge.',
    '',
    'Report this table to the user as-is. Do not attempt to reproduce or re-implement the work yourself.',
  );

  return lines.join('\n');
}

/**
 * Exposes the fan-out to agent mode, where tools referenced with `#` replaced the older
 * `@participant` mentions. The tool is long-running by design: it waits for every variant.
 */
export class BestOfNTool implements vscode.LanguageModelTool<BestOfNToolInput> {
  constructor(private readonly host: ChatRunHost) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<BestOfNToolInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const selection =
      parseFanOut(options.input.models ?? []).length > 0
        ? parseFanOut(options.input.models ?? [])
        : parseFanOut(config().get<string[]>('chat.fanOut', []));
    const total = selection.reduce((sum, entry) => sum + entry.count, 0);
    const breakdown =
      selection.length > 0
        ? selection.map((s) => `${s.count}x ${s.model}`).join(', ')
        : 'models you will be asked to choose';

    return {
      invocationMessage: 'Running the task across several models',
      confirmationMessages: {
        title: total > 0 ? `Run ${total} parallel attempts?` : 'Run this task across several models?',
        message: new vscode.MarkdownString(
          `**Task:** ${options.input.prompt ?? '(none given)'}\n\n` +
            `**Models:** ${breakdown}\n\n` +
            (total > 0
              ? `This starts ${total} independent agents, so it costs roughly ${total}x a single ` +
                'session. Each works in its own git worktree; your working tree is not touched.'
              : 'Each attempt works in its own git worktree; your working tree is not touched.'),
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<BestOfNToolInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const prompt = (options.input.prompt ?? '').trim();
    if (prompt.length === 0) {
      throw new Error(
        'The "prompt" parameter is required. Pass the full task the attempts should each carry out.',
      );
    }

    if (this.host.isRunning()) {
      throw new Error('A Best of N run is already in progress. Wait for it to finish, or cancel it.');
    }

    const repoRoot = await this.host.resolveRepoRoot();
    if (!repoRoot) {
      throw new Error('Best of N needs an open folder inside a git repository.');
    }

    const selection = await resolveSelection(options.input);
    if (!selection || selection.length === 0) {
      throw new Error('No models were selected, so nothing ran. Ask the user which models to use.');
    }

    const plan: RunPlan = { prompt, selection, baseRef: 'HEAD' };
    const result = await this.host.execute(plan, repoRoot, () => undefined, token);

    if (!result) {
      throw new Error('The run did not start. Check the "Best of N" output channel for details.');
    }
    if (token.isCancellationRequested) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('The run was cancelled.'),
      ]);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(renderResult(result.run, result.ranking)),
    ]);
  }
}

export function registerChatTool(host: ChatRunHost): vscode.Disposable {
  return vscode.lm.registerTool(TOOL_NAME, new BestOfNTool(host));
}
