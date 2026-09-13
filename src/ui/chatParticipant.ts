import * as vscode from 'vscode';
import { RunPlan } from './picker';
import { discoverModels } from '../models/registry';
import { parseFanOut, formatDuration } from '../util/text';
import { summarizeCheck } from '../score/aggregate';
import { RankedVariant, RunRecord, VariantState } from '../util/types';

export const PARTICIPANT_ID = 'bestOfN.chat';

export interface ChatRunHost {
  /** Resolves the repository for the active workspace, or reports why it cannot. */
  resolveRepoRoot(): Promise<string | undefined>;
  /** True while a run is already in flight. */
  isRunning(): boolean;
  /** Executes the fan-out, reporting coarse progress. Resolves with the finished run. */
  execute(
    plan: RunPlan,
    repoRoot: string,
    onProgress: (message: string) => void,
    token: vscode.CancellationToken,
  ): Promise<{ run: RunRecord; ranking: RankedVariant[] } | undefined>;
}

function config() {
  return vscode.workspace.getConfiguration('bestOfN');
}

/**
 * Resolve which models to fan out to. The configured set wins; otherwise the user is
 * asked once and the answer is persisted, so later prompts run without friction.
 */
async function resolveFanOut(
  stream: vscode.ChatResponseStream,
): Promise<Array<{ model: string; count: number }> | undefined> {
  const configured = parseFanOut(config().get<string[]>('chat.fanOut', []));
  if (configured.length > 0) {
    return configured;
  }

  stream.markdown(
    'No fan-out set is configured yet, so pick the models to run this and future prompts against.\n\n',
  );
  const chosen = await promptForFanOut();
  if (!chosen) {
    stream.markdown('No models were selected, so nothing ran.');
    return undefined;
  }
  return chosen;
}

/** Quick pick for the fan-out set, persisted to settings. */
export async function promptForFanOut(): Promise<
  Array<{ model: string; count: number }> | undefined
> {
  const models = await discoverModels();
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({ label: m.id, description: m.detail })),
    {
      title: 'Best of N: models to fan out to',
      placeHolder: 'Pick the models every @bestofn prompt should run against',
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (!picked || picked.length === 0) {
    return undefined;
  }

  const replicas = await vscode.window.showInputBox({
    title: 'Best of N: sessions per model',
    prompt: 'How many parallel sessions per selected model?',
    value: picked.length === 1 ? '3' : '1',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 10 ? undefined : 'Enter a whole number from 1 to 10.';
    },
  });
  if (replicas === undefined) {
    return undefined;
  }

  const count = Number(replicas);
  const spec = picked.map((p) => (count > 1 ? `${p.label} x${count}` : p.label));
  await config().update('chat.fanOut', spec, vscode.ConfigurationTarget.Global);

  return parseFanOut(spec);
}

function statusIcon(variant: VariantState): string {
  switch (variant.status) {
    case 'done':
      return variant.diff && !variant.diff.empty ? 'ok' : 'no changes';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return variant.status;
  }
}

/** Render the finished run as a comparison table plus per-variant actions. */
function renderResults(
  stream: vscode.ChatResponseStream,
  run: RunRecord,
  ranking: RankedVariant[],
): void {
  const ordered = ranking.length > 0 ? ranking.map((r) => r.variant) : run.variants;

  stream.markdown('\n\n| # | Model | Result | Diff | Checks | Cost | Time |\n');
  stream.markdown('|---|---|---|---|---|---|---|\n');

  for (const [index, variant] of ordered.entries()) {
    const diff = variant.diff && !variant.diff.empty
      ? `${variant.diff.filesChanged} files +${variant.diff.insertions}/-${variant.diff.deletions}`
      : '-';
    const cost = typeof variant.usage?.totalPremiumRequestCost === 'number'
      ? variant.usage.totalPremiumRequestCost.toFixed(2)
      : '-';
    const time = variant.startedAt && variant.endedAt
      ? formatDuration(variant.endedAt - variant.startedAt)
      : '-';
    stream.markdown(
      `| ${index + 1} | ${variant.label} | ${statusIcon(variant)} | ${diff} | ` +
        `${summarizeCheck(variant.check)} | ${cost} | ${time} |\n`,
    );
  }

  if (run.judge?.error) {
    stream.markdown(`\n_Judge unavailable: ${run.judge.error}_\n`);
  }
  for (const entry of run.judge?.ranking ?? []) {
    const variant = run.variants.find((v) => v.id === entry.variantId);
    if (variant && entry.reasoning) {
      stream.markdown(`\n**${variant.label}** - judge ${entry.score}/10: ${entry.reasoning}\n`);
    }
  }
  if (run.judge?.caveats) {
    stream.markdown(`\n**Before merging:** ${run.judge.caveats}\n`);
  }

  const usable = ordered.filter((v) => v.status === 'done' && v.diff && !v.diff.empty);
  if (usable.length === 0) {
    stream.markdown('\nNo variant produced any changes, so there is nothing to merge.\n');
    return;
  }

  stream.markdown('\n');
  for (const variant of usable) {
    stream.button({
      command: 'bestOfN.keepVariant',
      title: `Keep ${variant.label}`,
      arguments: [variant.id],
    });
    stream.button({
      command: 'bestOfN.showVariantDiff',
      title: `Diff ${variant.label}`,
      arguments: [variant.id],
    });
  }
  stream.button({ command: 'bestOfN.showDashboard', title: 'Open dashboard' });
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  host: ChatRunHost,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
    if (request.command === 'models') {
      const chosen = await promptForFanOut();
      if (chosen) {
        const summary = chosen.map((c) => `${c.count}x ${c.model}`).join(', ');
        stream.markdown(`Fan-out set to **${summary}**. Send a prompt with \`@bestofn\` to use it.`);
      } else {
        stream.markdown('Fan-out unchanged.');
      }
      return {};
    }

    const prompt = request.prompt.trim();
    if (prompt.length === 0) {
      stream.markdown(
        'Give me a task and I will run it across several models at once, each in its own git ' +
          'worktree, then compare the results.\n\n' +
          'Example: `@bestofn add retry with exponential backoff to the HTTP client`\n\n' +
          'Use `/models` to choose which models to fan out to.',
      );
      return {};
    }

    if (host.isRunning()) {
      stream.markdown('A Best of N run is already in progress. Wait for it to finish, or cancel it.');
      stream.button({ command: 'bestOfN.cancelRun', title: 'Cancel the running fan-out' });
      return {};
    }

    const repoRoot = await host.resolveRepoRoot();
    if (!repoRoot) {
      stream.markdown('Best of N needs an open folder inside a git repository.');
      return {};
    }

    const selection = await resolveFanOut(stream);
    if (!selection) {
      return {};
    }

    const total = selection.reduce((sum, entry) => sum + entry.count, 0);
    const breakdown = selection.map((s) => `${s.count}x ${s.model}`).join(', ');

    // N independent agents cost roughly N times a single session, so say so up front
    // rather than burying it in a setting.
    stream.markdown(
      `Running **${total} parallel sessions** (${breakdown}), each in its own git worktree.\n\n` +
        `This costs roughly ${total}x a single session. Your working tree is not touched.\n`,
    );

    const plan: RunPlan = { prompt, selection, baseRef: 'HEAD' };
    stream.progress(`Creating ${total} worktrees...`);

    try {
      const result = await host.execute(plan, repoRoot, (message) => stream.progress(message), token);
      if (!result) {
        stream.markdown('\nThe run did not start.');
        return {};
      }
      if (token.isCancellationRequested) {
        stream.markdown('\nCancelled.');
        return {};
      }
      renderResults(stream, result.run, result.ranking);
      return {};
    } catch (err) {
      stream.markdown(`\nThe run failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('run-all');
  context.subscriptions.push(participant);
  return participant;
}
