import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PathEscapeError,
  ToolContext,
  invokeTool,
  listFiles,
  readFile,
  replaceInFile,
  resolveInside,
  searchFiles,
  writeFile,
} from './tools';

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bon-tools-'));
  ctx = { root, touched: new Set() };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('resolves a plain relative path', () => {
    expect(resolveInside(root, 'src/index.ts')).toBe(path.join(root, 'src', 'index.ts'));
  });

  it('allows the root itself', () => {
    expect(resolveInside(root, '.')).toBe(path.resolve(root));
  });

  it('allows traversal that stays inside', () => {
    expect(resolveInside(root, 'src/../lib/a.ts')).toBe(path.join(root, 'lib', 'a.ts'));
  });

  it('rejects traversal that escapes', () => {
    expect(() => resolveInside(root, '../outside.txt')).toThrow(PathEscapeError);
    expect(() => resolveInside(root, 'src/../../outside.txt')).toThrow(PathEscapeError);
  });

  it('rejects an absolute path outside the root', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\system.ini' : '/etc/passwd';
    expect(() => resolveInside(root, outside)).toThrow(PathEscapeError);
  });

  it('rejects a sibling directory sharing the root prefix', () => {
    // `<root>-evil` starts with `<root>` as a string but is not inside it.
    expect(() => resolveInside(root, `../${path.basename(root)}-evil/x.txt`)).toThrow(
      PathEscapeError,
    );
  });

  it('rejects windows-style traversal', () => {
    expect(() => resolveInside(root, '..\\..\\outside.txt')).toThrow(PathEscapeError);
  });
});

describe('file tools', () => {
  it('writes, reads and reports the file', async () => {
    const written = await writeFile(ctx, 'src/a.ts', 'export const a = 1;\n');
    expect(written).toContain('src/a.ts');
    expect(await readFile(ctx, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(ctx.touched.has('src/a.ts')).toBe(true);
  });

  it('reports a missing file without throwing', async () => {
    expect(await readFile(ctx, 'nope.ts')).toBe('No such file: nope.ts');
  });

  it('replaces a unique snippet', async () => {
    await writeFile(ctx, 'a.txt', 'alpha\nbeta\ngamma\n');
    expect(await replaceInFile(ctx, 'a.txt', 'beta', 'delta')).toBe('Edited a.txt.');
    expect(await readFile(ctx, 'a.txt')).toBe('alpha\ndelta\ngamma\n');
  });

  it('refuses an ambiguous replacement', async () => {
    await writeFile(ctx, 'a.txt', 'x\nx\n');
    const result = await replaceInFile(ctx, 'a.txt', 'x', 'y');
    expect(result).toContain('more than once');
    expect(await readFile(ctx, 'a.txt')).toBe('x\nx\n');
  });

  it('refuses a replacement that does not match', async () => {
    await writeFile(ctx, 'a.txt', 'hello\n');
    expect(await replaceInFile(ctx, 'a.txt', 'goodbye', 'hi')).toContain('Could not find');
  });

  it('lists files and skips ignored directories', async () => {
    await writeFile(ctx, 'src/a.ts', '');
    await writeFile(ctx, 'node_modules/pkg/index.js', '');
    const listing = await listFiles(ctx, '.');
    expect(listing).toContain('src/a.ts');
    expect(listing).not.toContain('node_modules');
  });

  it('searches file contents', async () => {
    await writeFile(ctx, 'src/a.ts', 'const needle = 1;\n');
    const hits = await searchFiles(ctx, 'NEEDLE');
    expect(hits).toContain('src/a.ts:1');
  });
});

describe('invokeTool', () => {
  it('reports path escapes as text rather than throwing', async () => {
    const result = await invokeTool(ctx, 'read_file', { path: '../../secrets.txt' });
    expect(result).toContain('outside the worktree');
  });

  it('rejects an unknown tool', async () => {
    expect(await invokeTool(ctx, 'rm_rf', {})).toBe('Unknown tool "rm_rf".');
  });

  it('validates required arguments', async () => {
    expect(await invokeTool(ctx, 'read_file', {})).toBe('The "path" argument is required.');
    expect(await invokeTool(ctx, 'write_file', { path: 'a.txt' })).toContain('are required');
  });

  it('defaults list_files to the root', async () => {
    await writeFile(ctx, 'a.txt', '');
    expect(await invokeTool(ctx, 'list_files', {})).toContain('a.txt');
  });

  it('round-trips a write through the dispatcher', async () => {
    const result = await invokeTool(ctx, 'write_file', { path: 'b.txt', content: 'hi\n' });
    expect(result).toContain('Wrote b.txt');
    expect(await readFile(ctx, 'b.txt')).toBe('hi\n');
  });
});
