import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CliInvocation, spawnCli } from '../cli/locate';
import { JsonlParser } from '../run/jsonl';
import { JudgeVerdict, VariantState } from '../util/types';
import { extractJsonObject, truncate } from '../util/text';
import { summarizeCheck } from './aggregate';

export interface JudgeOptions {
  invocation: CliInvocation;
  model: string;
  prompt: string;
  maxDiffBytes: number;
  diffs: Map<string, string>;
  onLog: (message: string) => void;
}

export function buildJudgePrompt(
  originalPrompt: string,
  variants: VariantState[],
  diffs: Map<string, string>,
  maxDiffBytes: number,
): string {
  const sections = variants.map((variant) => {
    const diff = diffs.get(variant.id) ?? '';
    const stat = variant.diff
      ? `${variant.diff.filesChanged} files changed, +${variant.diff.insertions}/-${variant.diff.deletions}`
      : 'no diff computed';
    return [
      `### Variant ${variant.id}`,
      `- model: ${variant.model}`,
      `- outcome: ${variant.status}`,
      `- diff: ${stat}`,
      `- verification: ${summarizeCheck(variant.check)}`,
      '',
      '```diff',
      truncate(diff, maxDiffBytes),
      '```',
      '',
      '---',
      '',
    ].join('\n');
  });

  return [
    'You are judging several independent attempts at the same software task.',
    'Each attempt was produced by a different coding agent working in its own isolated git worktree.',
    '',
    '## The task the agents were given',
    '',
    originalPrompt,
    '',
    '## The attempts',
    '',
    ...sections,
    '## What to do',
    '',
    'Evaluate each attempt on: correctness, completeness against the task, code quality,',
    'and absence of unnecessary or destructive changes. Penalise attempts that changed',
    'unrelated code, left debugging artefacts, or failed their verification command.',
    '',
    'Reply with ONLY a JSON object, no prose before or after, in exactly this shape:',
    '',
    '{',
    '  "ranking": [{"variantId": "<id>", "score": <0-10>, "reasoning": "<one or two sentences>"}],',
    '  "winner": "<id of the best attempt>",',
    '  "caveats": "<anything the human should check before merging, or an empty string>"',
    '}',
    '',
    'Include every variant in "ranking", best first. Do not use any tools; judge only from the diffs above.',
  ].join('\n');
}

/**
 * Run one extra CLI call that reads every diff and ranks them. Runs in a temp directory
 * with write and shell tools denied, so judging can never touch the repository.
 */
export async function runJudge(
  variants: VariantState[],
  options: JudgeOptions,
): Promise<JudgeVerdict> {
  const judgeable = variants.filter((v) => v.status === 'done' && v.diff && !v.diff.empty);
  if (judgeable.length < 2) {
    return {
      ranking: [],
      error: 'Fewer than two variants produced changes, so there was nothing to compare.',
    };
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bon-judge-'));
  const args = [
    '--allow-all-tools',
    '--output-format',
    'json',
    '--no-color',
    '--disable-builtin-mcps',
    '--deny-tool=write',
    '--deny-tool=shell',
  ];
  if (options.model.trim().length > 0) {
    args.push('--model', options.model.trim());
  }

  const prompt = buildJudgePrompt(options.prompt, judgeable, options.diffs, options.maxDiffBytes);

  try {
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawnCli(options.invocation, args, {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
      });

      const parser = new JsonlParser();
      let assistantText = '';
      let stderr = '';

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        for (const event of parser.push(chunk).events) {
          if (event.type === 'assistant.message') {
            const content = event.data?.['content'];
            if (typeof content === 'string') {
              assistantText = content;
            }
          } else if (event.type === 'assistant.message_delta' && assistantText === '') {
            const delta = event.data?.['deltaContent'];
            if (typeof delta === 'string') {
              // Only used if no consolidated message arrives.
              assistantText += delta;
            }
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => (stderr += chunk));

      child.on('error', reject);
      child.on('close', (code) => {
        parser.flush();
        if (assistantText.trim().length > 0) {
          resolve(assistantText);
        } else {
          reject(new Error(`Judge exited with code ${code}. ${stderr.trim().slice(-500)}`));
        }
      });

      child.stdin?.on('error', () => undefined);
      child.stdin?.end(prompt, 'utf8');
    });

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
      winner: typeof parsed.winner === 'string' && validIds.has(parsed.winner) ? parsed.winner : undefined,
      caveats: typeof parsed.caveats === 'string' ? parsed.caveats : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.onLog(`Judge failed: ${message}`);
    return { ranking: [], error: message };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
