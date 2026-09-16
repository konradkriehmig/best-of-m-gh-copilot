import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPreview, choosePreviewFile, inlineAssets, inlineSvgImages } from './preview';

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

  it('prefers a rendered image over the source that draws it', () => {
    expect(choosePreviewFile(['draw.py', 'logo.svg'])).toBe('logo.svg');
    expect(choosePreviewFile(['logo.png', 'styles.css'])).toBe('logo.png');
  });

  it('still prefers a page over an image', () => {
    expect(choosePreviewFile(['logo.svg', 'index.html'])).toBe('index.html');
  });

  it('prefers the vector over an exported bitmap of the same thing', () => {
    expect(choosePreviewFile(['logo.png', 'logo.svg'])).toBe('logo.svg');
  });

  it('returns nothing when no file is previewable', () => {
    expect(choosePreviewFile(['data.bin', 'notes.txt'])).toBeUndefined();
    expect(choosePreviewFile([])).toBeUndefined();
  });

  it('returns nothing when there are no previewable files', () => {
    expect(choosePreviewFile(['data.bin'])).toBeUndefined();
  });

  it('is stable for equally ranked files', () => {
    expect(choosePreviewFile(['b.html', 'a.html'])).toBe('a.html');
  });
});

describe('inlineSvgImages', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bon-svg-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Asked to clean up a hand-drawn PNG, models routinely answer with an SVG that
  // references it. That renders as an empty box anywhere the file cannot be fetched,
  // which includes the preview frame.
  it('inlines a referenced bitmap so the drawing is not an empty box', async () => {
    await fs.writeFile(path.join(root, 'image.png'), Buffer.from([1, 2, 3]));
    const svg = '<svg><image href="image.png" width="128" height="128"/></svg>';

    const out = await inlineSvgImages(svg, root, root);

    expect(out.svg).toContain('data:image/png;base64,AQID');
    expect(out.svg).not.toContain('href="image.png"');
    expect(out.missing).toEqual([]);
  });

  it('handles the older xlink:href spelling', async () => {
    await fs.writeFile(path.join(root, 'a.png'), Buffer.from([1]));
    const svg = '<svg><image xlink:href="a.png"/></svg>';

    expect((await inlineSvgImages(svg, root, root)).svg).toContain('data:image/png;base64,');
  });

  it('inlines every referenced image, not just the first', async () => {
    await fs.writeFile(path.join(root, 'a.png'), Buffer.from([1]));
    await fs.writeFile(path.join(root, 'b.png'), Buffer.from([2]));
    const svg = '<svg><image href="a.png"/><image href="b.png"/></svg>';

    const out = await inlineSvgImages(svg, root, root);

    expect(out.svg).toContain('base64,AQ==');
    expect(out.svg).toContain('base64,Ag==');
    expect(out.svg).not.toContain('.png"');
  });

  it('leaves a remote or already-inlined reference alone', async () => {
    const svg = '<svg><image href="https://x.test/a.png"/><image href="data:image/png;base64,AQ=="/></svg>';

    const out = await inlineSvgImages(svg, root, root);

    expect(out.svg).toBe(svg);
    expect(out.missing).toEqual([]);
  });

  it('reports a reference it could not resolve', async () => {
    const svg = '<svg><image href="gone.png"/></svg>';

    expect((await inlineSvgImages(svg, root, root)).missing).toEqual(['gone.png']);
  });

  it('refuses to reach outside the worktree', async () => {
    await fs.writeFile(path.join(root, 'secret.png'), Buffer.from([9]));
    const inner = path.join(root, 'wt');
    await fs.mkdir(inner);
    const svg = '<svg><image href="../secret.png"/></svg>';

    const out = await inlineSvgImages(svg, inner, inner);

    expect(out.svg).toBe(svg);
    expect(out.missing).toEqual(['../secret.png']);
  });

  it('will not pull a non-image in through the reference', async () => {
    await fs.writeFile(path.join(root, 'id_rsa'), 'PRIVATE KEY', 'utf8');
    const svg = '<svg><image href="id_rsa"/></svg>';

    const out = await inlineSvgImages(svg, root, root);

    expect(out.svg).not.toContain('PRIVATE KEY');
    expect(out.missing).toEqual(['id_rsa']);
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

    const out = (await inlineAssets(html, root, root)).html;

    expect(out).toContain('<style>');
    expect(out).toContain('body{background:#000}');
    expect(out).not.toContain('<link');
  });

  it('inlines a local script', async () => {
    await fs.writeFile(path.join(root, 'app.js'), 'console.log(1)', 'utf8');
    const html = '<html><body><script src="app.js"></script></body></html>';

    const out = (await inlineAssets(html, root, root)).html;

    expect(out).toContain('console.log(1)');
    expect(out).not.toContain('src="app.js"');
  });

  it('leaves remote URLs alone rather than fetching them', async () => {
    const html = '<link rel="stylesheet" href="https://cdn.example.com/a.css">';

    expect((await inlineAssets(html, root, root)).html).toBe(html);
  });

  it('leaves a missing asset untouched instead of failing the preview', async () => {
    const html = '<link rel="stylesheet" href="nope.css">';

    expect((await inlineAssets(html, root, root)).html).toBe(html);
  });

  it('refuses to inline a file outside the worktree', async () => {
    const outside = path.join(root, 'secret.css');
    await fs.writeFile(outside, 'body{color:red}', 'utf8');
    const inner = path.join(root, 'wt');
    await fs.mkdir(inner);
    const html = '<link rel="stylesheet" href="../secret.css">';

    const out = (await inlineAssets(html, inner, inner)).html;

    expect(out).toBe(html);
    expect(out).not.toContain('color:red');
  });

  it('neutralises a closing script tag inside an inlined file', async () => {
    await fs.writeFile(path.join(root, 'a.js'), 'var s = "</script>";', 'utf8');
    const html = '<script src="a.js"></script>';

    const out = (await inlineAssets(html, root, root)).html;

    expect(out).not.toContain('"</script>"');
    expect(out).toContain('<\\/script>');
  });

  it('ignores a link that is not a stylesheet', async () => {
    await fs.writeFile(path.join(root, 'icon.png'), 'x', 'utf8');
    const html = '<link rel="icon" href="icon.png">';

    expect((await inlineAssets(html, root, root)).html).toBe(html);
  });

  it('reports what it could not resolve, so an unstyled page can say why', async () => {
    const html = '<link rel="stylesheet" href="nope.css"><script src="gone.js"></script>';

    const out = await inlineAssets(html, root, root);

    expect(out.missing).toEqual(['nope.css', 'gone.js']);
  });

  // A worktree is not where the repo is, so a correct reference such as
  // `../shared/common.css` resolves to nothing under `.best-of-m`. The reference is not
  // wrong, its base is -- which is what made two variants render unstyled.
  it('resolves an asset that sits outside the repo, relative to the repo', async () => {
    const assets = path.join(root, 'assets');
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'wt', 'run', 'variant');
    await fs.mkdir(assets, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(assets, 'common.css'), 'body{background:#000}', 'utf8');
    const html = '<link rel="stylesheet" href="../assets/common.css">';

    const out = await inlineAssets(html, worktree, worktree, repo);

    expect(out.html).toContain('body{background:#000}');
    expect(out.html).not.toContain('<link');
    expect(out.missing).toEqual([]);
  });

  it('mirrors the page position in the worktree onto the repo', async () => {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'wt');
    await fs.mkdir(path.join(repo, 'assets'), { recursive: true });
    await fs.mkdir(path.join(worktree, 'pages'), { recursive: true });
    await fs.writeFile(path.join(repo, 'assets', 'a.css'), 'p{color:red}', 'utf8');
    const html = '<link rel="stylesheet" href="../assets/a.css">';

    const out = await inlineAssets(html, path.join(worktree, 'pages'), worktree, repo);

    expect(out.html).toContain('p{color:red}');
  });

  it('prefers the worktree copy over the repo copy', async () => {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'wt');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(repo, 'a.css'), 'p{color:red}', 'utf8');
    await fs.writeFile(path.join(worktree, 'a.css'), 'p{color:lime}', 'utf8');
    const html = '<link rel="stylesheet" href="a.css">';

    const out = await inlineAssets(html, worktree, worktree, repo);

    expect(out.html).toContain('p{color:lime}');
    expect(out.html).not.toContain('color:red');
  });

  // The repo fallback deliberately reaches outside the repo, as a browser would, so the
  // extension is what keeps it to assets.
  it('will not pull an arbitrary file in through the repo fallback', async () => {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'wt');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(root, 'id_rsa'), 'PRIVATE KEY', 'utf8');
    const html = '<link rel="stylesheet" href="../id_rsa">';

    const out = await inlineAssets(html, worktree, worktree, repo);

    expect(out.html).toBe(html);
    expect(out.html).not.toContain('PRIVATE KEY');
    expect(out.missing).toEqual(['../id_rsa']);
  });

  it('still refuses the repo fallback when no repo is given', async () => {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'wt');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(root, 'outside.css'), 'p{color:red}', 'utf8');
    const html = '<link rel="stylesheet" href="../outside.css">';

    expect((await inlineAssets(html, worktree, worktree)).html).toBe(html);
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

  it('resolves a shared asset through the repo, not the worktree', async () => {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'wt', 'run', 'variant');
    await fs.mkdir(path.join(root, 'shared'), { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(root, 'shared', 'common.css'), 'body{background:#000}', 'utf8');
    await fs.writeFile(
      path.join(worktree, 'page.html'),
      '<link rel="stylesheet" href="../shared/common.css"><h1>hi</h1>',
      'utf8',
    );

    const preview = await buildPreview(worktree, ['page.html'], repo);

    expect(preview?.html).toContain('body{background:#000}');
    expect(preview?.missingAssets).toBeUndefined();
  });

  it('records an asset it could not resolve', async () => {
    await fs.writeFile(path.join(root, 'page.html'), '<link rel="stylesheet" href="gone.css">', 'utf8');

    const preview = await buildPreview(root, ['page.html']);

    expect(preview?.missingAssets).toEqual(['gone.css']);
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
    expect(await buildPreview(root, ['data.bin'])).toBeUndefined();
  });

  // This is the case that showed no preview at all: a run that produces only an SVG.
  it('renders an SVG result and keeps its markup', async () => {
    await fs.writeFile(path.join(root, 'logo.svg'), '<svg><circle r="4"/></svg>', 'utf8');

    const preview = await buildPreview(root, ['logo.svg']);

    expect(preview?.kind).toBe('image');
    expect(preview?.file).toBe('logo.svg');
    expect(preview?.html).toContain('data:image/svg+xml;base64,');
    expect(preview?.code).toBe('<svg><circle r="4"/></svg>');
  });

  it('carries the bitmap an SVG references into the preview', async () => {
    await fs.writeFile(path.join(root, 'image.png'), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(root, 'logo.svg'), '<svg><image href="image.png"/></svg>', 'utf8');

    const preview = await buildPreview(root, ['logo.svg']);
    const svg = Buffer.from(
      (preview?.html ?? '').split('data:image/svg+xml;base64,')[1].split('"')[0],
      'base64',
    ).toString('utf8');

    expect(svg).toContain('data:image/png;base64,AQID');
    expect(preview?.missingAssets).toBeUndefined();
    // The source view still shows what the model actually wrote.
    expect(preview?.code).toContain('href="image.png"');
  });

  it('renders a bitmap result, which has no source to show', async () => {
    await fs.writeFile(path.join(root, 'logo.png'), Buffer.from([1, 2, 3]));

    const preview = await buildPreview(root, ['logo.png']);

    expect(preview?.kind).toBe('image');
    expect(preview?.html).toContain('data:image/png;base64,AQID');
    expect(preview?.code).toBeUndefined();
  });

  it('skips the frame for an image too large to inline, rather than the card', async () => {
    await fs.writeFile(path.join(root, 'huge.png'), Buffer.alloc(800_000, 1));

    const preview = await buildPreview(root, ['huge.png']);

    expect(preview?.kind).toBe('image');
    expect(preview?.html).toBeUndefined();
  });

  it('returns nothing when an image cannot be read', async () => {
    expect(await buildPreview(root, ['gone.png'])).toBeUndefined();
  });
});
