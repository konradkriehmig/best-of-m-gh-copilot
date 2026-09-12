import * as vscode from 'vscode';
import { RankedVariant, RunRecord } from '../util/types';

export type DashboardMessage =
  | { type: 'openDiff'; variantId: string }
  | { type: 'openFileDiff'; variantId: string; file: string }
  | { type: 'compare'; variantId: string; otherId: string }
  | { type: 'chooseWinner'; variantId: string }
  | { type: 'openTerminal'; variantId: string }
  | { type: 'openTranscript'; variantId: string }
  | { type: 'openFolder'; variantId: string }
  | { type: 'cancel' }
  | { type: 'ready' };

export interface DashboardState {
  run?: RunRecord;
  ranking: RankedVariant[];
  busy?: string;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class Dashboard {
  private static current: Dashboard | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly handlers = new Set<(message: DashboardMessage) => void>();
  private state: DashboardState = { ranking: [] };
  private ready = false;

  private constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'bestOfN.dashboard',
      'Best of N',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );

    this.panel.webview.html = this.render();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: DashboardMessage) => {
        if (message.type === 'ready') {
          this.ready = true;
          void this.panel.webview.postMessage({ type: 'state', state: this.state });
          return;
        }
        for (const handler of this.handlers) {
          handler(message);
        }
      }),
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  static show(extensionUri: vscode.Uri): Dashboard {
    if (Dashboard.current) {
      Dashboard.current.panel.reveal(vscode.ViewColumn.Active, false);
      return Dashboard.current;
    }
    Dashboard.current = new Dashboard(extensionUri);
    return Dashboard.current;
  }

  static get instance(): Dashboard | undefined {
    return Dashboard.current;
  }

  onMessage(handler: (message: DashboardMessage) => void): vscode.Disposable {
    this.handlers.add(handler);
    return new vscode.Disposable(() => this.handlers.delete(handler));
  }

  update(state: DashboardState): void {
    this.state = state;
    if (this.ready) {
      void this.panel.webview.postMessage({ type: 'state', state });
    }
  }

  dispose(): void {
    Dashboard.current = undefined;
    this.handlers.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.panel.dispose();
  }

  private render(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.css'),
    );
    const n = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Best of N</title>
</head>
<body>
<div id="root"><p class="empty">No run yet. Use <strong>Best of N: Run Prompt Across Models</strong>.</p></div>
<script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
