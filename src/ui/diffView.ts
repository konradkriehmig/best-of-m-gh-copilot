import * as path from 'node:path';
import * as vscode from 'vscode';
import { diffText, fileAtRef } from '../git/diff';
import { VariantState } from '../util/types';

export const BASE_SCHEME = 'best-of-n-base';
export const PATCH_SCHEME = 'best-of-n-patch';

interface BaseQuery {
  repoRoot: string;
  ref: string;
  file: string;
}

/**
 * Serves the "before" side of a diff (a blob at a ref) and whole-variant patches as
 * read-only virtual documents, so no temporary files are written to disk.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly patches = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme === PATCH_SCHEME) {
      return this.patches.get(uri.toString()) ?? '';
    }
    try {
      const query = JSON.parse(decodeURIComponent(uri.query)) as BaseQuery;
      const content = await fileAtRef(query.repoRoot, query.ref, query.file);
      return content ?? '';
    } catch {
      return '';
    }
  }

  setPatch(uri: vscode.Uri, content: string): void {
    this.patches.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    this.patches.clear();
  }
}

function baseUri(repoRoot: string, ref: string, file: string): vscode.Uri {
  const query = encodeURIComponent(JSON.stringify({ repoRoot, ref, file } satisfies BaseQuery));
  return vscode.Uri.parse(`${BASE_SCHEME}:${file}?${query}`);
}

/** Open the full patch for one variant as a read-only `.diff` document. */
export async function openVariantPatch(
  provider: DiffContentProvider,
  repoRoot: string,
  baseRef: string,
  variant: VariantState,
): Promise<void> {
  const patch = await diffText(repoRoot, baseRef, variant.branch);
  if (patch.trim().length === 0) {
    void vscode.window.showInformationMessage(`${variant.label} produced no changes.`);
    return;
  }

  const uri = vscode.Uri.parse(`${PATCH_SCHEME}:${variant.label.replace(/[^\w.-]+/g, '-')}.diff`);
  provider.setPatch(uri, patch);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'diff');
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Open a side-by-side editor comparing one file at the base ref with the variant's copy. */
export async function openFileDiff(
  repoRoot: string,
  baseRef: string,
  variant: VariantState,
  file: string,
): Promise<void> {
  const left = baseUri(repoRoot, baseRef, file);
  const right = vscode.Uri.file(path.join(variant.worktreePath, file));
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${file}: ${baseRef} <-> ${variant.label}`,
    { preview: true },
  );
}
