import { describe, expect, it } from 'vitest';
import { buildJudgePrompt } from './judge';
import { VariantState } from '../util/types';

function variant(id: string, model: string): VariantState {
  return {
    id,
    label: id,
    model,
    replica: 1,
    branch: `bon/test/${id}`,
    worktreePath: `/tmp/${id}`,
    sessionId: id,
    status: 'done',
    queuedAt: 0,
    assistantText: '',
    toolCalls: [],
    transcriptPath: '',
    usagePath: '',
    sharePath: '',
    diff: { filesChanged: 1, insertions: 3, deletions: 1, files: ['a.ts'], empty: false },
  };
}

describe('buildJudgePrompt', () => {
  const variants = [variant('a', 'model-a'), variant('b', 'model-b')];
  const diffs = new Map([
    ['a', 'diff --git a/a.ts b/a.ts\n+one'],
    ['b', 'diff --git a/a.ts b/a.ts\n+two'],
  ]);

  it('includes the original task and every variant', () => {
    const prompt = buildJudgePrompt('Add retries', variants, diffs, 10_000);
    expect(prompt).toContain('Add retries');
    expect(prompt).toContain('### Variant a');
    expect(prompt).toContain('### Variant b');
    expect(prompt).toContain('+one');
    expect(prompt).toContain('+two');
  });

  it('asks for a strict JSON response shape', () => {
    const prompt = buildJudgePrompt('task', variants, diffs, 10_000);
    expect(prompt).toContain('"ranking"');
    expect(prompt).toContain('"winner"');
    expect(prompt).toContain('ONLY a JSON object');
  });

  it('truncates oversized diffs so the prompt stays bounded', () => {
    const huge = new Map([
      ['a', 'x'.repeat(50_000)],
      ['b', 'y'.repeat(50_000)],
    ]);
    const prompt = buildJudgePrompt('task', variants, huge, 1_000);
    expect(prompt).toContain('[truncated]');
    expect(prompt.length).toBeLessThan(10_000);
  });

  it('reports verification status for each variant', () => {
    const prompt = buildJudgePrompt('task', variants, diffs, 10_000);
    expect(prompt).toContain('verification: not run');
  });
});
