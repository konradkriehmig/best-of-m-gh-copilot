import * as vscode from 'vscode';
import { log } from '../util/log';

export interface ModelOption {
  id: string;
  label: string;
  detail?: string;
  source: 'vscode' | 'settings' | 'fallback';
}

/**
 * Model ids that ship as a starting point when discovery finds nothing. The CLI is the
 * source of truth and rejects unknown ids loudly, so this list only needs to be a
 * reasonable default, not exhaustive.
 */
const FALLBACK_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'gpt-5.6-sol', 'gemini-3.8-flash'];

/**
 * The VS Code language model API and the CLI maintain separate catalogues. Ids mostly
 * line up, so discovered ids seed the picker, and anything the CLI rejects surfaces as a
 * clear per-variant error rather than silently running the wrong model.
 */
export async function discoverModels(): Promise<ModelOption[]> {
  const byId = new Map<string, ModelOption>();

  const configured = vscode.workspace
    .getConfiguration('bestOfN')
    .get<string[]>('models', [])
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  for (const id of configured) {
    byId.set(id, { id, label: id, detail: 'from settings', source: 'settings' });
  }

  try {
    const chatModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    for (const model of chatModels) {
      if (byId.has(model.id)) {
        continue;
      }
      byId.set(model.id, {
        id: model.id,
        label: model.id,
        detail: model.name && model.name !== model.id ? model.name : undefined,
        source: 'vscode',
      });
    }
  } catch (err) {
    log().warn(`Could not enumerate VS Code chat models: ${String(err)}`);
  }

  if (byId.size === 0) {
    for (const id of FALLBACK_MODELS) {
      byId.set(id, { id, label: id, detail: 'default suggestion', source: 'fallback' });
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
