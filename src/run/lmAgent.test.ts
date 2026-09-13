import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runLmAgent } from './lmAgent';
import { VariantState } from '../util/types';

/** A scripted model: each entry is one turn's worth of streamed parts. */
function fakeModel(turns: Array<Array<unknown>>) {
  const seen: unknown[][] = [];
  let turn = 0;
  const model = {
    id: 'fake',
    vendor: 'copilot',
    name: 'Fake',
    async sendRequest(messages: unknown[]) {
      seen.push([...messages]);
      const parts = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      return {
        stream: (async function* () {
          for (const part of parts) {
            yield part;
          }
        })(),
        text: (async function* () {})(),
      };
    },
    async countTokens() {
      return 0;
    },
  };
  return { model, seen, turnCount: () => turn };
}

function makeVariant(worktreePath: string): VariantState {
  return {
    id: 'v1',
    label: 'fake #1',
    model: 'fake',
    replica: 1,
    branch: 'bon/test/fake-1',
    worktreePath,
    sessionId: 'session',
    status: 'running',
    queuedAt: Date.now(),
    assistantText: '',
    toolCalls: [],
    transcriptPath: path.join(worktreePath, 't.jsonl'),
    usagePath: path.join(worktreePath, 'u.json'),
    sharePath: path.join(worktreePath, 's.md'),
  };
}

const noToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as unknown as vscode.CancellationToken;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bon-agent-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('runLmAgent', () => {
  it('stops on the first turn when no tools are called', async () => {
    const variant = makeVariant(root);
    const { model, turnCount } = fakeModel([[new vscode.LanguageModelTextPart('All done.')]]);

    await runLmAgent(variant, model as unknown as vscode.LanguageModelChat, {
      prompt: 'do nothing',
      worktreePath: root,
      token: noToken,
      onUpdate: () => undefined,
    });

    expect(turnCount()).toBe(1);
    expect(variant.assistantText).toBe('All done.');
    expect(variant.error).toBeUndefined();
  });

  it('executes a tool call and feeds the result back', async () => {
    const variant = makeVariant(root);
    const { model, seen } = fakeModel([
      [
        new vscode.LanguageModelTextPart('Creating the file.'),
        new vscode.LanguageModelToolCallPart('c1', 'write_file', {
          path: 'hello.txt',
          content: 'hi\n',
        }),
      ],
      [new vscode.LanguageModelTextPart('Created hello.txt.')],
    ]);

    await runLmAgent(variant, model as unknown as vscode.LanguageModelChat, {
      prompt: 'create hello.txt',
      worktreePath: root,
      token: noToken,
      onUpdate: () => undefined,
    });

    expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf8')).toBe('hi\n');
    expect(variant.toolCalls).toEqual([{ id: 'c1', name: 'write_file', status: 'done' }]);
    expect(variant.assistantText).toBe('Created hello.txt.');

    // Second request must carry the assistant turn and the tool result.
    expect(seen[1]).toHaveLength(3);
  });

  it('marks a failing tool call as an error but keeps going', async () => {
    const variant = makeVariant(root);
    const { model } = fakeModel([
      [new vscode.LanguageModelToolCallPart('c1', 'read_file', { path: 'missing.txt' })],
      [new vscode.LanguageModelTextPart('Nothing to do.')],
    ]);

    await runLmAgent(variant, model as unknown as vscode.LanguageModelChat, {
      prompt: 'read a missing file',
      worktreePath: root,
      token: noToken,
      onUpdate: () => undefined,
    });

    expect(variant.toolCalls[0].status).toBe('error');
    expect(variant.error).toBeUndefined();
  });

  it('blocks a tool call that escapes the worktree', async () => {
    const variant = makeVariant(root);
    const { model } = fakeModel([
      [
        new vscode.LanguageModelToolCallPart('c1', 'write_file', {
          path: '../escaped.txt',
          content: 'nope',
        }),
      ],
      [new vscode.LanguageModelTextPart('Blocked.')],
    ]);

    await runLmAgent(variant, model as unknown as vscode.LanguageModelChat, {
      prompt: 'escape',
      worktreePath: root,
      token: noToken,
      onUpdate: () => undefined,
    });

    await expect(fs.stat(path.join(path.dirname(root), 'escaped.txt'))).rejects.toThrow();
    expect(variant.toolCalls[0].status).toBe('error');
  });

  it('gives up after the iteration cap when the model never stops calling tools', async () => {
    const variant = makeVariant(root);
    const { model, turnCount } = fakeModel([
      [new vscode.LanguageModelToolCallPart('c', 'list_files', {})],
    ]);

    await runLmAgent(variant, model as unknown as vscode.LanguageModelChat, {
      prompt: 'loop forever',
      worktreePath: root,
      token: noToken,
      onUpdate: () => undefined,
    });

    expect(turnCount()).toBe(24);
    expect(variant.error).toContain('without finishing');
  });

  it('stops immediately when cancelled', async () => {
    const variant = makeVariant(root);
    const { model, turnCount } = fakeModel([[new vscode.LanguageModelTextPart('hi')]]);
    const cancelled = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose() {} }),
    } as unknown as vscode.CancellationToken;

    await runLmAgent(variant, model as unknown as vscode.LanguageModelChat, {
      prompt: 'anything',
      worktreePath: root,
      token: cancelled,
      onUpdate: () => undefined,
    });

    expect(turnCount()).toBe(0);
    expect(variant.status).toBe('cancelled');
  });

  it('includes the task and the worktree path in the first message', async () => {
    const variant = makeVariant(root);
    const { model, seen } = fakeModel([[new vscode.LanguageModelTextPart('ok')]]);

    await runLmAgent(variant, model as unknown as vscode.LanguageModelChat, {
      prompt: 'MY UNIQUE TASK',
      worktreePath: root,
      token: noToken,
      onUpdate: () => undefined,
    });

    const first = seen[0][0] as { content: string };
    expect(first.content).toContain('MY UNIQUE TASK');
    expect(first.content).toContain(root);
  });
});
