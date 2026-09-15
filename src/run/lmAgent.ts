import * as vscode from 'vscode';
import { invokeTool, TOOL_SCHEMAS, ToolContext } from './tools';
import { VariantState } from '../util/types';

/**
 * An agent loop built on the stable `vscode.lm` API, so variants run inside VS Code on
 * GitHub Copilot models with no CLI and no third-party service.
 *
 * This is deliberately not Copilot's own agent-mode harness. VS Code exposes no public
 * API to start an agent-mode session programmatically, so the loop, the tool set and the
 * system prompt are ours. What comes from Copilot is the model.
 */

const MAX_ITERATIONS = 24;

export interface LmAgentOptions {
  prompt: string;
  worktreePath: string;
  token: vscode.CancellationToken;
  onUpdate: () => void;
}

function systemPreamble(worktreePath: string): string {
  return [
    'You are an autonomous coding agent working on a software task.',
    '',
    `You are working in an isolated checkout of a git repository at: ${worktreePath}`,
    'It is your own private copy. Other agents are solving the same task in their own copies,',
    'and the results will be compared, so solve the task as well as you can.',
    '',
    'Rules:',
    '- Use the tools to explore before you change anything. Never guess a file path.',
    '- Always read a file before editing it, and match existing style and conventions.',
    '- Make the smallest change that fully solves the task. Do not refactor unrelated code.',
    '- All paths are relative to the project root. You cannot access anything outside it.',
    '- Do not create summary, notes or planning files unless the task asks for them.',
    '- Reading and searching alone never completes a task. You must call write_file or',
    '  replace_in_file to actually change the project, otherwise you have done nothing.',
    '- When the task is complete, reply with a short summary of what you changed and stop calling tools.',
  ].join('\n');
}

/**
 * Sent when a model stops calling tools without having written anything. Weaker models
 * often narrate a plan, or simply return an empty turn, and then stop; a single explicit
 * nudge is usually enough to get them to carry it out.
 */
const NUDGE = [
  'You have not changed any files yet, so the task is not done.',
  'If the task still requires work, carry it out now using write_file or replace_in_file.',
  'If you are certain no change is required, reply explaining why, and make no tool calls.',
].join(' ');

/** Coerce a tool call's input, which arrives as an unknown object from the model. */
function toolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

export async function runLmAgent(
  variant: VariantState,
  model: vscode.LanguageModelChat,
  options: LmAgentOptions,
): Promise<void> {
  const ctx: ToolContext = { root: options.worktreePath, touched: new Set() };
  const tools = TOOL_SCHEMAS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      `${systemPreamble(options.worktreePath)}\n\n## Task\n\n${options.prompt}`,
    ),
  ];

  variant.assistantText = '';
  let nudged = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (options.token.isCancellationRequested) {
      variant.status = 'cancelled';
      return;
    }

    variant.activity = iteration === 0 ? 'thinking' : `thinking (step ${iteration + 1})`;
    options.onUpdate();

    const response = await model.sendRequest(
      messages,
      {
        tools,
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        justification: 'Best of N runs this prompt across several models to compare the results.',
      },
      options.token,
    );

    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    let turnText = '';

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        turnText += part.value;
        // Show the newest prose, so the card reflects the current step.
        variant.assistantText = turnText;
        assistantParts.push(part);
        options.onUpdate();
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        assistantParts.push(part);
      }
    }

    if (toolCalls.length === 0) {
      // The model stopped asking for tools. That only means "finished" if it actually
      // changed something; otherwise nudge it once, then report the no-op honestly
      // rather than letting an empty run be marked done.
      if (turnText.trim().length > 0) {
        variant.assistantText = turnText;
      }

      if (ctx.touched.size > 0) {
        variant.activity = undefined;
        return;
      }

      if (!nudged) {
        nudged = true;
        // An empty assistant turn is not always a valid message to send back, so only
        // replay it when the model actually produced something.
        if (assistantParts.length > 0) {
          messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
        }
        messages.push(vscode.LanguageModelChatMessage.User(NUDGE));
        continue;
      }

      variant.activity = undefined;
      variant.error =
        turnText.trim().length > 0
          ? 'The model stopped without changing any files.'
          : 'The model returned nothing and changed no files.';
      return;
    }

    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const call of toolCalls) {
      if (options.token.isCancellationRequested) {
        variant.status = 'cancelled';
        return;
      }

      variant.toolCalls.push({ id: call.callId, name: call.name, status: 'running' });
      variant.activity = call.name;
      options.onUpdate();

      const output = await invokeTool(ctx, call.name, toolInput(call.input));

      const record = variant.toolCalls.find((t) => t.id === call.callId);
      if (record) {
        // The tools report failure as prose rather than throwing, so classify by prefix.
        record.status = /^(No such|Could not|Unknown tool|The tool failed|Path ")/.test(output)
          ? 'error'
          : 'done';
      }
      options.onUpdate();

      resultParts.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(output),
        ]),
      );
    }

    messages.push(vscode.LanguageModelChatMessage.User(resultParts));
  }

  variant.activity = undefined;
  variant.error = `Stopped after ${MAX_ITERATIONS} steps without finishing.`;
}

/**
 * Resolve a model id to a Copilot chat model. Selection is by id, and a clear error is
 * raised when the id is not available to this user.
 */
export async function selectModel(modelId: string): Promise<vscode.LanguageModelChat> {
  const exact = await vscode.lm.selectChatModels({ vendor: 'copilot', id: modelId });
  if (exact.length > 0) {
    return exact[0];
  }

  const family = await vscode.lm.selectChatModels({ vendor: 'copilot', family: modelId });
  if (family.length > 0) {
    return family[0];
  }

  const available = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  const names = available.map((m) => m.id).join(', ');
  throw new Error(
    `The model "${modelId}" is not available to you in VS Code.` +
      (names.length > 0 ? ` Available: ${names}` : ' No Copilot models were returned.'),
  );
}
