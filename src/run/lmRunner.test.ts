import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { VariantState } from '../util/types';

/** Agents started, and a way to let each one finish on demand. */
const started: string[] = [];
const finishers = new Map<string, () => void>();

vi.mock('./lmAgent', () => ({
  selectModel: async (id: string) => ({ id, vendor: 'copilot', name: id }),
  runLmAgent: async (
    variant: VariantState,
    _model: unknown,
    options: { token: vscode.CancellationToken },
  ) => {
    started.push(variant.id);
    await new Promise<void>((resolve) => {
      if (options.token.isCancellationRequested) {
        resolve();
        return;
      }
      options.token.onCancellationRequested(() => resolve());
      finishers.set(variant.id, resolve);
    });
  },
}));

// Imported after the mock so the runner picks up the stubbed agent.
const { runAllLm } = await import('./lmRunner');

/** A cancellation source with the same shape as the one the extension host provides. */
function source() {
  const listeners: Array<() => void> = [];
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener: () => void) {
        if (cancelled) {
          listener();
        } else {
          listeners.push(listener);
        }
        return { dispose() {} };
      },
    } as unknown as vscode.CancellationToken,
    cancel() {
      if (!cancelled) {
        cancelled = true;
        for (const listener of listeners) {
          listener();
        }
      }
    },
  };
}

let dir = '';

function makeVariant(id: string): VariantState {
  return {
    id,
    label: id,
    model: 'fake',
    replica: 1,
    branch: `bon/test/${id}`,
    worktreePath: dir,
    sessionId: id,
    status: 'queued',
    queuedAt: Date.now(),
    assistantText: '',
    toolCalls: [],
    transcriptPath: path.join(dir, `${id}.jsonl`),
    usagePath: path.join(dir, `${id}.json`),
    sharePath: path.join(dir, `${id}.md`),
  };
}

/** Let the runner's microtasks settle without depending on wall-clock timing. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const noop = () => undefined;

describe('runAllLm cancellation', () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bon-runner-'));
    started.length = 0;
    finishers.clear();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips a variant whose own token is already cancelled, and runs the rest', async () => {
    const variants = [makeVariant('a'), makeVariant('b')];
    const sources = { a: source(), b: source() };
    sources.a.cancel();

    const run = source();
    const done = runAllLm(variants, {
      prompt: 'p',
      maxConcurrent: variants.length,
      onUpdate: noop,
      onLog: noop,
      token: run.token,
      tokenFor: (v) => sources[v.id as 'a' | 'b'].token,
    });

    await settle();
    expect(started).toEqual(['b']);
    expect(variants[0].status).toBe('cancelled');

    finishers.get('b')?.();
    await done;
    expect(variants[1].status).toBe('done');
  });

  it('stops one running variant without disturbing the others', async () => {
    const variants = [makeVariant('a'), makeVariant('b')];
    const sources = { a: source(), b: source() };

    const run = source();
    const done = runAllLm(variants, {
      prompt: 'p',
      maxConcurrent: variants.length,
      onUpdate: noop,
      onLog: noop,
      token: run.token,
      tokenFor: (v) => sources[v.id as 'a' | 'b'].token,
    });

    await settle();
    expect(started).toEqual(['a', 'b']);
    expect(variants[0].status).toBe('running');

    sources.a.cancel();
    await settle();
    expect(variants[0].status).toBe('cancelled');
    expect(variants[1].status).toBe('running');

    finishers.get('b')?.();
    await done;
    expect(variants[1].status).toBe('done');
  });

  it('runs every variant at once when the limit allows it', async () => {
    const variants = [makeVariant('a'), makeVariant('b'), makeVariant('c')];
    const run = source();
    const done = runAllLm(variants, {
      prompt: 'p',
      maxConcurrent: variants.length,
      onUpdate: noop,
      onLog: noop,
      token: run.token,
    });

    await settle();
    expect(started).toEqual(['a', 'b', 'c']);

    run.cancel();
    await done;
    expect(variants.map((v) => v.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('queues past the limit, so a cap still holds', async () => {
    const variants = [makeVariant('a'), makeVariant('b'), makeVariant('c')];
    const run = source();
    const done = runAllLm(variants, {
      prompt: 'p',
      maxConcurrent: 2,
      onUpdate: noop,
      onLog: noop,
      token: run.token,
    });

    await settle();
    expect(started).toEqual(['a', 'b']);
    expect(variants[2].status).toBe('queued');

    run.cancel();
    await done;
    expect(variants[2].status).toBe('cancelled');
  });

  it('falls back to the run token when no per-variant token is given', async () => {
    const variants = [makeVariant('a')];
    const run = source();
    run.cancel();

    await runAllLm(variants, {
      prompt: 'p',
      maxConcurrent: 1,
      onUpdate: noop,
      onLog: noop,
      token: run.token,
    });

    expect(started).toEqual([]);
    expect(variants[0].status).toBe('cancelled');
  });
});
