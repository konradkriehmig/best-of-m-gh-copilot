import * as vscode from 'vscode';
import { JudgeVerdict, VariantState } from '../util/types';
import { extractJsonObject } from '../util/text';
import { buildJudgePrompt } from './judge';
import { selectModel } from '../run/lmAgent';

/**
 * Rank the variants using a Copilot model inside VS Code. No tools are offered, so the
 * judge can only read the diffs it is given and can never touch the repository.
 */
export async function runLmJudge(
  variants: VariantState[],
  options: {
    model: string;
    prompt: string;
    maxDiffBytes: number;
    diffs: Map<string, string>;
    token: vscode.CancellationToken;
    onLog: (message: string) => void;
  },
): Promise<JudgeVerdict> {
  const judgeable = variants.filter((v) => v.status === 'done' && v.diff && !v.diff.empty);
  if (judgeable.length < 2) {
    return {
      ranking: [],
      error: 'Fewer than two variants produced changes, so there was nothing to compare.',
    };
  }

  try {
    const model = options.model.trim().length > 0
      ? await selectModel(options.model.trim())
      : (await vscode.lm.selectChatModels({ vendor: 'copilot' }))[0];

    if (!model) {
      return { ranking: [], error: 'No Copilot model was available to judge the results.' };
    }

    const prompt = buildJudgePrompt(options.prompt, judgeable, options.diffs, options.maxDiffBytes);
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: 'Best of N compares the results of several parallel attempts.' },
      options.token,
    );

    let text = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }
    }

    const parsed = extractJsonObject(text) as
      | { ranking?: unknown; winner?: unknown; caveats?: unknown }
      | undefined;

    if (!parsed || !Array.isArray(parsed.ranking)) {
      return { ranking: [], error: 'The judge did not return parseable JSON.' };
    }

    const validIds = new Set(judgeable.map((v) => v.id));
    const ranking = parsed.ranking
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry?.['variantId'] === 'string')
      .map((entry) => ({
        variantId: String(entry['variantId']),
        score: Number(entry['score']) || 0,
        reasoning: typeof entry['reasoning'] === 'string' ? entry['reasoning'] : '',
      }))
      .filter((entry) => validIds.has(entry.variantId));

    return {
      ranking,
      winner:
        typeof parsed.winner === 'string' && validIds.has(parsed.winner) ? parsed.winner : undefined,
      caveats: typeof parsed.caveats === 'string' ? parsed.caveats : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.onLog(`Judge failed: ${message}`);
    return { ranking: [], error: message };
  }
}
