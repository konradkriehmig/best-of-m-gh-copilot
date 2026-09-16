import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { VariantPreview } from '../util/types';

/**
 * Picking what to show under a variant card. Comparing rendered output side by side is
 * the whole point of a best-of-N run, so anything that can be *shown* wins over anything
 * that can only be read: an HTML entry point first, then an image, then the source the
 * agent actually wrote.
 */

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

/** Images are rendered, not read, so they need their media type rather than a language. */
const IMAGE_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

/** Ranked so a vector logo beats an exported bitmap of the same thing. */
const IMAGE_EXTENSIONS = ['.svg', '.png', '.webp', '.avif', '.jpg', '.jpeg', '.gif', '.bmp', '.ico'];

/** Extensions worth previewing as source, best first. */
const CODE_EXTENSIONS = [
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.rs',
  '.go',
  '.java',
  '.rb',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.php',
  '.swift',
  '.kt',
  '.sh',
  '.sql',
  '.css',
  '.json',
  '.yml',
  '.yaml',
  '.md',
];

const LANGUAGES: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.sh': 'shell',
  '.sql': 'sql',
  '.css': 'css',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.md': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.svg': 'xml',
};

/** Keeps a big generated file from bloating every dashboard message. */
const MAX_CODE_CHARS = 40_000;

/** A rendered page carries its assets inline, so it needs more room than a source view. */
const MAX_HTML_CHARS = 400_000;

/**
 * An image is base64'd into the message, which costs a third more than the file itself.
 * Generous enough for any logo or diagram, small enough that two dozen variants do not
 * push megabytes through `postMessage` on every state change.
 */
const MAX_IMAGE_BYTES = 750_000;

/** The wrapper document is mostly the data URI, so it gets a matching ceiling. */
const MAX_IMAGE_CHARS = 1_100_000;

/** Only same-directory-ish relative paths are inlined; remote URLs are left alone. */
function isLocalHref(href: string): boolean {
  return (
    href.length > 0 &&
    !/^[a-z][a-z0-9+.-]*:/i.test(href) &&
    !href.startsWith('//') &&
    !href.startsWith('#') &&
    !href.startsWith('data:')
  );
}

/** A shared asset pulled in from the repo is read whole, but not without a ceiling. */
const MAX_ASSET_CHARS = 200_000;

async function readText(target: string, limit = MAX_ASSET_CHARS): Promise<string | undefined> {
  try {
    const text = await fs.readFile(target, 'utf8');
    return text.length > limit ? undefined : text;
  } catch {
    return undefined;
  }
}

export interface InlineResult {
  html: string;
  /** Local assets that could not be resolved, so the page will render without them. */
  missing: string[];
}

/**
 * Where an asset the page refers to might actually live: the worktree first, then the
 * real repository.
 *
 * The repository fallback exists because a worktree is not where the repository is. A page
 * that correctly links `../shared/common.css` resolves that against the repo when opened
 * normally, but against the worktree's parent — some directory under `.best-of-m` — when
 * previewed. The reference is not wrong; its base is. So the page's position inside the
 * worktree is mirrored onto the repo and the same reference is resolved from there, which
 * reproduces what the file would load if it were opened in place.
 *
 * That deliberately reaches outside the repository, exactly as the browser would. It is
 * bounded by the file extension and a size ceiling, and whatever comes back is only ever
 * inlined into a frame with an opaque origin and no network access.
 */
function assetCandidates(
  dir: string,
  root: string,
  href: string,
  extensions: string[],
  repoRoot?: string,
): string[] {
  const clean = href.split('?')[0].split('#')[0];
  const candidates: string[] = [];
  const inWorktree = path.resolve(dir, clean);

  const relative = path.relative(root, inWorktree);
  const contained = relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (contained) {
    candidates.push(inWorktree);
  }

  if (!repoRoot) {
    return candidates;
  }
  const relativeDir = path.relative(root, dir);
  if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) {
    return candidates;
  }
  const inRepo = path.resolve(repoRoot, relativeDir, clean);
  if (inRepo !== inWorktree && extensions.includes(path.extname(inRepo).toLowerCase())) {
    candidates.push(inRepo);
  }
  return candidates;
}

async function readAsset(
  dir: string,
  root: string,
  href: string,
  extensions: string[],
  repoRoot?: string,
): Promise<string | undefined> {
  for (const candidate of assetCandidates(dir, root, href, extensions, repoRoot)) {
    const text = await readText(candidate);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

/** The same search, for files that are not text and must be base64'd rather than read. */
async function readAssetBytes(
  dir: string,
  root: string,
  href: string,
  extensions: string[],
  repoRoot?: string,
): Promise<Buffer | undefined> {
  for (const candidate of assetCandidates(dir, root, href, extensions, repoRoot)) {
    try {
      const data = await fs.readFile(candidate);
      if (data.byteLength <= MAX_IMAGE_BYTES) {
        return data;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * Inline local stylesheets and scripts into the page.
 *
 * The preview is rendered in a sandboxed `srcdoc` frame, which has an opaque origin and
 * therefore cannot load subresources from the worktree at all — measured, not assumed.
 * Anything not inlined here simply will not appear, which is why a generated page that
 * links a shared `common.css` rendered as a blank box. Remote URLs are deliberately left
 * as-is: they are blocked by the frame's policy rather than silently fetched.
 *
 * Whatever could not be resolved is reported rather than dropped, so an unstyled preview
 * says why instead of looking like a broken renderer.
 */
export async function inlineAssets(
  html: string,
  dir: string,
  root: string,
  repoRoot?: string,
): Promise<InlineResult> {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)];
  const missing: string[] = [];
  let result = html;

  for (const match of links) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) {
      continue;
    }
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !isLocalHref(href)) {
      continue;
    }
    const css = await readAsset(dir, root, href, ['.css'], repoRoot);
    if (css === undefined) {
      missing.push(href);
    } else {
      result = result.replace(tag, `<style>\n${css}\n</style>`);
    }
  }

  const scripts = [...result.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi)];
  for (const match of scripts) {
    const href = match[1];
    if (!isLocalHref(href)) {
      continue;
    }
    const js = await readAsset(dir, root, href, ['.js', '.mjs', '.cjs'], repoRoot);
    if (js === undefined) {
      missing.push(href);
    } else {
      // Any literal </script> inside the file would end the tag early.
      result = result.replace(match[0], `<script>\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`);
    }
  }

  return { html: result, missing };
}

export interface InlineSvgResult {
  svg: string;
  /** Referenced images that could not be resolved, so a half-empty logo can say why. */
  missing: string[];
}

/**
 * Inline the bitmaps an SVG points at.
 *
 * This is the same problem the stylesheets had, and it bites harder here. Asked to clean
 * up a hand-drawn `image.png`, several models produce an SVG that *references* the
 * original — `<image href="image.png">` with a filter over it — which is a perfectly good
 * answer that renders as an empty box in any context that cannot fetch it. The preview
 * frame is exactly such a context, so the referenced file is read and base64'd into the
 * markup before it ever reaches the webview.
 */
export async function inlineSvgImages(
  svg: string,
  dir: string,
  root: string,
  repoRoot?: string,
): Promise<InlineSvgResult> {
  const tags = [...svg.matchAll(/<image\b[^>]*>/gi)];
  const missing: string[] = [];
  let result = svg;

  for (const match of tags) {
    const tag = match[0];
    // `href` on modern SVG, `xlink:href` on anything older.
    const href = /(?:xlink:)?href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !isLocalHref(href)) {
      continue;
    }
    const mime = IMAGE_MIME[path.extname(href.split('?')[0].split('#')[0]).toLowerCase()];
    if (!mime) {
      missing.push(href);
      continue;
    }
    const bytes = await readAssetBytes(dir, root, href, IMAGE_EXTENSIONS, repoRoot);
    if (bytes === undefined) {
      missing.push(href);
      continue;
    }
    // The referenced file gets the same treatment as the preview file itself: its own
    // bytes decide its type, not the name the SVG happens to use for it.
    const dataUri = `data:${sniffImageMime(bytes) ?? mime};base64,${bytes.toString('base64')}`;
    const inlined = tag.replace(
      /((?:xlink:)?href\s*=\s*["'])([^"']+)(["'])/gi,
      (whole, open: string, value: string, close: string) =>
        isLocalHref(value) ? `${open}${dataUri}${close}` : whole,
    );
    result = result.replace(tag, inlined);
  }

  return { svg: result, missing };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Human-readable names for the note shown when a file's name lies about its format. */
const MIME_LABELS: Record<string, string> = {
  'image/svg+xml': 'SVG',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/bmp': 'BMP',
  'image/x-icon': 'icon',
};

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString('latin1');
}

/**
 * An SVG document, whatever it is called. The root element has to be `<svg>`, so an HTML
 * page that merely contains one is not mistaken for an image; an XML declaration, DOCTYPE
 * or comment in front of it is skipped, as is a byte-order mark.
 */
function looksLikeSvg(bytes: Buffer): boolean {
  let head = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  for (;;) {
    const next = head
      .replace(/^<\?[\s\S]*?\?>\s*/, '')
      .replace(/^<!--[\s\S]*?-->\s*/, '')
      .replace(/^<!DOCTYPE[^>]*>\s*/i, '');
    if (next === head) {
      return /^<svg[\s/>]/i.test(head);
    }
    head = next;
  }
}

/**
 * Identify an image by its contents rather than its name.
 *
 * Necessary because the agents can only write text. Told to "make image.png a clean icon" a
 * model cannot produce PNG pixels, so it writes SVG markup and leaves the name alone — a
 * file called `.png` that is really SVG. Trusting the extension hands the webview
 * `data:image/png` wrapped around SVG source, which renders as a broken-image icon.
 *
 * Returns nothing when the bytes are not an image at all, so the caller can fall back to
 * showing the file as text instead of framing something that will never draw.
 */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && ascii(bytes, 1, 4) === 'PNG' && bytes[0] === 0x89) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(bytes, 8, 12))) {
    return 'image/avif';
  }
  if (bytes.length >= 2 && ascii(bytes, 0, 2) === 'BM') {
    return 'image/bmp';
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return 'image/x-icon';
  }
  return looksLikeSvg(bytes) ? 'image/svg+xml' : undefined;
}

/**
 * Wrap an image in a page the frame can render.
 *
 * Deliberately an `<img>` with a data URI rather than inline SVG markup. Loaded that way a
 * browser renders SVG in secure static mode: no scripts, no external fetches. So unlike
 * the HTML preview — which does run whatever the model wrote — an image preview can only
 * ever draw. It is framed with an empty `sandbox` for the same reason.
 *
 * The checkerboard is not decoration: a transparent logo on a flat background is
 * indistinguishable from one with a matching opaque background, which is precisely the
 * difference you are comparing variants for.
 */
function imageDocument(dataUri: string, alt: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;height:100%}',
    'body{display:flex;align-items:center;justify-content:center;background-color:#fff;',
    'background-image:',
    'linear-gradient(45deg,#e9e9e9 25%,transparent 25%),',
    'linear-gradient(-45deg,#e9e9e9 25%,transparent 25%),',
    'linear-gradient(45deg,transparent 75%,#e9e9e9 75%),',
    'linear-gradient(-45deg,transparent 75%,#e9e9e9 75%);',
    'background-size:16px 16px;',
    'background-position:0 0,0 8px,8px -8px,-8px 0}',
    'img{max-width:100%;max-height:100%;object-fit:contain}',
    '</style></head><body>',
    `<img src="${dataUri}" alt="${escapeAttribute(alt)}">`,
    '</body></html>',
  ].join('');
}

/** Says so when the extension disagrees with the bytes, because that is worth knowing. */
function formatNote(file: string, mime: string): string | undefined {
  const declared = IMAGE_MIME[extensionOf(file)];
  if (!declared || declared === mime) {
    return undefined;
  }
  const actual = MIME_LABELS[mime] || mime;
  const claimed = MIME_LABELS[declared] || declared;
  return `Contains ${actual} despite the ${extensionOf(file)} name, so anything expecting ${claimed} will not read it.`;
}

/**
 * Build the preview for an image result. SVG keeps its source, so the markup is still one
 * click away; a bitmap has none to show. Returns nothing when the file is not an image at
 * all, leaving the caller to show it as text.
 */
async function buildImagePreview(
  file: string,
  absolute: string,
  worktreePath: string,
  repoRoot?: string,
): Promise<VariantPreview | undefined> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absolute);
  } catch {
    return undefined;
  }

  const mime = sniffImageMime(bytes);
  if (!mime) {
    return undefined;
  }
  const note = formatNote(file, mime);

  if (mime === 'image/svg+xml') {
    const source = bytes.toString('utf8');
    const inlined = await inlineSvgImages(source, path.dirname(absolute), worktreePath, repoRoot);
    const document = imageDocument(
      `data:${mime};base64,${Buffer.from(inlined.svg, 'utf8').toString('base64')}`,
      file,
    );
    const truncated = source.length > MAX_CODE_CHARS;
    return {
      file,
      kind: 'image',
      path: absolute,
      code: truncated ? source.slice(0, MAX_CODE_CHARS) : source,
      html: document.length > MAX_IMAGE_CHARS ? undefined : document,
      missingAssets: inlined.missing.length > 0 ? inlined.missing : undefined,
      note,
      truncated,
      language: LANGUAGES['.svg'],
    };
  }

  const document =
    bytes.byteLength > MAX_IMAGE_BYTES
      ? undefined
      : imageDocument(`data:${mime};base64,${bytes.toString('base64')}`, file);
  return {
    file,
    kind: 'image',
    path: absolute,
    html: document,
    note,
    truncated: false,
  };
}

/**
 * An entry point is more useful than a fragment, so prefer an obvious index, then the
 * shallowest path, then the shortest name. Ties are broken alphabetically so the choice
 * is stable between runs.
 */
function pickBest(files: string[]): string | undefined {
  const ranked = [...files].sort((a, b) => {
    const aIndex = /(^|\/)index\.html?$/i.test(a) ? 0 : 1;
    const bIndex = /(^|\/)index\.html?$/i.test(b) ? 0 : 1;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }
    const aDepth = a.split('/').length;
    const bDepth = b.split('/').length;
    if (aDepth !== bDepth) {
      return aDepth - bDepth;
    }
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    return a.localeCompare(b);
  });
  return ranked[0];
}

function extensionOf(file: string): string {
  return path.extname(file).toLowerCase();
}

export function choosePreviewFile(files: string[]): string | undefined {
  const usable = files.filter((file) => file.trim().length > 0);

  const html = usable.filter((file) => HTML_EXTENSIONS.has(extensionOf(file)));
  if (html.length > 0) {
    return pickBest(html);
  }

  // Before source, because a picture of the result beats the markup that draws it.
  for (const extension of IMAGE_EXTENSIONS) {
    const matches = usable.filter((file) => extensionOf(file) === extension);
    if (matches.length > 0) {
      return pickBest(matches);
    }
  }

  for (const extension of CODE_EXTENSIONS) {
    const matches = usable.filter((file) => extensionOf(file) === extension);
    if (matches.length > 0) {
      return pickBest(matches);
    }
  }

  return undefined;
}

/** A NUL byte near the start is the cheapest reliable sign that a file is not text. */
async function looksLikeText(target: string): Promise<boolean> {
  try {
    const bytes = await fs.readFile(target);
    return !bytes.subarray(0, 4096).includes(0);
  } catch {
    return false;
  }
}

/**
 * Build the preview payload for a variant. HTML is inlined into a self-contained document
 * so it can be rendered in a sandboxed frame, an image is base64'd into one, and anything
 * else is read in as text.
 */
export async function buildPreview(
  worktreePath: string,
  files: string[],
  repoRoot?: string,
): Promise<VariantPreview | undefined> {
  const file = choosePreviewFile(files);
  if (!file) {
    return undefined;
  }

  const extension = extensionOf(file);
  const absolute = path.join(worktreePath, file);
  const language = LANGUAGES[extension];

  if (IMAGE_MIME[extension]) {
    const image = await buildImagePreview(file, absolute, worktreePath, repoRoot);
    if (image) {
      return image;
    }
    // Named like an image but not one. Show whatever text it holds, unless it is binary
    // noise -- a corrupt bitmap decoded as UTF-8 is worse than no preview.
    if (!(await looksLikeText(absolute))) {
      return undefined;
    }
  }

  let source: string;
  try {
    source = await fs.readFile(absolute, 'utf8');
  } catch {
    // The file was deleted, or is not text. Nothing to preview.
    return undefined;
  }

  const truncated = source.length > MAX_CODE_CHARS;
  const code = truncated ? source.slice(0, MAX_CODE_CHARS) : source;
  const isHtml = HTML_EXTENSIONS.has(extension);

  let html: string | undefined;
  let missingAssets: string[] | undefined;
  if (isHtml) {
    const inlined = await inlineAssets(source, path.dirname(absolute), worktreePath, repoRoot);
    html = inlined.html.length > MAX_HTML_CHARS ? undefined : inlined.html;
    missingAssets = inlined.missing.length > 0 ? inlined.missing : undefined;
  }

  return {
    file,
    kind: isHtml ? 'html' : 'code',
    path: absolute,
    code,
    html,
    missingAssets,
    truncated,
    language,
  };
}
