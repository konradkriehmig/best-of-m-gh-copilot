import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runLmAgent, selectModel } from './lmAgent';
import { VariantState, VariantStatus } from '../util/types';

export interface LmRunnerOptions {
  prompt: string;
  maxConcurrent: number;
  onUpdate: (variant: VariantState) => void;
  onLog: (message: string) => void;
  token: vscode.CancellationToken;
}

function describeError(err: unknown): string {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case 'NoPermissions':
        return 'Access to Copilot models was denied. Allow this extension to use Copilot and try again.';
      case 'Blocked':
        return 'The request was blocked by Copilot content filtering.';
      case 'NotFound':
        return `That model is not available: ${err.message}`;
      default:
        return `Copilot returned an error: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The language model API streams no durable transcript, so write one ourselves. This is
 * what the dashboard's transcript button opens.
 */
async function writeTranscript(variant: VariantState, prompt: string): Promise<void> {
  const lines = [
    `# ${variant.label}`,
    '',
    `- model: \`${variant.model}\``,
    `- branch: \`${variant.branch}\``,
    `- outcome: ${variant.status}`,
    variant.error ? `- error: ${variant.error}` : '',
    '',
    '## Prompt',
    '',
    prompt,
    '',
    '## Tool calls',
    '',
    variant.toolCalls.length > 0
      ? variant.toolCalls.map((call, i) => `${i + 1}. \`${call.name}\` - ${call.status}`).join('\n')
      : '_none_',
    '',
    '## Final message',
    '',
    variant.assistantText.trim().length > 0 ? variant.assistantText : '_none_',
    '',
  ];

  try {
    await fs.mkdir(path.dirname(variant.sharePath), { recursive: true });
    await fs.writeFile(variant.sharePath, lines.filter((l) => l !== '').join('\n') + '\n', 'utf8');
  } catch {
    // A missing transcript is not worth failing a run over.
  }
}

async function runOne(variant: VariantState, options: LmRunnerOptions): Promise<void> {
  if (options.token.isCancellationRequested) {
    variant.status = 'cancelled';
    options.onUpdate(variant);
    return;
  }

  variant.status = 'running';
  variant.startedAt = Date.now();
  variant.activity = 'selecting model';
  options.onUpdate(variant);

  try {
    const model = await selectModel(variant.model);
    options.onLog(`[${variant.label}] using ${model.vendor}/${model.id} (${model.name})`);

    await runLmAgent(variant, model, {
      prompt: options.prompt,
      worktreePath: variant.worktreePath,
      token: options.token,
      onUpdate: () => options.onUpdate(variant),
    });

    if ((variant.status as VariantStatus) !== 'cancelled') {
      variant.status = variant.error ? 'failed' : 'done';
    }
  } catch (err) {
    if (options.token.isCancellationRequested) {
      variant.status = 'cancelled';
    } else {
      variant.status = 'failed';
      variant.error = describeError(err);
      options.onLog(`[${variant.label}] ${variant.error}`);
    }
  } finally {
    variant.endedAt = Date.now();
    variant.activity = undefined;
    await writeTranscript(variant, options.prompt);
    options.onUpdate(variant);
  }
}

/**
 * Run every variant through the in-editor Copilot models, honouring the concurrency cap.
 * Copilot enforces its own rate limits, so the cap is a courtesy as well as a safeguard.
 */
export async function runAllLm(variants: VariantState[], options: LmRunnerOptions): Promise<void> {
  const queue = [...variants];
  const limit = Math.max(1, Math.min(options.maxConcurrent, variants.length));

  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      await runOne(next, options);
    }
  });

  await Promise.all(workers);
}
