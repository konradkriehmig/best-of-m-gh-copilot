import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Run git with array arguments. Never goes through a shell. */
export async function git(cwd: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new GitError(
      `git ${args.join(' ')} failed: ${(e.stderr || e.message || '').trim()}`,
      args,
      e.stderr ?? '',
    );
  }
}

export async function tryGit(cwd: string, args: string[]): Promise<GitResult | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const result = await tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const name = result?.stdout.trim();
  return name && name.length > 0 ? name : undefined;
}

export async function headSha(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

export async function isDirty(cwd: string): Promise<boolean> {
  const { stdout } = await git(cwd, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

export async function listBranches(cwd: string): Promise<string[]> {
  const { stdout } = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result !== undefined;
}
