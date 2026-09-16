import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Best of M', { log: true });
  }
  return channel;
}

export function log(): vscode.LogOutputChannel {
  return channel ?? initLog();
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
