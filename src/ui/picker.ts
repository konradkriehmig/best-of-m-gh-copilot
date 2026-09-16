import * as vscode from 'vscode';
import { discoverModels, ModelOption } from '../models/registry';
import { listBranches, currentBranch } from '../git/exec';

export interface RunPlan {
  prompt: string;
  /** Model id to number of replicas. */
  selection: Array<{ model: string; count: number }>;
  baseRef: string;
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
 * The last step is choosing the base, so a run starts as soon as that is picked.
 *
 * There is deliberately no confirmation step. The four pickers already state what is about
 * to happen, and every variant can be stopped individually from the dashboard, so a modal
 * asking "are you sure" only added a click to the common case. Cost is shown in the
 * dashboard header instead, where it stays visible for the whole run.
 */
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

  return { prompt, selection, baseRef };
}
