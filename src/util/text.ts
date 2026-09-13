/**
 * Pure helpers shared across modules. Must not import `vscode` so they stay unit-testable.
 */

/** Turn a model id into something safe for a git branch and a directory name. */
export function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .replace(/-{2,}/g, '-')
    .replace(/\.lock$/, 'lock');
  return cleaned.length > 0 ? cleaned : 'model';
}

export function variantLabel(model: string, replica: number, totalReplicas: number): string {
  return totalReplicas > 1 ? `${model} #${replica}` : model;
}

export function branchName(runId: string, model: string, replica: number): string {
  return `bon/${runId}/${slugify(model)}-${replica}`;
}

export function shortRunId(now = new Date(), random = Math.random()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.floor(random * 46656)
    .toString(36)
    .padStart(3, '0');
  return `${stamp}-${suffix}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '-';
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  const buf = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  return `${buf.toString('utf8')}\n... [truncated]`;
}

export function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `...${value.slice(value.length - maxChars)}`;
}

/**
 * Parse a fan-out specification into models and replica counts.
 *
 * Accepts `model`, `model x3`, `model*3` and `3x model`, so a chat user can write a
 * fan-out set compactly in settings without a nested object schema.
 */
export function parseFanOut(entries: string[]): Array<{ model: string; count: number }> {
  const merged = new Map<string, number>();

  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) {
      continue;
    }

    let model = entry;
    let count = 1;

    const trailing = /^(.*?)\s*[x*]\s*(\d+)$/i.exec(entry);
    const leading = /^(\d+)\s*[x*]\s*(.+)$/i.exec(entry);

    if (trailing) {
      model = trailing[1].trim();
      count = Number.parseInt(trailing[2], 10);
    } else if (leading) {
      count = Number.parseInt(leading[1], 10);
      model = leading[2].trim();
    }

    if (model.length === 0 || !Number.isFinite(count) || count < 1) {
      continue;
    }
    merged.set(model, (merged.get(model) ?? 0) + Math.min(count, 10));
  }

  return [...merged.entries()].map(([model, count]) => ({ model, count }));
}

/**
 * Extract a JSON object from model prose, which often wraps JSON in fences or
 * surrounds it with commentary.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    candidates.push(match[1]);
  }
  candidates.push(text);

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      continue;
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
