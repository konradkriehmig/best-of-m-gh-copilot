import { ChildProcess, execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CliInvocation, spawnCli } from '../cli/locate';
import { interpret, JsonlParser } from './jsonl';
import { UsageReport, VariantState } from '../util/types';

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface RunnerOptions {
  invocation: CliInvocation;
  prompt: string;
  maxConcurrent: number;
  denyTools: string[];
  disableBuiltinMcps: boolean;
  maxAiCredits: number;
  onUpdate: (variant: VariantState) => void;
  onLog: (message: string) => void;
  token?: CancellationLike;
}

/**
 * Kill the whole process tree. The CLI spawns shells and MCP servers, and on Windows
 * `child.kill()` leaves those grandchildren running.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {
      /* best effort */
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function buildArgs(variant: VariantState, options: RunnerOptions): string[] {
  const args: string[] = [
    '--model',
    variant.model,
    '--allow-all-tools',
    '--output-format',
    'json',
    '--no-color',
    '--session-id',
    variant.sessionId,
    '--usage-output-file',
    variant.usagePath,
    '--share',
    variant.sharePath,
    // The worktree is a brand new directory; grant access explicitly so a
    // non-interactive run never blocks on a trust prompt.
    '--add-dir',
    variant.worktreePath,
  ];

  if (options.disableBuiltinMcps) {
    args.push('--disable-builtin-mcps');
  }
  for (const pattern of options.denyTools) {
    if (pattern.trim().length > 0) {
      args.push('--deny-tool', pattern.trim());
    }
  }
  if (options.maxAiCredits > 0) {
    args.push('--max-ai-credits', String(options.maxAiCredits));
  }
  return args;
}

async function readUsage(usagePath: string): Promise<UsageReport | undefined> {
  try {
    const raw = await fs.readFile(usagePath, 'utf8');
    return JSON.parse(raw) as UsageReport;
  } catch {
    return undefined;
  }
}

function runVariant(variant: VariantState, options: RunnerOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    if (options.token?.isCancellationRequested) {
      variant.status = 'cancelled';
      options.onUpdate(variant);
      resolve();
      return;
    }

    variant.status = 'running';
    variant.startedAt = Date.now();
    variant.activity = 'starting';
    options.onUpdate(variant);

    const args = buildArgs(variant, options);
    options.onLog(`[${variant.label}] ${options.invocation.display} ${args.join(' ')}`);

    let child: ChildProcess;
    try {
      child = spawnCli(options.invocation, args, {
        cwd: variant.worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
    } catch (err) {
      variant.status = 'failed';
      variant.error = err instanceof Error ? err.message : String(err);
      variant.endedAt = Date.now();
      options.onUpdate(variant);
      resolve();
      return;
    }

    const parser = new JsonlParser();
    const transcriptLines: string[] = [];
    let stderrBuffer = '';
    let cancelled = false;
    let settled = false;

    const subscription = options.token?.onCancellationRequested(() => {
      cancelled = true;
      killTree(child);
    });

    const handleEvents = (chunk: string) => {
      const { events, unparsed } = parser.push(chunk);
      let dirty = false;
      for (const event of events) {
        if (event.ephemeral !== true) {
          transcriptLines.push(JSON.stringify(event));
        }
        for (const update of interpret(event)) {
          dirty = true;
          switch (update.kind) {
            case 'assistant-delta':
              variant.assistantText += update.text;
              break;
            case 'assistant-message':
              // The full message supersedes the accumulated deltas for this turn.
              variant.assistantText = update.text;
              variant.activity = 'responded';
              break;
            case 'activity':
              variant.activity = update.text;
              break;
            case 'tool-start':
              variant.toolCalls.push({ id: update.id, name: update.name, status: 'running' });
              break;
            case 'tool-end': {
              const existing = variant.toolCalls.find((t) => t.id === update.id);
              if (existing) {
                existing.status = update.ok ? 'done' : 'error';
              } else {
                variant.toolCalls.push({
                  id: update.id,
                  name: update.name,
                  status: update.ok ? 'done' : 'error',
                });
              }
              break;
            }
            case 'model':
              // The CLI may resolve "auto" to a concrete model.
              if (variant.model === 'auto') {
                variant.activity = `model: ${update.model}`;
              }
              break;
          }
        }
      }
      for (const line of unparsed) {
        options.onLog(`[${variant.label}] ${line}`);
      }
      if (dirty) {
        options.onUpdate(variant);
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => handleEvents(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > 16000) {
        stderrBuffer = stderrBuffer.slice(stderrBuffer.length - 16000);
      }
    });

    const finish = async (exitCode: number | null, spawnError?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      subscription?.dispose();

      const flushed = parser.flush();
      for (const event of flushed.events) {
        if (event.ephemeral !== true) {
          transcriptLines.push(JSON.stringify(event));
        }
      }

      variant.endedAt = Date.now();
      variant.exitCode = exitCode ?? undefined;
      variant.usage = await readUsage(variant.usagePath);

      await fs
        .mkdir(path.dirname(variant.transcriptPath), { recursive: true })
        .catch(() => undefined);
      await fs
        .writeFile(variant.transcriptPath, transcriptLines.join('\n'), 'utf8')
        .catch(() => undefined);

      if (cancelled) {
        variant.status = 'cancelled';
      } else if (spawnError) {
        variant.status = 'failed';
        variant.error = spawnError.message;
      } else if (exitCode === 0) {
        variant.status = 'done';
      } else {
        variant.status = 'failed';
        variant.error = stderrBuffer.trim().split('\n').slice(-3).join('\n') || `Exited with code ${exitCode}`;
      }
      variant.activity = undefined;
      options.onUpdate(variant);
      resolve();
    };

    child.on('error', (err) => {
      void finish(null, err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', (code) => {
      void finish(code);
    });

    // The prompt goes over stdin rather than `-p`, so quoting and shell metacharacters
    // in the user's prompt can never be misinterpreted.
    child.stdin?.on('error', () => {
      /* the process may exit before stdin is consumed */
    });
    child.stdin?.end(options.prompt, 'utf8');
  });
}

/** Run every variant, honouring the concurrency cap. Resolves when all have settled. */
export async function runAll(variants: VariantState[], options: RunnerOptions): Promise<void> {
  const queue = [...variants];
  const limit = Math.max(1, Math.min(options.maxConcurrent, variants.length));

  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      await runVariant(next, options);
    }
  });

  await Promise.all(workers);
}
