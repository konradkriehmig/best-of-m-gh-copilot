import * as vscode from 'vscode';
import { RankedVariant, RunRecord, VariantState } from '../util/types';

export type DashboardMessage =
  | { type: 'openDiff'; variantId: string }
  | { type: 'openFileDiff'; variantId: string; file: string }
  | { type: 'compare'; variantId: string; otherId: string }
  | { type: 'chooseWinner'; variantId: string }
  | { type: 'openFolder'; variantId: string }
  | { type: 'openPreview'; variantId: string }
  | { type: 'cancel' }
  | { type: 'cancelVariant'; variantId: string }
  | { type: 'ready' };

export interface DashboardState {
  run?: RunRecord;
  ranking: RankedVariant[];
  busy?: string;
  preview?: { mode: 'rendered' | 'source' | 'off'; height: number };
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
      'bestOfM.dashboard',
      'Best of M',
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
    this.state = this.withPreviewUris(state);
    if (this.ready) {
      void this.panel.webview.postMessage({ type: 'state', state: this.state });
    }
  }

  /**
   * Attach the preview settings, and strip the rendered HTML when it is not wanted.
   *
   * Previews used to be framed straight out of the worktree by webview URI. That never
   * worked: the resource is served (HTTP 200), but a nested frame's own scripts never run,
   * so every page rendered as a blank box. The page is now inlined by `buildPreview` and
   * rendered from `srcdoc` instead, which needs no resource grant at all.
   */
  private withPreviewUris(state: DashboardState): DashboardState {
    const settings = vscode.workspace.getConfiguration('bestOfM');
    const mode = settings.get<'rendered' | 'source' | 'off'>('preview.mode', 'rendered');
    const height = settings.get<number>('preview.height', 320);
    const withSettings = { ...state, preview: { mode, height } };

    const run = state.run;
    if (!run || mode === 'off') {
      return withSettings;
    }

    const strip = (variant: VariantState): VariantState => {
      // Source mode must never be able to execute the generated page.
      if (!variant.preview || mode === 'rendered') {
        return variant;
      }
      // A bitmap cannot execute anything and has no source to show instead, so stripping
      // it would leave an empty card rather than a safer one.
      if (variant.preview.kind === 'image' && !variant.preview.code) {
        return variant;
      }
      return { ...variant, preview: { ...variant.preview, html: undefined } };
    };

    return {
      ...withSettings,
      run: { ...run, variants: run.variants.map(strip) },
      ranking: state.ranking.map((entry) => ({ ...entry, variant: strip(entry.variant) })),
    };
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

    // A `srcdoc` frame inherits this policy, so it is what decides whether a generated
    // page can run its own inline scripts. A nonce cannot help the child -- it has no way
    // to know one -- and the presence of any nonce makes the browser ignore
    // 'unsafe-inline' everywhere, which is exactly what rendered every preview blank.
    // Measured, not assumed: with a nonce the child is blocked; without one it runs.
    //
    // This does not weaken the dashboard itself. Its markup is static, every piece of
    // model- or agent-produced text goes through textContent rather than innerHTML, and
    // `default-src 'none'` still blocks the frame from reaching the network or the disk.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Best of M</title>
</head>
<body>
<div id="root"><p class="empty">No run yet. Use <strong>Best of M: Run Prompt Across Models</strong>.</p></div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
