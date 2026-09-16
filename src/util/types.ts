export type VariantStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface ToolCallState {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  /** Short summary of what the call targeted, e.g. the file path. */
  detail?: string;
}

export interface UsageReport {
  totalPremiumRequestCost?: number;
  totalApiDurationMs?: number;
  currentModel?: string;
  tokenDetails?: Record<string, { tokenCount?: number }>;
  codeChanges?: {
    linesAdded?: number;
    linesRemoved?: number;
    filesModifiedCount?: number;
    filesModified?: string[];
  };
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
  /** True when the agent produced no commit and no working-tree change. */
  empty: boolean;
}

export interface CheckResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  outputTail: string;
}

export interface JudgeVerdict {
  ranking: Array<{ variantId: string; score: number; reasoning: string }>;
  winner?: string;
  caveats?: string;
  /** Set when the judge could not be run or its output could not be parsed. */
  error?: string;
}

/**
 * What to show under a variant card. HTML is inlined into a self-contained document, since
 * the sandboxed frame it renders in has an opaque origin and can fetch nothing itself.
 */
export interface VariantPreview {
  /** Path relative to the worktree root. */
  file: string;
  kind: 'html' | 'code' | 'image';
  /** Absolute path, used by "Open file". */
  path: string;
  /** Text of the file. Absent for raster images, which have no source to show. */
  code?: string;
  /** Self-contained HTML with local assets inlined, rendered in a sandboxed frame. */
  html?: string;
  /** Assets that could not be resolved, so an unstyled preview can say why. */
  missingAssets?: string[];
  truncated?: boolean;
  language?: string;
}

export interface VariantState {
  id: string;
  label: string;
  model: string;
  /** 1-based ordinal among variants using the same model. */
  replica: number;
  branch: string;
  worktreePath: string;
  sessionId: string;
  status: VariantStatus;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  error?: string;
  activity?: string;
  assistantText: string;
  toolCalls: ToolCallState[];
  usage?: UsageReport;
  diff?: DiffStat;
  check?: CheckResult;
  transcriptPath: string;
  usagePath: string;
  sharePath: string;
  preview?: VariantPreview;
}

export interface RunRecord {
  runId: string;
  prompt: string;
  repoRoot: string;
  baseRef: string;
  baseBranch: string;
  worktreeRoot: string;
  createdAt: number;
  finishedAt?: number;
  variants: VariantState[];
  /** How many variants were allowed to run at the same time. */
  maxConcurrent: number;
  judge?: JudgeVerdict;
  winnerId?: string;
  status: 'running' | 'finished' | 'cancelled';
}

export interface RankedVariant {
  variant: VariantState;
  rank: number;
  score: number;
  reasons: string[];
}
