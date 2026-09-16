import { spawn, SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * How to invoke the Copilot CLI.
 *
 * On Windows the npm shim is `copilot.cmd`, which Node refuses to spawn directly
 * (`spawn EINVAL`, the fix for CVE-2024-27980), and spawning it with `shell: true`
 * concatenates arguments unescaped. Both are avoided by resolving the shim to the
 * JavaScript entry point it wraps and running it with the current Node binary, so
 * arguments are always passed as a real array.
 */
export interface CliInvocation {
  command: string;
  baseArgs: string[];
  /** The user-visible path, for logs and error messages. */
  display: string;
}

export class CliNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliNotFoundError';
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(): string[] {
  const out: string[] = [];
  const envPath = process.env.PATH ?? '';
  const names =
    process.platform === 'win32' ? ['copilot.cmd', 'copilot.exe', 'copilot'] : ['copilot'];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      out.push(path.join(dir, name));
    }
  }

  // Global npm prefix, which is not always on the PATH inherited by the extension host.
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      out.push(path.join(appData, 'npm', 'copilot.cmd'));
    }
  } else {
    out.push('/usr/local/bin/copilot');
    const home = process.env.HOME;
    if (home) {
      out.push(path.join(home, '.npm-global', 'bin', 'copilot'));
      out.push(path.join(home, '.local', 'bin', 'copilot'));
    }
  }
  return out;
}

/**
 * An npm shim lives next to `node_modules/@github/copilot/<bin>`. Resolving it lets us
 * bypass the shell entirely.
 */
function resolveLoader(shimPath: string): string | undefined {
  const dir = path.dirname(shimPath);
  const packageRoot = path.join(dir, 'node_modules', '@github', 'copilot');
  const pkgJson = path.join(packageRoot, 'package.json');
  if (!isFile(pkgJson)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as {
      bin?: string | Record<string, string>;
      main?: string;
    };
    const binField = parsed.bin;
    const relative =
      typeof binField === 'string'
        ? binField
        : binField?.copilot ?? Object.values(binField ?? {})[0] ?? parsed.main;
    if (!relative) {
      return undefined;
    }
    const entry = path.join(packageRoot, relative);
    return isFile(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCli(configuredPath: string | undefined): CliInvocation {
  const candidates: string[] = [];
  if (configuredPath && configuredPath.trim().length > 0) {
    candidates.push(configuredPath.trim());
  } else {
    candidates.push(...pathCandidates());
  }

  const found = candidates.find(isFile);
  if (!found) {
    throw new CliNotFoundError(
      configuredPath && configuredPath.trim().length > 0
        ? `The configured Copilot CLI path does not exist: ${configuredPath}`
        : 'Could not find the Copilot CLI. Install it with "npm install -g @github/copilot", or set "bestOfM.cliPath".',
    );
  }

  const lower = found.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')) {
    const loader = resolveLoader(found);
    if (loader) {
      return { command: process.execPath, baseArgs: [loader], display: found };
    }
    // Last resort: run the shim through cmd.exe with a command line we build ourselves.
    // `windowsVerbatimArguments` stops Node from re-escaping the quotes.
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      baseArgs: ['/d', '/s', '/c', found],
      display: found,
    };
  }

  if (found.endsWith('.js')) {
    return { command: process.execPath, baseArgs: [found], display: found };
  }

  return { command: found, baseArgs: [], display: found };
}

export function spawnCli(
  invocation: CliInvocation,
  args: string[],
  options: SpawnOptions,
): ReturnType<typeof spawn> {
  const usingCmdShim = path.basename(invocation.command).toLowerCase() === 'cmd.exe';
  if (usingCmdShim) {
    // Build one verbatim command line: cmd.exe needs the whole thing wrapped in
    // an extra pair of quotes when the program path itself is quoted.
    const quoted = [...invocation.baseArgs.slice(3), ...args]
      .map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
      .join(' ');
    return spawn(invocation.command, ['/d', '/s', '/c', `"${quoted}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(invocation.command, [...invocation.baseArgs, ...args], {
    ...options,
    shell: false,
  });
}

export async function cliVersion(invocation: CliInvocation): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(invocation, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out.trim().split('\n')[0] ?? '');
      } else {
        reject(new Error(`"${invocation.display} --version" exited with code ${code}: ${out.trim()}`));
      }
    });
  });
}
