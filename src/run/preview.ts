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

async function readSibling(dir: string, root: string, href: string): Promise<string | undefined> {
  const clean = href.split('?')[0].split('#')[0];
  const target = path.resolve(dir, clean);
  // An inlined asset must not be a way to read files outside the worktree.
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Inline local stylesheets and scripts into the page.
 *
 * The preview is rendered in a sandboxed `srcdoc` frame, which has an opaque origin and
 * therefore cannot load subresources from the worktree at all — measured, not assumed.
 * Anything not inlined here simply will not appear, which is why a generated page that
 * links a shared `common.css` rendered as a blank box. Remote URLs are deliberately left
 * as-is: they are blocked by the frame's policy rather than silently fetched.
 */
export async function inlineAssets(html: string, dir: string, root: string): Promise<string> {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)];
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
    const css = await readSibling(dir, root, href);
    if (css !== undefined) {
      result = result.replace(tag, `<style>\n${css}\n</style>`);
    }
  }

  const scripts = [...result.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi)];
  for (const match of scripts) {
    const href = match[1];
    if (!isLocalHref(href)) {
      continue;
    }
    const js = await readSibling(dir, root, href);
    if (js !== undefined) {
      // Any literal </script> inside the file would end the tag early.
      result = result.replace(match[0], `<script>\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`);
    }
  }

  return result;
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
  if (isHtml) {
    const inlined = await inlineAssets(source, path.dirname(absolute), worktreePath);
    html = inlined.length > MAX_HTML_CHARS ? undefined : inlined;
  }

  return {
    file,
    kind: isHtml ? 'html' : 'code',
    path: absolute,
    code,
    html,
    truncated,
    language,
  };
}
