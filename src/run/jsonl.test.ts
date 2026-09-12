import { describe, expect, it } from 'vitest';
import { interpret, JsonlParser } from './jsonl';

function event(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

describe('JsonlParser', () => {
  it('parses whole lines', () => {
    const parser = new JsonlParser();
    const result = parser.push(event({ type: 'a' }) + event({ type: 'b' }));
    expect(result.events.map((e) => e.type)).toEqual(['a', 'b']);
    expect(result.unparsed).toEqual([]);
  });

  it('reassembles a line split across chunks', () => {
    const parser = new JsonlParser();
    const line = event({ type: 'assistant.message_delta', data: { deltaContent: 'hello' } });
    const midpoint = Math.floor(line.length / 2);

    const first = parser.push(line.slice(0, midpoint));
    expect(first.events).toHaveLength(0);

    const second = parser.push(line.slice(midpoint));
    expect(second.events).toHaveLength(1);
    expect(second.events[0].data?.deltaContent).toBe('hello');
  });

  it('handles CRLF line endings', () => {
    const parser = new JsonlParser();
    const result = parser.push('{"type":"x"}\r\n');
    expect(result.events.map((e) => e.type)).toEqual(['x']);
  });

  it('collects non-JSON output instead of throwing', () => {
    const parser = new JsonlParser();
    const result = parser.push('warning: something happened\n' + event({ type: 'ok' }));
    expect(result.unparsed).toEqual(['warning: something happened']);
    expect(result.events.map((e) => e.type)).toEqual(['ok']);
  });

  it('does not throw on malformed JSON', () => {
    const parser = new JsonlParser();
    const result = parser.push('{"type": broken\n');
    expect(result.events).toHaveLength(0);
    expect(result.unparsed).toHaveLength(1);
  });

  it('flushes a trailing line with no newline', () => {
    const parser = new JsonlParser();
    expect(parser.push('{"type":"tail"}').events).toHaveLength(0);
    expect(parser.flush().events.map((e) => e.type)).toEqual(['tail']);
  });

  it('ignores blank lines', () => {
    const parser = new JsonlParser();
    const result = parser.push('\n\n' + event({ type: 'z' }));
    expect(result.events).toHaveLength(1);
    expect(result.unparsed).toHaveLength(0);
  });
});

describe('interpret', () => {
  it('maps assistant deltas to streaming text', () => {
    expect(
      interpret({ type: 'assistant.message_delta', data: { deltaContent: 'hi' } }),
    ).toEqual([{ kind: 'assistant-delta', text: 'hi' }]);
  });

  it('maps a consolidated message and its model', () => {
    const updates = interpret({
      type: 'assistant.message',
      data: { content: 'done', model: 'claude-haiku-4.5' },
    });
    expect(updates).toContainEqual({ kind: 'assistant-message', text: 'done' });
    expect(updates).toContainEqual({ kind: 'model', model: 'claude-haiku-4.5' });
  });

  it('tracks tool lifecycle with a stable id', () => {
    const start = interpret({
      type: 'tool.execution_start',
      data: { name: 'shell', toolCallId: 'call-1' },
    });
    expect(start).toContainEqual({ kind: 'tool-start', id: 'call-1', name: 'shell' });

    const end = interpret({
      type: 'tool.execution_complete',
      data: { name: 'shell', toolCallId: 'call-1', success: false },
    });
    expect(end).toEqual([{ kind: 'tool-end', id: 'call-1', name: 'shell', ok: false }]);
  });

  it('returns nothing for unknown event types', () => {
    expect(interpret({ type: 'some.future.event', data: { a: 1 } })).toEqual([]);
  });
});
