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
