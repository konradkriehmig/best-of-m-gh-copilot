import { CheckResult, JudgeVerdict, RankedVariant, VariantState } from '../util/types';
import { checkPassed } from './checks';

/**
 * Deterministic ranking. Judge opinion matters, but objective signals outrank it:
 * a variant whose tests fail is not the winner no matter how good the prose is.
 *
 * Ordering, highest priority first:
 *   1. produced a usable result at all (succeeded and changed something)
 *   2. verify command passed
 *   3. judge score
 *   4. smaller diff (less collateral change)
 *   5. lower cost
 */
export function rankVariants(
  variants: VariantState[],
  judge: JudgeVerdict | undefined,
): RankedVariant[] {
  const judgeScores = new Map<string, { score: number; reasoning: string }>();
  for (const entry of judge?.ranking ?? []) {
    judgeScores.set(entry.variantId, { score: entry.score, reasoning: entry.reasoning });
  }

  const scored = variants.map((variant) => {
    const reasons: string[] = [];
    let score = 0;

    const usable = variant.status === 'done' && variant.diff !== undefined && !variant.diff.empty;
    if (usable) {
      score += 1000;
    } else if (variant.status !== 'done') {
      reasons.push(`agent ${variant.status}`);
    } else {
      reasons.push('no changes produced');
    }

    const passed = checkPassed(variant.check);
    if (passed === true) {
      score += 500;
      reasons.push('checks passed');
    } else if (passed === false) {
      score -= 500;
      reasons.push(variant.check?.timedOut ? 'checks timed out' : 'checks failed');
    }

    const judged = judgeScores.get(variant.id);
    if (judged) {
      const clamped = Math.max(0, Math.min(10, judged.score));
      score += clamped * 10;
      reasons.push(`judge ${clamped}/10`);
    }

    if (variant.diff && !variant.diff.empty) {
      const churn = variant.diff.insertions + variant.diff.deletions;
      // Small, bounded tie-breaker: never lets diff size outweigh a real signal.
      score += Math.max(-20, -churn / 200);
      reasons.push(`${variant.diff.filesChanged} files, +${variant.diff.insertions}/-${variant.diff.deletions}`);
    }

    const cost = variant.usage?.totalPremiumRequestCost;
    if (typeof cost === 'number' && cost > 0) {
      score += Math.max(-10, -cost);
    }

    return { variant, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function summarizeCheck(check: CheckResult | undefined): string {
  if (!check) {
    return 'not run';
  }
  if (check.timedOut) {
    return 'timed out';
  }
  return check.exitCode === 0 ? 'passed' : `failed (exit ${check.exitCode})`;
}
