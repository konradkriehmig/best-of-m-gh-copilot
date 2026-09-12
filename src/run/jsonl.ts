/**
 * Incremental parser for the Copilot CLI's `--output-format json` stream.
 *
 * The CLI emits JSON Lines on stdout: one object per line with `type`, `data`, `id`,
 * `timestamp` and an `ephemeral` flag. Events with `ephemeral: false` form the durable
 * transcript; the `*_delta` events exist to drive live UI.
 *
 * This format is not a contracted API, so the parser never throws on unknown event
 * types or on non-JSON output (the CLI can also print plain diagnostics).
 */

export interface CliEvent {
  type: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  parentId?: string;
  ephemeral?: boolean;
}

export interface ParseResult {
  events: CliEvent[];
  /** Lines that were not valid JSON, surfaced for logging rather than discarded. */
  unparsed: string[];
}

export class JsonlParser {
  private buffer = '';

  /** Feed a chunk of stdout. Handles chunk boundaries splitting a line in half. */
  push(chunk: string): ParseResult {
    this.buffer += chunk;
    const events: CliEvent[] = [];
    const unparsed: string[] = [];

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.consumeLine(line, events, unparsed);
      newlineIndex = this.buffer.indexOf('\n');
    }

    return { events, unparsed };
  }

  /** Flush whatever is left when the process exits without a trailing newline. */
  flush(): ParseResult {
    const events: CliEvent[] = [];
    const unparsed: string[] = [];
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer, events, unparsed);
      this.buffer = '';
    }
    return { events, unparsed };
  }

  private consumeLine(rawLine: string, events: CliEvent[], unparsed: string[]): void {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0) {
      return;
    }
    if (!line.startsWith('{')) {
      unparsed.push(line);
      return;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as CliEvent).type === 'string') {
        events.push(parsed as CliEvent);
      } else {
        unparsed.push(line);
      }
    } catch {
      unparsed.push(line);
    }
  }
}

function str(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A small, stable projection of the event stream, so the rest of the extension does not
 * depend on the CLI's exact event vocabulary.
 */
export type StreamUpdate =
  | { kind: 'assistant-delta'; text: string }
  | { kind: 'assistant-message'; text: string }
  | { kind: 'activity'; text: string }
  | { kind: 'tool-start'; id: string; name: string }
  | { kind: 'tool-end'; id: string; name: string; ok: boolean }
  | { kind: 'model'; model: string };

export function interpret(event: CliEvent): StreamUpdate[] {
  const data = event.data;
  switch (event.type) {
    case 'assistant.message_delta': {
      const text = str(data, 'deltaContent');
      return text ? [{ kind: 'assistant-delta', text }] : [];
    }
    case 'assistant.message': {
      const text = str(data, 'content');
      const updates: StreamUpdate[] = [];
      if (text) {
        updates.push({ kind: 'assistant-message', text });
      }
      const model = str(data, 'model');
      if (model) {
        updates.push({ kind: 'model', model });
      }
      return updates;
    }
    case 'assistant.reasoning_delta':
      return [{ kind: 'activity', text: 'thinking' }];
    case 'model.call_start': {
      const model = str(data, 'model');
      return model
        ? [{ kind: 'activity', text: 'calling model' }, { kind: 'model', model }]
        : [{ kind: 'activity', text: 'calling model' }];
    }
    case 'session.tools_updated': {
      const model = str(data, 'model');
      return model ? [{ kind: 'model', model }] : [];
    }
    case 'tool.execution_start':
    case 'tool.start': {
      const name = str(data, 'name') ?? str(data, 'toolName') ?? 'tool';
      const id = str(data, 'toolCallId') ?? str(data, 'callId') ?? event.id ?? name;
      return [
        { kind: 'tool-start', id, name },
        { kind: 'activity', text: name },
      ];
    }
    case 'tool.execution_complete':
    case 'tool.complete': {
      const name = str(data, 'name') ?? str(data, 'toolName') ?? 'tool';
      const id = str(data, 'toolCallId') ?? str(data, 'callId') ?? event.id ?? name;
      const success = data?.['success'];
      return [{ kind: 'tool-end', id, name, ok: success !== false }];
    }
    default:
      return [];
  }
}
