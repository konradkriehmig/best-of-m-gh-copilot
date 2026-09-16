import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { VariantPreview } from '../util/types';

/**
 * Picking what to show under a variant card. Comparing rendered output side by side is
 * the whole point of a best-of-N run on front-end work, so an HTML entry point always
 * wins; otherwise fall back to showing the source the agent actually wrote.
 */

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

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
};

/** Keeps a big generated file from bloating every dashboard message. */
const MAX_CODE_CHARS = 40_000;

/** A rendered page carries its assets inline, so it needs more room than a source view. */
const MAX_HTML_CHARS = 400_000;

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
 * Find an asset the page refers to, first in the worktree and then in the real repository.
 *
 * The repository fallback exists because a worktree is not where the repository is. A page
 * that correctly links `../shared/common.css` resolves that against the repo when opened
 * normally, but against the worktree's parent — some directory under `.best-of-m` — when
 * previewed. The reference is not wrong; its base is. So the page's position inside the
 * worktree is mirrored onto the repo and the same reference is resolved from there, which
 * reproduces what the file would load if it were opened in place.
 *
 * This deliberately reaches outside the repository, exactly as the browser would. It is
 * bounded by the file extension and a size ceiling, and whatever comes back is only ever
 * inlined into a frame with an opaque origin and no network access.
 */
async function readAsset(
  dir: string,
  root: string,
  href: string,
  extensions: string[],
  repoRoot?: string,
): Promise<string | undefined> {
  const clean = href.split('?')[0].split('#')[0];
  const inWorktree = path.resolve(dir, clean);

  const relative = path.relative(root, inWorktree);
  const contained = relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (contained) {
    const text = await readText(inWorktree);
    if (text !== undefined) {
      return text;
    }
  }

  if (!repoRoot) {
    return undefined;
  }
  const relativeDir = path.relative(root, dir);
  if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) {
    return undefined;
  }
  const inRepo = path.resolve(repoRoot, relativeDir, clean);
  if (inRepo === inWorktree || !extensions.includes(path.extname(inRepo).toLowerCase())) {
    return undefined;
  }
  return readText(inRepo);
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

  for (const extension of CODE_EXTENSIONS) {
    const matches = usable.filter((file) => extensionOf(file) === extension);
    if (matches.length > 0) {
      return pickBest(matches);
    }
  }

  return undefined;
}

/**
 * Build the preview payload for a variant. HTML is inlined into a self-contained document
 * so it can be rendered in a sandboxed frame; anything else is read in as text.
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
