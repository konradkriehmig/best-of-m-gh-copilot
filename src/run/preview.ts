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
 * Build the preview payload for a variant. HTML is referenced by path and framed live
 * from the worktree, so relative assets such as a shared stylesheet still resolve;
 * anything else is read into the message as text.
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

  return {
    file,
    kind: HTML_EXTENSIONS.has(extension) ? 'html' : 'code',
    path: absolute,
    code,
    truncated,
    language,
  };
}
