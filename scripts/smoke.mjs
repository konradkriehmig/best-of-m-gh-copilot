/**
 * End-to-end smoke test for the Best of N pipeline.
 *
 * Drives the real compiled modules against a throwaway git repository with real agent
 * sessions, to verify what unit tests cannot: CLI resolution, stdin prompt delivery,
 * JSONL streaming, worktree isolation, change capture and ranking.
 *
 * This spends AI credits, so run it deliberately:
 *
 *   npx tsc                 # emit to out/
 *   node scripts/smoke.mjs [model] [replicas]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const MODEL = process.argv[2] ?? 'claude-haiku-4.5';
const REPLICAS = Number(process.argv[3] ?? 2);

const { resolveCli, cliVersion } = await import('../out/cli/locate.js');
const { runAll } = await import('../out/run/runner.js');
const { addWorktree, removeWorktree } = await import('../out/git/worktrees.js');
const { commitVariantWork, diffStat, diffText } = await import('../out/git/diff.js');
const { rankVariants } = await import('../out/score/aggregate.js');
const { runJudge } = await import('../out/score/judge.js');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'bon-smoke-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@localhost']);
  git(root, ['config', 'user.name', 'Smoke Test']);
  writeFileSync(path.join(root, 'README.md'), '# smoke\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

function makeVariant(worktreeRoot, index) {
  const id = `${MODEL}-${index}`;
  const safe = id.replace(/[^\w.-]+/g, '-');
  const artifacts = path.join(worktreeRoot, '.artifacts', safe);
  return {
    id,
    label: id,
    model: MODEL,
    replica: index,
    branch: `bon/smoke/${safe}`,
    worktreePath: path.join(worktreeRoot, safe),
    sessionId: randomUUID(),
    status: 'queued',
    queuedAt: Date.now(),
    assistantText: '',
    toolCalls: [],
    transcriptPath: path.join(artifacts, 'transcript.jsonl'),
    usagePath: path.join(artifacts, 'usage.json'),
    sharePath: path.join(artifacts, 'session.md'),
  };
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

const repoRoot = makeRepo();
const worktreeRoot = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`);
console.log(`Repository: ${repoRoot}`);

try {
  const invocation = resolveCli('');
  const version = await cliVersion(invocation);
  console.log(`CLI: ${invocation.display}\n     ${version}\n`);

  const variants = Array.from({ length: REPLICAS }, (_, i) => makeVariant(worktreeRoot, i + 1));

  console.log('Creating worktrees...');
  for (const variant of variants) {
    await addWorktree(repoRoot, variant.worktreePath, variant.branch, 'HEAD');
  }
  check('each worktree exists', variants.every((v) => existsSync(v.worktreePath)));

  console.log(`\nRunning ${variants.length} agents on ${MODEL}...`);
  const started = Date.now();
  await runAll(variants, {
    invocation,
    prompt:
      'Create a file named result.txt in the current directory containing exactly the word BANANA ' +
      'and nothing else. Do not create or modify any other file. Then stop.',
    maxConcurrent: variants.length,
    denyTools: ['shell(git push)'],
    disableBuiltinMcps: true,
    maxAiCredits: 0,
    onUpdate: () => {},
    onLog: (m) => console.log(`    ${String(m).slice(0, 160)}`),
  });
  console.log(`Finished in ${Math.round((Date.now() - started) / 1000)}s\n`);

  console.log('Results:');
  for (const variant of variants) {
    console.log(`  ${variant.label}: status=${variant.status} exit=${variant.exitCode}`);
    if (variant.error) {
      console.log(`    error: ${variant.error}`);
    }

    check(`${variant.label} completed`, variant.status === 'done', variant.error);

    const produced = path.join(variant.worktreePath, 'result.txt');
    check(`${variant.label} created result.txt`, existsSync(produced));
    if (existsSync(produced)) {
      check(
        `${variant.label} wrote the right content`,
        readFileSync(produced, 'utf8').trim() === 'BANANA',
      );
    }

    check(`${variant.label} wrote a transcript`, existsSync(variant.transcriptPath));
    check(`${variant.label} wrote usage stats`, existsSync(variant.usagePath));
    check(
      `${variant.label} reported a cost`,
      typeof variant.usage?.totalPremiumRequestCost === 'number',
    );

    await commitVariantWork(variant.worktreePath, `smoke ${variant.label}`);
    variant.diff = await diffStat(repoRoot, 'HEAD', variant.branch);
    console.log(
      `    diff: ${variant.diff.filesChanged} files +${variant.diff.insertions}/-${variant.diff.deletions}`,
    );
    check(`${variant.label} produced a capturable diff`, !variant.diff.empty);
  }

  // Isolation is the whole point: agents must not touch the main working tree.
  check('main working tree untouched', git(repoRoot, ['status', '--porcelain']).trim() === '');
  check('main working tree has no result.txt', !existsSync(path.join(repoRoot, 'result.txt')));

  console.log('\nJudging...');
  const diffs = new Map();
  for (const variant of variants) {
    diffs.set(variant.id, await diffText(repoRoot, 'HEAD', variant.branch));
  }
  const verdict = await runJudge(variants, {
    invocation,
    model: '',
    prompt: 'Create result.txt containing exactly BANANA.',
    maxDiffBytes: 20000,
    diffs,
    onLog: (m) => console.log(`    ${m}`),
  });
  if (verdict.error) {
    console.log(`    judge error: ${verdict.error}`);
  }
  check('judge returned parseable JSON', !verdict.error, verdict.error);
  check('judge ranked every variant', verdict.ranking.length === variants.length);
  check(
    'judge scores are numeric',
    verdict.ranking.every((r) => typeof r.score === 'number' && Number.isFinite(r.score)),
  );
  check(
    'judge only names real variants',
    verdict.ranking.every((r) => variants.some((v) => v.id === r.variantId)),
  );
  for (const entry of verdict.ranking) {
    console.log(`    ${entry.variantId}: ${entry.score}/10 - ${String(entry.reasoning).slice(0, 90)}`);
  }

  const ranking = rankVariants(variants, verdict);
  console.log('\nRanking:');
  for (const entry of ranking) {
    console.log(
      `  #${entry.rank} ${entry.variant.label} (score ${entry.score.toFixed(1)}) ${entry.reasons.join(' | ')}`,
    );
  }
  check('ranking covers every variant', ranking.length === variants.length);
  check('ranks are sequential', ranking.every((e, i) => e.rank === i + 1));

  console.log('\nCleaning up worktrees...');
  for (const variant of variants) {
    await removeWorktree(repoRoot, variant.worktreePath);
  }
  check('worktrees removed', variants.every((v) => !existsSync(v.worktreePath)));
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED (${failures} checks)`);
process.exit(failures === 0 ? 0 : 1);
