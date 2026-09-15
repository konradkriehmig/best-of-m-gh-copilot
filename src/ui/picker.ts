import * as vscode from 'vscode';
import { discoverModels, ModelOption } from '../models/registry';
import { listBranches, currentBranch } from '../git/exec';

function config() {
  return vscode.workspace.getConfiguration('bestOfN');
}

export interface RunPlan {
  prompt: string;
  /** Model id to number of replicas. */
  selection: Array<{ model: string; count: number }>;
  baseRef: string;
  /** Overrides `bestOfN.maxConcurrent` for this run only. */
  maxConcurrent?: number;
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
  option: ModelOption;
}

async function pickPrompt(): Promise<string | undefined> {
  const prompt = await vscode.window.showInputBox({
    title: 'Best of N (1/4): the prompt',
    prompt: 'The task every variant will attempt independently',
    placeHolder: 'e.g. Add retry with exponential backoff to the HTTP client and cover it with tests',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length < 3 ? 'Enter a prompt of at least 3 characters.' : undefined,
  });
  return prompt?.trim();
}

async function pickModels(): Promise<ModelOption[] | undefined> {
  const models = await discoverModels();
  const items: ModelQuickPickItem[] = models.map((option) => ({
    label: option.id,
    description: option.detail,
    option,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Best of N (2/4): models',
    placeHolder: 'Select the models to run. Pick one model to do best-of-N on a single model.',
    canPickMany: true,
    ignoreFocusOut: true,
  });

  if (!picked || picked.length === 0) {
    return undefined;
  }
  return picked.map((item) => item.option);
}

async function pickCounts(
  models: ModelOption[],
): Promise<Array<{ model: string; count: number }> | undefined> {
  const selection: Array<{ model: string; count: number }> = [];

  for (const [index, model] of models.entries()) {
    const answer = await vscode.window.showInputBox({
      title: `Best of N (3/4): sessions for ${model.id} (${index + 1}/${models.length})`,
      prompt: `How many parallel sessions should run on ${model.id}?`,
      value: models.length === 1 ? '3' : '1',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return 'Enter a whole number of 1 or more.';
        }
        if (n > 10) {
          return 'That is a lot of parallel agents. Keep it to 10 or fewer per model.';
        }
        return undefined;
      },
    });
    if (answer === undefined) {
      return undefined;
    }
    selection.push({ model: model.id, count: Number(answer) });
  }

  return selection;
}

async function pickBaseRef(repoRoot: string): Promise<string | undefined> {
  const branch = await currentBranch(repoRoot);
  const branches = await listBranches(repoRoot);

  const items: vscode.QuickPickItem[] = [];
  if (branch) {
    items.push({
      label: branch,
      description: 'current branch',
      detail: 'Variants branch from here, and the winner merges back into it',
    });
  }
  items.push({ label: 'HEAD', description: 'current commit' });
  for (const candidate of branches) {
    if (candidate !== branch) {
      items.push({ label: candidate });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Best of N (4/4): base',
    placeHolder: 'Which ref should every variant start from?',
    ignoreFocusOut: true,
  });
  return picked?.label;
}

/**
 * Confirms the run and settles how many variants may run at once.
 *
 * When the selection exceeds `bestOfN.maxConcurrent` the excess would silently sit in a
 * QUEUED state, which reads as a bug rather than a deliberate cap. So the choice is offered
 * here, at the only moment the user is thinking about how many agents to start.
 *
 * Returns the concurrency limit to use, or undefined if the user cancelled.
 */
async function confirm(plan: RunPlan): Promise<number | undefined> {
  const total = plan.selection.reduce((sum, entry) => sum + entry.count, 0);
  const breakdown = plan.selection.map((s) => `${s.count}x ${s.model}`).join(', ');
  const configured = Math.max(1, config().get<number>('maxConcurrent', 4));
  const capped = total > configured;

  const shared =
    `${breakdown}\n\nBase: ${plan.baseRef}\n\n` +
    `This starts ${total} independent agents, so it costs roughly ${total}x a single ` +
    `session in AI credits. Each one edits only its own worktree. Worktrees share your ` +
    `filesystem and credentials and are not a security boundary.`;

  if (!capped) {
    const choice = await vscode.window.showWarningMessage(
      `Run ${total} parallel agent sessions?`,
      { modal: true, detail: shared },
      'Run',
    );
    return choice === 'Run' ? configured : undefined;
  }

  const stagger = `Run ${configured} at a time`;
  const all = `Run all ${total} at once`;
  const choice = await vscode.window.showWarningMessage(
    `Run ${total} agent sessions?`,
    {
      modal: true,
      detail:
        `${shared}\n\n` +
        `bestOfN.maxConcurrent is ${configured}, so ${total - configured} of them would wait ` +
        `in a queue until a slot frees up. Running all at once is faster but hits Copilot ` +
        `with ${total} simultaneous requests, which may be rate limited.`,
    },
    stagger,
    all,
  );

  if (choice === stagger) {
    return configured;
  }
  return choice === all ? total : undefined;
}

export async function buildRunPlan(repoRoot: string): Promise<RunPlan | undefined> {
  const prompt = await pickPrompt();
  if (!prompt) {
    return undefined;
  }

  const models = await pickModels();
  if (!models) {
    return undefined;
  }

  const selection = await pickCounts(models);
  if (!selection) {
    return undefined;
  }

  const baseRef = await pickBaseRef(repoRoot);
  if (!baseRef) {
    return undefined;
  }

  const plan: RunPlan = { prompt, selection, baseRef };
  const maxConcurrent = await confirm(plan);
  if (maxConcurrent === undefined) {
    return undefined;
  }
  return { ...plan, maxConcurrent };
}
