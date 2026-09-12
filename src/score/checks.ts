import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { CheckResult } from '../util/types';
import { tail } from '../util/text';

/**
 * Run the user's verify command inside a worktree. The command comes from settings and
 * is intentionally interpreted by the shell, since it is written as a shell command
 * (`npm test && npm run lint`).
 */
export function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let output = '';
    let timedOut = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {
            /* best effort */
          });
        } else {
          child.kill('SIGKILL');
        }
      }
    }, Math.max(1000, timeoutMs));

    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 200_000) {
        output = output.slice(output.length - 200_000);
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: timedOut ? null : exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
        outputTail: tail(output.trim(), 4000),
      });
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        outputTail: err instanceof Error ? err.message : String(err),
      });
    });
    child.on('close', (code) => done(code));
  });
}

export function checkPassed(check: CheckResult | undefined): boolean | undefined {
  if (!check) {
    return undefined;
  }
  if (check.timedOut) {
    return false;
  }
  return check.exitCode === 0;
}
