import { describe, expect, it } from 'vitest';
import { rankVariants } from './aggregate';
import { CheckResult, DiffStat, VariantState } from '../util/types';

function variant(id: string, overrides: Partial<VariantState> = {}): VariantState {
  return {
    id,
    label: id,
    model: id,
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
    ...overrides,
  };
}

const diff = (insertions: number, deletions = 0): DiffStat => ({
  filesChanged: 1,
  insertions,
  deletions,
  files: ['a.ts'],
  empty: false,
});

const check = (exitCode: number): CheckResult => ({
  command: 'npm test',
  exitCode,
  durationMs: 100,
  timedOut: false,
  outputTail: '',
});

describe('rankVariants', () => {
  it('ranks a variant that produced changes above one that produced none', () => {
    const ranked = rankVariants(
      [variant('empty', { diff: { ...diff(0), empty: true, filesChanged: 0, files: [] } }), variant('real', { diff: diff(10) })],
      undefined,
    );
    expect(ranked[0].variant.id).toBe('real');
  });

  it('ranks a failed agent last', () => {
    const ranked = rankVariants(
      [variant('failed', { status: 'failed' }), variant('ok', { diff: diff(5) })],
      undefined,
    );
    expect(ranked[0].variant.id).toBe('ok');
    expect(ranked[1].reasons.join(' ')).toContain('failed');
  });

  it('puts passing checks above failing checks regardless of judge score', () => {
    const ranked = rankVariants(
      [
        variant('failing', { diff: diff(5), check: check(1) }),
        variant('passing', { diff: diff(5), check: check(0) }),
      ],
      {
        ranking: [
          { variantId: 'failing', score: 10, reasoning: 'elegant' },
          { variantId: 'passing', score: 1, reasoning: 'clunky' },
        ],
      },
    );
    expect(ranked[0].variant.id).toBe('passing');
  });

  it('uses the judge score to break ties between equally valid variants', () => {
    const ranked = rankVariants(
      [
        variant('low', { diff: diff(5), check: check(0) }),
        variant('high', { diff: diff(5), check: check(0) }),
      ],
      {
        ranking: [
          { variantId: 'low', score: 3, reasoning: '' },
          { variantId: 'high', score: 9, reasoning: '' },
        ],
      },
    );
    expect(ranked[0].variant.id).toBe('high');
  });

  it('prefers the smaller diff when nothing else separates variants', () => {
    const ranked = rankVariants(
      [variant('big', { diff: diff(5000) }), variant('small', { diff: diff(20) })],
      undefined,
    );
    expect(ranked[0].variant.id).toBe('small');
  });

  it('does not let a huge diff outweigh passing checks', () => {
    const ranked = rankVariants(
      [
        variant('tiny-but-broken', { diff: diff(1), check: check(1) }),
        variant('large-but-working', { diff: diff(100000), check: check(0) }),
      ],
      undefined,
    );
    expect(ranked[0].variant.id).toBe('large-but-working');
  });

  it('assigns sequential ranks', () => {
    const ranked = rankVariants(
      [variant('a', { diff: diff(1) }), variant('b', { diff: diff(2) }), variant('c', { diff: diff(3) })],
      undefined,
    );
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('ignores judge entries for unknown variants', () => {
    const ranked = rankVariants([variant('a', { diff: diff(1) })], {
      ranking: [{ variantId: 'ghost', score: 10, reasoning: '' }],
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].variant.id).toBe('a');
  });
});
