# Best of N

Run one prompt across **N parallel Copilot sessions**, each in its own git worktree and each on the
model you choose, then compare the results and keep the best one.

This is *best-of-N sampling* applied to coding agents: spend more credits to buy a better outcome on
a task where any single model's first answer is a coin flip.

## How it differs from what already exists

VS Code can already run several agent sessions in parallel and isolate each one in a new worktree,
and several extensions orchestrate agents across worktrees. They all do **task decomposition** —
different prompts doing different work at the same time.

Best of N does the opposite: **the same prompt, N times, in parallel**, then scores the attempts
against each other. The worktree plumbing is the cheap part; the point of this extension is the
comparison and the pick.

## Requirements

- The [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli):
  `npm install -g @github/copilot`, then `copilot` once to sign in.
- A workspace folder inside a git repository.
- Git 2.5 or newer (for `git worktree`).

## Using it

1. Run **Best of N: Run Prompt Across Models** from the command palette.
2. Enter the prompt every variant will attempt.
3. Select the models. Selecting a single model is fine — you will be asked how many sessions to run
   on it, which gives you best-of-N on one model.
4. Choose how many sessions per model, and the base ref to branch from.
5. Confirm. The cost warning shows how many agents are about to start.

The dashboard then shows one card per variant with live status, streamed output, cost, diff size and
verification result. When everything has finished, press **Keep this one** on the winner.

### What happens to your repository

- Each variant gets a branch `bon/<runId>/<model>-<n>` and a worktree under `<repo>/../.best-of-n/`.
- Your main working tree is never touched while agents run.
- Uncommitted agent work is committed automatically inside the variant's own worktree, so every
  attempt is capturable as a single diff.
- Picking a winner optionally merges its branch into the branch you started from and removes all the
  worktrees. Losing branches are kept by default, so nothing is lost.
- Merge conflicts are never auto-resolved: the merge is aborted and you are asked to do it yourself.

## Ranking

Variants are ordered by objective signals first, with the model judge as a tie-breaker:

1. Did it produce a usable result at all?
2. Did `bestOfN.verifyCommand` pass?
3. What did the judge score it?
4. Smaller diffs win over larger ones.
5. Cheaper runs win over more expensive ones.

A variant whose tests fail never outranks one whose tests pass, no matter what the judge says. The
ranking is a suggestion; you always choose the winner yourself.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `bestOfN.cliPath` | auto-detect | Path to the `copilot` executable |
| `bestOfN.models` | `[]` | Extra model ids for the picker |
| `bestOfN.maxConcurrent` | `4` | Sessions running at once; the rest queue |
| `bestOfN.worktreeRoot` | `<repo>/../.best-of-n` | Where worktrees are created |
| `bestOfN.verifyCommand` | `""` | Command run in each worktree to score it, e.g. `npm test` |
| `bestOfN.verifyTimeoutMs` | `600000` | Timeout for that command |
| `bestOfN.judge.enabled` | `true` | Run one extra call that ranks all diffs |
| `bestOfN.judge.model` | `""` | Model for the judge; empty uses the CLI default |
| `bestOfN.judge.maxDiffBytes` | `60000` | Per-variant diff budget handed to the judge |
| `bestOfN.denyTools` | `["shell(git push)"]` | Passed to `--deny-tool` |
| `bestOfN.disableBuiltinMcps` | `true` | MCP servers start per session; N variants pay N times |
| `bestOfN.maxAiCredits` | `0` | Per-variant credit cap; 0 leaves it unset |
| `bestOfN.copyIgnoredFiles` | `[".env", ".env.local"]` | Ignored files copied into each worktree |
| `bestOfN.keepLoserBranches` | `true` | Keep branches of variants you did not pick |

## Safety

Read this before your first run.

- **Agents run unsupervised.** Non-interactive mode requires `--allow-all-tools`, so every variant
  can edit files and run shell commands without asking. `bestOfN.denyTools` is the main control, and
  it blocks `git push` by default.
- **Worktrees are not a security boundary.** They share your filesystem, environment and
  credentials. Isolation here protects your *branch*, not your *machine*.
- **N agents cost roughly N times as much** as a single session. The confirmation dialog says how
  many are about to start, and `bestOfN.maxAiCredits` caps each one.

## Implementation notes

- Variants are driven by the Copilot CLI rather than VS Code's chat UI. The internal
  `workbench.action.chat.open` command can take a model selector, but it is undocumented, absent from
  `vscode.d.ts` and limited to one chat view per window.
- The prompt is written to the CLI's **stdin**, never interpolated into a command line, so quotes and
  shell metacharacters in your prompt cannot be misinterpreted.
- On Windows the npm `copilot.cmd` shim cannot be spawned directly by Node and spawning it through a
  shell would concatenate arguments unescaped, so the shim is resolved to the JavaScript entry point
  it wraps and run with the current Node binary.
- The CLI's `--output-format json` stream is parsed incrementally and defensively: it is not a
  contracted API, so unknown event types and non-JSON output are logged rather than thrown.

## Development

```bash
npm install
npm run build      # bundle to dist/
npm run watch      # rebuild on change
npm test           # unit tests
npm run typecheck  # tsc --noEmit
npm run lint
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

### End-to-end smoke test

`npm run smoke` builds a throwaway git repository, runs real agents in real worktrees, and asserts
the whole pipeline: CLI resolution, stdin prompt delivery, JSONL streaming, worktree isolation,
change capture, the judge and cleanup.

```bash
npm run smoke                        # 2 sessions on claude-haiku-4.5
npm run smoke -- claude-sonnet-5 3   # 3 sessions on another model
```

It spends AI credits, so it is not part of `npm test`.

## Licence

MIT
