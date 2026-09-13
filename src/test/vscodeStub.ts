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
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, fallback: T) => fallback,
    update: async () => undefined,
  }),
};

export const window = {
  createOutputChannel: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined,
  }),
};
