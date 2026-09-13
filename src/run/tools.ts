import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Filesystem tools scoped to a single worktree.
 *
 * Every path an agent supplies is resolved against the worktree root and rejected if it
 * escapes. Worktrees are not a security boundary at the OS level, but containment here
 * stops a confused agent from editing a sibling variant or the main checkout, which
 * would silently corrupt the comparison.
 *
 * No `vscode` import, so this stays unit-testable.
 */

export class PathEscapeError extends Error {
  constructor(relative: string) {
    super(`Path "${relative}" is outside the worktree.`);
    this.name = 'PathEscapeError';
  }
}

/** Resolve a agent-supplied relative path, guaranteeing it stays inside `root`. */
export function resolveInside(root: string, relative: string): string {
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relative);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;

  if (target !== normalizedRoot && !target.startsWith(rootWithSep)) {
    throw new PathEscapeError(relative);
  }
  return target;
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.venv',
  '__pycache__',
  '.next',
  'target',
]);

const MAX_READ_BYTES = 200_000;
const MAX_LISTED_ENTRIES = 400;

export interface ToolContext {
  root: string;
  /** Records files the agent touched, for reporting and debugging. */
  touched: Set<string>;
}

export async function listFiles(ctx: ToolContext, relative = '.'): Promise<string> {
  const start = resolveInside(ctx.root, relative);
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= MAX_LISTED_ENTRIES || depth > 6) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_LISTED_ENTRIES) {
        return;
      }
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(ctx.root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        results.push(`${rel}/`);
        await walk(full, depth + 1);
      } else {
        results.push(rel);
      }
    }
  }

  const stat = await fs.stat(start).catch(() => undefined);
  if (!stat) {
    return `No such directory: ${relative}`;
  }
  if (stat.isFile()) {
    return path.relative(ctx.root, start).split(path.sep).join('/');
  }

  await walk(start, 0);
  if (results.length === 0) {
    return '(empty)';
  }
  const truncated = results.length >= MAX_LISTED_ENTRIES ? '\n... (truncated)' : '';
  return results.join('\n') + truncated;
}

export async function readFile(ctx: ToolContext, relative: string): Promise<string> {
  const target = resolveInside(ctx.root, relative);
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      return `"${relative}" is a directory. Use list_files instead.`;
    }
    if (stat.size > MAX_READ_BYTES) {
      const handle = await fs.open(target, 'r');
      try {
        const buffer = Buffer.alloc(MAX_READ_BYTES);
        await handle.read(buffer, 0, MAX_READ_BYTES, 0);
        return `${buffer.toString('utf8')}\n... (file truncated at ${MAX_READ_BYTES} bytes)`;
      } finally {
        await handle.close();
      }
    }
    return await fs.readFile(target, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return `No such file: ${relative}`;
    }
    return `Could not read "${relative}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function writeFile(
  ctx: ToolContext,
  relative: string,
  content: string,
): Promise<string> {
  const target = resolveInside(ctx.root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
  ctx.touched.add(relative);
  const lines = content.split('\n').length;
  return `Wrote ${relative} (${lines} lines).`;
}

/**
 * Replace an exact substring. Requiring a unique match makes edits verifiable and stops
 * the model from silently changing the wrong occurrence.
 */
export async function replaceInFile(
  ctx: ToolContext,
  relative: string,
  oldText: string,
  newText: string,
): Promise<string> {
  const target = resolveInside(ctx.root, relative);

  let content: string;
  try {
    content = await fs.readFile(target, 'utf8');
  } catch {
    return `No such file: ${relative}`;
  }

  if (oldText.length === 0) {
    return 'The "old_text" argument must not be empty. Use write_file to create a file.';
  }

  const first = content.indexOf(oldText);
  if (first === -1) {
    return `Could not find that exact text in ${relative}. Read the file again and match it byte for byte.`;
  }
  if (content.indexOf(oldText, first + 1) !== -1) {
    return `That text appears more than once in ${relative}. Include more surrounding context to make it unique.`;
  }

  const updated = content.slice(0, first) + newText + content.slice(first + oldText.length);
  await fs.writeFile(target, updated, 'utf8');
  ctx.touched.add(relative);
  return `Edited ${relative}.`;
}

export async function searchFiles(ctx: ToolContext, query: string): Promise<string> {
  if (query.trim().length === 0) {
    return 'Provide a non-empty search string.';
  }
  const matches: string[] = [];
  const needle = query.toLowerCase();

  async function walk(dir: string, depth: number): Promise<void> {
    if (matches.length >= 100 || depth > 6) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= 100) {
        return;
      }
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const stat = await fs.stat(full).catch(() => undefined);
      if (!stat || stat.size > MAX_READ_BYTES) {
        continue;
      }
      const content = await fs.readFile(full, 'utf8').catch(() => undefined);
      if (content === undefined) {
        continue;
      }
      const rel = path.relative(ctx.root, full).split(path.sep).join('/');
      content.split('\n').forEach((line, index) => {
        if (matches.length < 100 && line.toLowerCase().includes(needle)) {
          matches.push(`${rel}:${index + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    }
  }

  await walk(ctx.root, 0);
  return matches.length > 0 ? matches.join('\n') : `No matches for "${query}".`;
}

/** Tool schemas advertised to the model. Kept small: fewer tools, more reliable use. */
export const TOOL_SCHEMAS = [
  {
    name: 'list_files',
    description:
      'List files and directories in the project. Use this first to understand the layout.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory relative to the project root. Defaults to the root.',
        },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a file. Always read a file before editing it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create a new file or completely overwrite an existing one. For targeted changes to an existing file, prefer replace_in_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        content: { type: 'string', description: 'The complete new contents of the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'replace_in_file',
    description:
      'Replace an exact, unique snippet of text in a file. The old text must match byte for byte and appear exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root.' },
        old_text: { type: 'string', description: 'The exact text to replace.' },
        new_text: { type: 'string', description: 'The replacement text.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'search_files',
    description: 'Find which files contain a piece of text. Case-insensitive substring search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to search for.' },
      },
      required: ['query'],
    },
  },
] as const;

export type ToolName = (typeof TOOL_SCHEMAS)[number]['name'];

function stringArg(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

/** Dispatch a tool call. Returns text for the model; never throws. */
export async function invokeTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'list_files':
        return await listFiles(ctx, stringArg(input, 'path') ?? '.');
      case 'read_file': {
        const target = stringArg(input, 'path');
        return target ? await readFile(ctx, target) : 'The "path" argument is required.';
      }
      case 'write_file': {
        const target = stringArg(input, 'path');
        const content = stringArg(input, 'content');
        if (!target || content === undefined) {
          return 'Both "path" and "content" are required.';
        }
        return await writeFile(ctx, target, content);
      }
      case 'replace_in_file': {
        const target = stringArg(input, 'path');
        const oldText = stringArg(input, 'old_text');
        const newText = stringArg(input, 'new_text');
        if (!target || oldText === undefined || newText === undefined) {
          return 'The "path", "old_text" and "new_text" arguments are required.';
        }
        return await replaceInFile(ctx, target, oldText, newText);
      }
      case 'search_files': {
        const query = stringArg(input, 'query');
        return query ? await searchFiles(ctx, query) : 'The "query" argument is required.';
      }
      default:
        return `Unknown tool "${name}".`;
    }
  } catch (err) {
    if (err instanceof PathEscapeError) {
      return err.message;
    }
    return `The tool failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
