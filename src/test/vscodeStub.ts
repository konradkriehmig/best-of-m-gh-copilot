/**
 * Minimal stand-in for the `vscode` module so the agent loop can be unit tested outside
 * the extension host. Only the surface `lmAgent`/`lmRunner` actually touch is modelled.
 */

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: unknown,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: unknown[],
  ) {}
}

export class LanguageModelToolResult {
  constructor(public readonly content: unknown[]) {}
}

export class MarkdownString {
  constructor(public readonly value: string = '') {}
}

export class LanguageModelError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export const LanguageModelChatMessage = {
  User: (content: unknown) => ({ role: 'user' as const, content }),
  Assistant: (content: unknown) => ({ role: 'assistant' as const, content }),
};

export const LanguageModelChatToolMode = { Auto: 1, Required: 2 } as const;

export const lm = {
  selectChatModels: async () => [] as unknown[],
  registerTool: () => ({ dispose: () => undefined }),
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, fallback: T) => fallback,
    update: async () => undefined,
  }),
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export const window = {
  createOutputChannel: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined,
  }),
  // Tests that reach a picker are asserting the "user cancelled" path.
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  createStatusBarItem: () => ({
    command: undefined as string | undefined,
    text: '',
    tooltip: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
};

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
