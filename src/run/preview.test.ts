import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPreview, choosePreviewFile, inlineAssets } from './preview';

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

describe('inlineAssets', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bon-inline-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // A sandboxed srcdoc frame has an opaque origin and cannot fetch anything, so an
  // asset that is not inlined simply never appears. This is what made every rendered
  // preview a blank white box.
  it('inlines a local stylesheet', async () => {
    await fs.writeFile(path.join(root, 'common.css'), 'body{background:#000}', 'utf8');
    const html = '<html><head><link rel="stylesheet" href="common.css"></head><body></body></html>';

    const out = await inlineAssets(html, root, root);

    expect(out).toContain('<style>');
    expect(out).toContain('body{background:#000}');
    expect(out).not.toContain('<link');
  });

  it('inlines a local script', async () => {
    await fs.writeFile(path.join(root, 'app.js'), 'console.log(1)', 'utf8');
    const html = '<html><body><script src="app.js"></script></body></html>';

    const out = await inlineAssets(html, root, root);

    expect(out).toContain('console.log(1)');
    expect(out).not.toContain('src="app.js"');
  });

  it('leaves remote URLs alone rather than fetching them', async () => {
    const html = '<link rel="stylesheet" href="https://cdn.example.com/a.css">';

    expect(await inlineAssets(html, root, root)).toBe(html);
  });

  it('leaves a missing asset untouched instead of failing the preview', async () => {
    const html = '<link rel="stylesheet" href="nope.css">';

    expect(await inlineAssets(html, root, root)).toBe(html);
  });

  it('refuses to inline a file outside the worktree', async () => {
    const outside = path.join(root, 'secret.css');
    await fs.writeFile(outside, 'body{color:red}', 'utf8');
    const inner = path.join(root, 'wt');
    await fs.mkdir(inner);
    const html = '<link rel="stylesheet" href="../secret.css">';

    const out = await inlineAssets(html, inner, inner);

    expect(out).toBe(html);
    expect(out).not.toContain('color:red');
  });

  it('neutralises a closing script tag inside an inlined file', async () => {
    await fs.writeFile(path.join(root, 'a.js'), 'var s = "</script>";', 'utf8');
    const html = '<script src="a.js"></script>';

    const out = await inlineAssets(html, root, root);

    expect(out).not.toContain('"</script>"');
    expect(out).toContain('<\\/script>');
  });

  it('ignores a link that is not a stylesheet', async () => {
    await fs.writeFile(path.join(root, 'icon.png'), 'x', 'utf8');
    const html = '<link rel="icon" href="icon.png">';

    expect(await inlineAssets(html, root, root)).toBe(html);
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
    expect(preview?.html).toBe('<h1>hi</h1>');
  });

  it('produces a self-contained page so the sandboxed frame can render it', async () => {
    await fs.writeFile(path.join(root, 'common.css'), 'body{background:#123}', 'utf8');
    await fs.writeFile(
      path.join(root, 'page.html'),
      '<html><head><link rel="stylesheet" href="common.css"></head><body><canvas></canvas></body></html>',
      'utf8',
    );

    const preview = await buildPreview(root, ['page.html']);

    expect(preview?.html).toContain('body{background:#123}');
    expect(preview?.html).not.toContain('<link');
    // The source view must still show what the model actually wrote.
    expect(preview?.code).toContain('<link rel="stylesheet" href="common.css">');
  });

  it('leaves code previews without rendered HTML', async () => {
    await fs.writeFile(path.join(root, 'main.py'), 'print(1)', 'utf8');

    const preview = await buildPreview(root, ['main.py']);

    expect(preview?.html).toBeUndefined();
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
