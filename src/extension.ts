import * as path from 'node:path';
import * as vscode from 'vscode';
import { CliNotFoundError, cliVersion, resolveCli, CliInvocation } from './cli/locate';
import { repoRoot } from './git/exec';
import { findOrphans, removeWorktree } from './git/worktrees';
import { RunController } from './run/session';
import { buildRunPlan, RunPlan } from './ui/picker';
import { registerChatParticipant, ChatRunHost } from './ui/chatParticipant';
import { registerChatTool } from './ui/chatTool';
import { Dashboard, DashboardMessage } from './ui/dashboard';
import { DiffContentProvider, BASE_SCHEME, PATCH_SCHEME, openFileDiff, openVariantPatch } from './ui/diffView';
import { cleanupRun, confirmWinner, mergeWinner } from './merge/winner';
import { errorMessage, initLog, log } from './util/log';
import { RankedVariant, RunRecord } from './util/types';

const ACTIVE_RUN_KEY = 'bestOfN.activeWorktrees';

let controller: RunController | undefined;
let diffProvider: DiffContentProvider | undefined;

async function resolveRepoRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage('Best of N needs an open folder that is inside a git repository.');
    return undefined;
  }

  let candidate: string | undefined;
  if (folders.length === 1) {
    candidate = folders[0].uri.fsPath;
  } else {
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath })),
      { title: 'Best of N: which repository?', ignoreFocusOut: true },
    );
    candidate = picked?.description;
  }
  if (!candidate) {
    return undefined;
  }

  try {
    return await repoRoot(candidate);
  } catch {
    void vscode.window.showErrorMessage(`"${candidate}" is not inside a git repository.`);
    return undefined;
  }
}

async function ensureCli(): Promise<CliInvocation | undefined> {
  const configured = vscode.workspace.getConfiguration('bestOfN').get<string>('cliPath', '');
  try {
    const invocation = resolveCli(configured);
    const version = await cliVersion(invocation);
    log().info(`Using Copilot CLI at ${invocation.display} (${version})`);
    return invocation;
  } catch (err) {
    const message =
      err instanceof CliNotFoundError
        ? err.message
        : `The Copilot CLI could not be started: ${errorMessage(err)}`;
    const choice = await vscode.window.showErrorMessage(message, 'Open settings');
    if (choice === 'Open settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'bestOfN.cliPath');
    }
    return undefined;
  }
}

function pushState(context: vscode.ExtensionContext, run: RunRecord | undefined): void {
  const paths = run && run.status === 'running' ? run.variants.map((v) => v.worktreePath) : [];
  void context.workspaceState.update(ACTIVE_RUN_KEY, paths);
}

async function handleWinner(context: vscode.ExtensionContext, variantId: string): Promise<void> {
  const run = controller?.current;
  const variant = controller?.variant(variantId);
  if (!run || !variant || !controller) {
    return;
  }

  const decision = await confirmWinner(run, variant);
  if (!decision) {
    return;
  }

  controller.setWinner(variantId);
  const deleteLosers = !vscode.workspace.getConfiguration('bestOfN').get<boolean>('keepLoserBranches', true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Best of N' },
    async (progress) => {
      let message = `Kept ${variant.label} on branch ${variant.branch}.`;
      if (decision === 'merge') {
        progress.report({ message: 'Merging the winner...' });
        const outcome = await mergeWinner(run, variant);
        message = outcome.message;
      }
      progress.report({ message: 'Removing worktrees...' });
      await cleanupRun(run, variantId, deleteLosers);
      pushState(context, undefined);
      void vscode.window.showInformationMessage(message);
    },
  );
}

function wireDashboard(context: vscode.ExtensionContext, dashboard: Dashboard): void {
  const subscription = dashboard.onMessage((message: DashboardMessage) => {
    const run = controller?.current;
    void (async () => {
      try {
        switch (message.type) {
          case 'cancel':
            controller?.cancel();
            break;
          case 'chooseWinner':
            await handleWinner(context, message.variantId);
            break;
          case 'openPreview': {
            const variant = controller?.variant(message.variantId);
            if (variant?.preview) {
              const doc = await vscode.workspace.openTextDocument(
                vscode.Uri.file(variant.preview.path),
              );
              await vscode.window.showTextDocument(doc, { preview: true });
            }
            break;
          }
          case 'openDiff': {
            const variant = controller?.variant(message.variantId);
            if (run && variant && diffProvider) {
              await openVariantPatch(diffProvider, run.repoRoot, run.baseRef, variant);
            }
            break;
          }
          case 'openFileDiff': {
            const variant = controller?.variant(message.variantId);
            if (run && variant) {
              await openFileDiff(run.repoRoot, run.baseRef, variant, message.file);
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Best of N: ${errorMessage(err)}`);
      }
    })();
  });
  context.subscriptions.push(subscription);
}

async function runCommand(context: vscode.ExtensionContext): Promise<void> {
  if (controller?.isRunning) {
    void vscode.window.showWarningMessage('A Best of N run is already in progress.');
    return;
  }

  const root = await resolveRepoRoot();
  if (!root) {
    return;
  }

  const plan = await buildRunPlan(root);
  if (!plan) {
    return;
  }

  const result = await startRun(context, plan, root);
  if (!result) {
    return;
  }

  const failures = result.run.variants.filter((v) => v.status === 'failed').length;
  void vscode.window.showInformationMessage(
    `Best of N finished: ${result.run.variants.length - failures}/${result.run.variants.length} variants succeeded.` +
      (failures > 0 ? ' Check the dashboard for errors.' : ''),
  );
}

/**
 * The single run path shared by the palette command and the chat participant: build a
 * controller, mirror its state to the dashboard, and report coarse progress.
 */
async function startRun(
  context: vscode.ExtensionContext,
  plan: RunPlan,
  root: string,
  onProgress?: (message: string) => void,
  externalToken?: vscode.CancellationToken,
): Promise<{ run: RunRecord; ranking: RankedVariant[] } | undefined> {
  // The default engine runs Copilot models inside VS Code; the CLI is opt-in.
  const engine = vscode.workspace.getConfiguration('bestOfN').get<string>('engine', 'lm');
  let invocation: CliInvocation | undefined;
  if (engine === 'cli') {
    invocation = await ensureCli();
    if (!invocation) {
      return undefined;
    }
  }

  const dashboard = vscode.workspace.getConfiguration('bestOfN').get<boolean>('autoOpenDashboard', true)
    ? Dashboard.show(context.extensionUri)
    : Dashboard.instance;
  if (dashboard) {
    wireDashboard(context, dashboard);
  }

  let busy: string | undefined;
  let lastReported = '';
  const publish = (run: RunRecord, ranking: RankedVariant[]) => {
    dashboard?.update({ run, ranking, busy });

    if (!onProgress) {
      return;
    }
    // Chat shows a single progress line, so report only meaningful transitions.
    const finished = run.variants.filter((v) => v.status === 'done' || v.status === 'failed').length;
    const running = run.variants.filter((v) => v.status === 'running').length;
    const message = busy ?? `${finished}/${run.variants.length} finished, ${running} running`;
    if (message !== lastReported) {
      lastReported = message;
      onProgress(message);
    }
  };

  controller = new RunController(invocation, path.join(context.globalStorageUri.fsPath, 'runs'), {
    onChange: publish,
    onBusy: (message) => {
      busy = message;
      if (controller?.current) {
        publish(controller.current, controller.currentRanking);
      }
    },
  });

  const cancelSubscription = externalToken?.onCancellationRequested(() => controller?.cancel());

  try {
    const startPromise = controller.start(plan, root);
    pushState(context, controller.current);
    await startPromise;
    pushState(context, undefined);

    const run = controller.current;
    return run ? { run, ranking: controller.currentRanking } : undefined;
  } catch (err) {
    void vscode.window.showErrorMessage(`Best of N failed: ${errorMessage(err)}`);
    log().error(errorMessage(err));
    return undefined;
  } finally {
    cancelSubscription?.dispose();
  }
}

async function cleanupOrphansCommand(context: vscode.ExtensionContext): Promise<void> {
  const root = await resolveRepoRoot();
  if (!root) {
    return;
  }

  const active = new Set(
    (context.workspaceState.get<string[]>(ACTIVE_RUN_KEY, []) ?? []).map((p) => path.resolve(p)),
  );
  for (const variant of controller?.current?.variants ?? []) {
    active.add(path.resolve(variant.worktreePath));
  }

  const orphans = await findOrphans(root, active);
  if (orphans.length === 0) {
    void vscode.window.showInformationMessage('No leftover Best of N worktrees were found.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    orphans.map((entry) => ({
      label: entry.branch ?? entry.path,
      description: entry.path,
      picked: true,
    })),
    {
      title: 'Best of N: remove leftover worktrees',
      canPickMany: true,
      placeHolder: 'Branches are kept; only the worktree directories are removed.',
    },
  );
  if (!picked || picked.length === 0) {
    return;
  }

  for (const entry of picked) {
    if (entry.description) {
      await removeWorktree(root, entry.description);
    }
  }
  void vscode.window.showInformationMessage(`Removed ${picked.length} worktree(s).`);
}

export function activate(context: vscode.ExtensionContext): void {
  initLog();
  log().info('Best of N activated');

  diffProvider = new DiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, diffProvider),
    vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, diffProvider),
    vscode.commands.registerCommand('bestOfN.run', () => runCommand(context)),
    vscode.commands.registerCommand('bestOfN.showDashboard', () => {
      const dashboard = Dashboard.show(context.extensionUri);
      wireDashboard(context, dashboard);
      if (controller?.current) {
        dashboard.update({ run: controller.current, ranking: controller.currentRanking });
      }
    }),
    vscode.commands.registerCommand('bestOfN.cancelRun', () => {
      if (!controller?.isRunning) {
        void vscode.window.showInformationMessage('No Best of N run is in progress.');
        return;
      }
      controller.cancel();
    }),
    vscode.commands.registerCommand('bestOfN.cleanupOrphans', () => cleanupOrphansCommand(context)),
    vscode.commands.registerCommand('bestOfN.keepVariant', (variantId: string) =>
      handleWinner(context, variantId),
    ),
    vscode.commands.registerCommand('bestOfN.showVariantDiff', async (variantId: string) => {
      const run = controller?.current;
      const variant = controller?.variant(variantId);
      if (run && variant && diffProvider) {
        await openVariantPatch(diffProvider, run.repoRoot, run.baseRef, variant);
      }
    }),
  );

  const chatHost: ChatRunHost = {
    resolveRepoRoot,
    isRunning: () => controller?.isRunning ?? false,
    execute: (plan, repoRoot, onProgress, token) =>
      startRun(context, plan, repoRoot, onProgress, token),
  };

  // Two chat entry points: the `#bestofn` tool for agent mode, which is where VS Code
  // now routes extension capabilities, and the `@bestofn` participant for ask mode.
  context.subscriptions.push(registerChatTool(chatHost));

  try {
    context.subscriptions.push(registerChatParticipant(context, chatHost));
  } catch (err) {
    log().warn(`Chat participant unavailable, use #bestofn instead: ${errorMessage(err)}`);
  }

  // Chat surfaces move between VS Code versions, so keep one entry point that is always
  // visible and cannot be hidden behind a picker.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'bestOfN.run';
  status.text = '$(run-all) Best of N';
  status.tooltip = 'Run one prompt across several Copilot models in parallel';
  status.show();
  context.subscriptions.push(status);
}

export function deactivate(): void {
  controller?.cancel();
  diffProvider?.dispose();
  Dashboard.instance?.dispose();
}
