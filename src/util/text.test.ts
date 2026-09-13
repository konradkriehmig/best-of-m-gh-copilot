import { describe, expect, it } from 'vitest';
import {
  branchName,
  extractJsonObject,
  formatDuration,
  parseFanOut,
  slugify,
  truncate,
  variantLabel,
} from './text';

describe('slugify', () => {
  it('keeps safe model ids intact', () => {
    expect(slugify('claude-opus-5')).toBe('claude-opus-5');
  });

  it('replaces characters git branches reject', () => {
    expect(slugify('vendor/model:v1')).toBe('vendor-model-v1');
    expect(slugify('GPT 5.6 Sol')).toBe('gpt-5.6-sol');
  });

  it('never produces an empty or leading-dash name', () => {
    expect(slugify('///')).toBe('model');
    expect(slugify('-weird-')).toBe('weird');
  });

  it('avoids the .lock suffix git forbids', () => {
    expect(slugify('model.lock').endsWith('.lock')).toBe(false);
  });
});

describe('branchName', () => {
  it('namespaces branches under bon/<runId>', () => {
    expect(branchName('20260912-1200-abc', 'claude-opus-5', 2)).toBe(
      'bon/20260912-1200-abc/claude-opus-5-2',
    );
  });
});

describe('variantLabel', () => {
  it('omits the ordinal for a single replica', () => {
    expect(variantLabel('gpt-5.6', 1, 1)).toBe('gpt-5.6');
  });

  it('adds the ordinal when a model is repeated', () => {
    expect(variantLabel('gpt-5.6', 2, 3)).toBe('gpt-5.6 #2');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });

  it('marks truncated text', () => {
    const result = truncate('x'.repeat(500), 100);
    expect(result.length).toBeLessThan(500);
    expect(result).toContain('[truncated]');
  });
});

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(125000)).toBe('2m 5s');
    expect(formatDuration(-1)).toBe('-');
  });
});

describe('parseFanOut', () => {
  it('defaults to a single replica', () => {
    expect(parseFanOut(['claude-opus-5'])).toEqual([{ model: 'claude-opus-5', count: 1 }]);
  });

  it('parses a trailing multiplier', () => {
    expect(parseFanOut(['claude-opus-5 x3'])).toEqual([{ model: 'claude-opus-5', count: 3 }]);
    expect(parseFanOut(['claude-opus-5*2'])).toEqual([{ model: 'claude-opus-5', count: 2 }]);
  });

  it('parses a leading multiplier', () => {
    expect(parseFanOut(['3x gpt-5.6-sol'])).toEqual([{ model: 'gpt-5.6-sol', count: 3 }]);
  });

  it('merges duplicate models', () => {
    expect(parseFanOut(['a', 'a x2'])).toEqual([{ model: 'a', count: 3 }]);
  });

  it('ignores blanks and invalid counts', () => {
    expect(parseFanOut(['', '   ', 'a x0'])).toEqual([]);
  });

  it('caps a single entry at ten replicas', () => {
    expect(parseFanOut(['a x999'])).toEqual([{ model: 'a', count: 10 }]);
  });

  it('keeps model ids containing dots and dashes intact', () => {
    expect(parseFanOut(['gpt-5.6-sol x2'])).toEqual([{ model: 'gpt-5.6-sol', count: 2 }]);
  });
});

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"winner":"a"}')).toEqual({ winner: 'a' });
  });

  it('parses an object inside a fenced block', () => {
    const text = 'Here is my verdict:\n```json\n{"winner":"b"}\n```\nHope that helps.';
    expect(extractJsonObject(text)).toEqual({ winner: 'b' });
  });

  it('parses an object surrounded by prose', () => {
    expect(extractJsonObject('Sure thing. {"winner":"c"} Done.')).toEqual({ winner: 'c' });
  });

  it('returns undefined when there is no JSON', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
  });

  it('returns undefined for malformed JSON rather than throwing', () => {
    expect(extractJsonObject('{"winner": }')).toBeUndefined();
  });
});
