import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { BestOfNTool, BestOfNToolInput } from './chatTool';
import { ChatRunHost } from './chatParticipant';
import { RunPlan } from './picker';
import { RankedVariant, RunRecord, VariantState } from '../util/types';

const noToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as unknown as vscode.CancellationToken;

function variant(over: Partial<VariantState> = {}): VariantState {
  return {
    id: 'v1',
    label: 'claude-opus-5 #1',
    model: 'claude-opus-5',
    replica: 1,
    branch: 'bon/r1/claude-opus-5-1',
    worktreePath: '/tmp/wt',
    sessionId: 's',
    status: 'done',
    queuedAt: 0,
    startedAt: 1000,
    endedAt: 4000,
    assistantText: '',
    toolCalls: [],
    diff: { filesChanged: 2, insertions: 30, deletions: 4, files: ['a.ts'], empty: false },
    transcriptPath: '',
    usagePath: '',
    sharePath: '',
    ...over,
  };
}

function run(variants: VariantState[], judge?: RunRecord['judge']): RunRecord {
  return {
    runId: 'r1',
    prompt: 'do the thing',
    repoRoot: '/repo',
    baseRef: 'abc123',
    baseBranch: 'master',
    worktreeRoot: '/wt',
    createdAt: 0,
    variants,
    judge,
    status: 'finished',
  };
}

function host(over: Partial<ChatRunHost> = {}): ChatRunHost {
  return {
    resolveRepoRoot: async () => '/repo',
    isRunning: () => false,
    execute: async () => undefined,
    ...over,
  };
}

async function invoke(tool: BestOfNTool, input: BestOfNToolInput) {
  return tool.invoke(
    { input } as vscode.LanguageModelToolInvocationOptions<BestOfNToolInput>,
    noToken,
  );
}

function resultText(result: vscode.LanguageModelToolResult): string {
  return (result.content as Array<{ value: string }>).map((p) => p.value).join('');
}

describe('BestOfNTool.invoke', () => {
  it('rejects an empty prompt with guidance for the model', async () => {
    const tool = new BestOfNTool(host());
    await expect(invoke(tool, { prompt: '  ' })).rejects.toThrow(/"prompt" parameter is required/);
  });

  it('refuses to start a second concurrent run', async () => {
    const tool = new BestOfNTool(host({ isRunning: () => true }));
    await expect(invoke(tool, { prompt: 'x', models: ['m'] })).rejects.toThrow(/already in progress/);
  });

  it('reports a missing repository', async () => {
    const tool = new BestOfNTool(host({ resolveRepoRoot: async () => undefined }));
    await expect(invoke(tool, { prompt: 'x', models: ['m'] })).rejects.toThrow(/git repository/);
  });

  it('passes the model spec through, expanding replicas', async () => {
    let seen: RunPlan | undefined;
    const tool = new BestOfNTool(
      host({
        execute: async (plan) => {
          seen = plan;
          return { run: run([variant()]), ranking: [] };
        },
      }),
    );

    await invoke(tool, { prompt: 'do the thing', models: ['claude-opus-5 x2', 'gpt-5.6-sol'] });

    expect(seen?.prompt).toBe('do the thing');
    expect(seen?.selection).toEqual([
      { model: 'claude-opus-5', count: 2 },
      { model: 'gpt-5.6-sol', count: 1 },
    ]);
  });

  it('fails clearly when no models are configured and the user cancels the picker', async () => {
    const tool = new BestOfNTool(host());
    await expect(invoke(tool, { prompt: 'x' })).rejects.toThrow(/No models were selected/);
  });

  it('renders a ranked table and tells the model not to redo the work', async () => {
    const ranked: RankedVariant[] = [
      { variant: variant(), rank: 1, score: 1000, reasons: [] },
      {
        variant: variant({ id: 'v2', label: 'gpt #1', model: 'gpt-5.6-sol', branch: 'bon/r1/gpt-1' }),
        rank: 2,
        score: 900,
        reasons: [],
      },
    ];
    const tool = new BestOfNTool(
      host({
        execute: async () => ({
          run: run(
            ranked.map((r) => r.variant),
            { ranking: [{ variantId: 'v1', score: 9, reasoning: 'cleanest diff' }], winner: 'v1' },
          ),
          ranking: ranked,
        }),
      }),
    );

    const text = resultText(await invoke(tool, { prompt: 'x', models: ['m'] }));

    expect(text).toContain('| 1 | claude-opus-5 |');
    expect(text).toContain('| 2 | gpt-5.6-sol |');
    expect(text).toContain('2 files +30/-4');
    expect(text).toContain('judge 9/10: cleanest diff');
    expect(text).toContain('bon/r1/claude-opus-5-1');
    expect(text).toMatch(/do not attempt to reproduce or re-implement the work yourself/i);
  });

  it('says so when nothing changed', async () => {
    const empty = variant({
      diff: { filesChanged: 0, insertions: 0, deletions: 0, files: [], empty: true },
    });
    const tool = new BestOfNTool(
      host({ execute: async () => ({ run: run([empty]), ranking: [] }) }),
    );

    const text = resultText(await invoke(tool, { prompt: 'x', models: ['m'] }));
    expect(text).toContain('nothing to merge');
  });

  it('surfaces a run that never started', async () => {
    const tool = new BestOfNTool(host({ execute: async () => undefined }));
    await expect(invoke(tool, { prompt: 'x', models: ['m'] })).rejects.toThrow(/did not start/);
  });
});

describe('BestOfNTool.prepareInvocation', () => {
  it('states the cost multiple in the confirmation', async () => {
    const tool = new BestOfNTool(host());
    const prepared = await tool.prepareInvocation({
      input: { prompt: 'do the thing', models: ['a x2', 'b'] },
    } as vscode.LanguageModelToolInvocationPrepareOptions<BestOfNToolInput>);

    expect(prepared.confirmationMessages?.title).toContain('3 parallel attempts');
    const message = prepared.confirmationMessages?.message as vscode.MarkdownString;
    expect(message.value).toContain('3x a single');
    expect(message.value).toContain('do the thing');
  });
});
