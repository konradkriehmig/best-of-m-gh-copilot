import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPreview, choosePreviewFile } from './preview';

describe('choosePreviewFile', () => {
  it('prefers HTML over source, because rendered output is what we compare', () => {
    expect(choosePreviewFile(['app.py', 'index.html', 'README.md'])).toBe('index.html');
  });

  it('prefers an index over another page', () => {
    expect(choosePreviewFile(['about.html', 'index.html'])).toBe('index.html');
  });

  it('prefers a shallower path when neither is an index', () => {
    expect(choosePreviewFile(['src/deep/page.html', 'page.html'])).toBe('page.html');
  });

  it('falls back to source in language priority order', () => {
    expect(choosePreviewFile(['notes.md', 'main.py'])).toBe('main.py');
    expect(choosePreviewFile(['styles.css', 'app.ts'])).toBe('app.ts');
  });

  it('returns nothing when no file is previewable', () => {
    expect(choosePreviewFile(['image.png', 'data.bin'])).toBeUndefined();
    expect(choosePreviewFile([])).toBeUndefined();
  });

  it('is stable for equally ranked files', () => {
    expect(choosePreviewFile(['b.html', 'a.html'])).toBe('a.html');
  });
});

describe('buildPreview', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bon-preview-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('marks HTML for framing and still carries the source', async () => {
    await fs.writeFile(path.join(root, 'index.html'), '<h1>hi</h1>', 'utf8');

    const preview = await buildPreview(root, ['index.html']);

    expect(preview?.kind).toBe('html');
    expect(preview?.file).toBe('index.html');
    expect(preview?.path).toBe(path.join(root, 'index.html'));
    expect(preview?.code).toBe('<h1>hi</h1>');
  });

  it('reads source for non-HTML results', async () => {
    await fs.writeFile(path.join(root, 'main.py'), 'print("hi")\n', 'utf8');

    const preview = await buildPreview(root, ['main.py']);

    expect(preview?.kind).toBe('code');
    expect(preview?.language).toBe('python');
    expect(preview?.code).toBe('print("hi")\n');
    expect(preview?.truncated).toBe(false);
  });

  it('truncates very large files so messages stay small', async () => {
    await fs.writeFile(path.join(root, 'big.py'), 'x'.repeat(50_000), 'utf8');

    const preview = await buildPreview(root, ['big.py']);

    expect(preview?.truncated).toBe(true);
    expect(preview?.code?.length).toBe(40_000);
  });

  it('returns nothing when the chosen file cannot be read', async () => {
    expect(await buildPreview(root, ['gone.html'])).toBeUndefined();
  });

  it('returns nothing when there are no previewable files', async () => {
    expect(await buildPreview(root, ['logo.png'])).toBeUndefined();
  });
});
