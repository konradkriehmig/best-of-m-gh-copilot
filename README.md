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

There is also no way in the chat window to fire one prompt and have it run N times across different
models. `#bestofn` is exactly that.

## Requirements

- GitHub Copilot in VS Code, signed in. That is all the default engine needs.
- A workspace folder inside a git repository.
- Git 2.5 or newer (for `git worktree`).
- Only if you switch `bestOfN.engine` to `cli`: the
  [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
  (`npm install -g @github/copilot`, then `copilot` once to sign in).

## Using it

### The status bar button (easiest)

Click **$(run-all) Best of N** in the status bar, bottom right. This is always visible once the
extension is active and does not depend on chat syntax, which moves between VS Code versions.

The same thing is bound to **`Ctrl+Alt+N`** (`Cmd+Alt+N` on macOS).

### From the command palette

The equivalent, if you prefer typing:

`Ctrl+Shift+P` → **Best of N: Run Prompt Across Models**

1. Enter the prompt every variant will attempt.
2. Select the models. Selecting a single model is fine — you will be asked how many sessions to run
   on it, which gives you best-of-N on one model.
3. Choose how many sessions per model, and the base ref to branch from.
4. Confirm. The cost warning shows how many agents are about to start.

The dashboard then shows one card per variant with live status, streamed output, a live step list,
cost, diff size and verification result. When everything has finished, press **Keep this one** on
the winner.

Models differ a lot in how much they narrate. Some stream a running commentary, others say nothing
until the end, so every card also shows the **steps** it is taking — each tool call with its target
and whether it succeeded. That way a quiet model still visibly makes progress.

### Comparing the results

Each finished card shows a preview of what the variant actually produced, under the changed files:

- **HTML** is rendered live in a sandboxed frame, so you can compare the real thing side by side
  instead of reading three descriptions of it. Toggle between **Rendered** and **Source**.
- **Anything else** — Python, TypeScript, Rust and so on — is shown as source.

The file is picked from the variant's changed files: an HTML entry point wins, preferring `index`,
then the shallowest path; otherwise the most interesting source file. **Open file** opens the real
file in an editor.

Rendered previews execute model-written JavaScript. The page is inlined into a self-contained
document and rendered from `srcdoc` in a frame sandboxed with `allow-scripts` **only** — no
`allow-same-origin` — so it has an opaque origin and cannot reach the dashboard, the extension host,
your editor, the network or anything on disk. Local stylesheets and scripts the page references are
inlined for it, because a frame with an opaque origin cannot fetch them; remote URLs are left alone
and are blocked. If you would rather never execute it, set `bestOfN.preview.mode` to `source`, or
`off` to hide previews entirely.

### From the chat window

In **Agent mode**, reference the tool with `#`:

```
#bestofn add retry with exponential backoff to the HTTP client
```

You can also just ask for it ("try this across three models") and the agent will reach for the tool
itself. VS Code shows a confirmation with the cost multiple before anything starts. If the tool is
not offered, check it is ticked in the tools picker above the chat input.

In **Ask mode** the older participant syntax works too:

```
@bestofn add retry with exponential backoff to the HTTP client
```

Which of these the chat input offers varies by VS Code version: `@`-mentions of participants have
been progressively replaced by `#`-referenced tools. The extension contributes both, so whichever
your version supports is available — and the command palette works regardless.

Either way, the first run asks which models to fan out to and how many sessions each; the answer is
saved to `bestOfN.chat.fanOut`, so later prompts run straight away. Change it with
`@bestofn /models`, by naming models in the prompt ("run it on opus and sonnet"), or in settings.

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

"A usable result" means the agent finished *and* actually changed a file. Weaker models sometimes
explore and then stop without editing anything; when that happens the variant is nudged once to
carry the task out, and if it still changes nothing it is marked **failed** with a "changed no
files" message rather than a misleading green **done**.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `bestOfN.engine` | `lm` | `lm` runs inside VS Code on Copilot models; `cli` shells out to the Copilot CLI |
| `bestOfN.chat.fanOut` | `[]` | Models a `#bestofn` / `@bestofn` prompt fans out to, e.g. `["claude-opus-5", "gpt-5.6-sol x2"]` |
| `bestOfN.cliPath` | auto-detect | Path to the `copilot` executable (`cli` engine only) |
| `bestOfN.models` | `[]` | Extra model ids for the picker |
| `bestOfN.maxConcurrent` | `4` | Sessions running at once. If you pick more models than this, the confirmation dialog offers to run them all at once instead of queueing |
| `bestOfN.worktreeRoot` | `<repo>/../.best-of-n` | Where worktrees are created |
| `bestOfN.verifyCommand` | `""` | Command run in each worktree to score it, e.g. `npm test` |
| `bestOfN.verifyTimeoutMs` | `600000` | Timeout for that command |
| `bestOfN.judge.enabled` | `true` | Run one extra call that ranks all diffs |
| `bestOfN.judge.model` | `""` | Model for the judge; empty uses the default |
| `bestOfN.judge.maxDiffBytes` | `60000` | Per-variant diff budget handed to the judge |
| `bestOfN.denyTools` | `["shell(git push)"]` | Passed to `--deny-tool` (`cli` engine only) |
| `bestOfN.disableBuiltinMcps` | `true` | MCP servers start per session (`cli` engine only) |
| `bestOfN.maxAiCredits` | `0` | Per-variant credit cap; 0 leaves it unset (`cli` engine only) |
| `bestOfN.copyIgnoredFiles` | `[".env", ".env.local"]` | Ignored files copied into each worktree |
| `bestOfN.keepLoserBranches` | `true` | Keep branches of variants you did not pick |
| `bestOfN.preview.mode` | `rendered` | Preview under each card: `rendered`, `source`, or `off` |
| `bestOfN.preview.height` | `320` | Height in pixels of the preview area |

## Safety

Read this before your first run.

- **Agents run unsupervised.** On the `lm` engine each variant can read and write files anywhere
  inside its own worktree without asking, but it has **no shell**: the tool set is
  `list_files`, `read_file`, `write_file`, `replace_in_file` and `search_files`, and every path is
  resolved against the worktree root and rejected if it escapes. The `cli` engine is more capable
  and correspondingly less contained — it runs with `--allow-all-tools`, so `bestOfN.denyTools` is
  the main control there, and it blocks `git push` by default.
- **Worktrees are not a security boundary.** They share your filesystem, environment and
  credentials. Isolation here protects your *branch*, not your *machine*.
- **N agents cost roughly N times as much** as a single session. The confirmation dialog and the
  chat reply both say how many are about to start.
- **Rendered previews execute model-written JavaScript.** The frame has an opaque origin and no
  network or disk access, so it cannot reach the dashboard, the extension host or your files. Set
  `bestOfN.preview.mode` to `source` or `off` to opt out.

## Implementation notes

### Two engines

`lm` (default) runs each variant inside VS Code against a GitHub Copilot model through the stable
`vscode.lm` language model API. Nothing is spawned and nothing leaves the editor.

VS Code exposes no public API for starting an *agent-mode* session programmatically, so the agent
loop, the tool set and the system prompt are this extension's own — what comes from Copilot is the
model. That is the trade-off: full in-editor integration, a deliberately small tool set, and no
shell. Variants get no cost figure either, because the language model API does not report one, so
the cost column reads `-` and the cost tie-breaker in the ranking simply does not apply.

`cli` shells out to the GitHub Copilot CLI once per variant, which gives Copilot's real agent
harness with its full tool set, MCP servers and per-variant cost accounting. It needs the CLI
installed and signed in.

### Details

- The internal `workbench.action.chat.open` command can take a model selector, but it is
  undocumented, absent from `vscode.d.ts` and limited to one chat view per window, so it is not used.
- The extension contributes **both** a language model tool (`#bestofn`) and a chat participant
  (`@bestofn`). Agent mode routes extension capabilities through tools, and `@`-mentions of
  participants are not offered there, so the tool is the primary entry point and the participant is
  the ask-mode fallback. Both run the same code path.
- On the `cli` engine the prompt is written to **stdin**, never interpolated into a command line, so
  quotes and shell metacharacters in your prompt cannot be misinterpreted.
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

The extension activates on `onStartupFinished` rather than lazily. Lazy activation is normally
preferable, but a chat tool that is never listed is indistinguishable from a broken extension, so it
registers eagerly. Activation is cheap: it wires up commands and providers and does no I/O.

### Installing a local build

```bash
npm run package
npx @vscode/vsce package --allow-missing-repository
code --uninstall-extension konradkriehmig.best-of-n
code --install-extension best-of-n-<version>.vsix
```

Bump the version first. Reinstalling over the *same* version number leaves VS Code holding the old
build, and a plain **Reload Window** is not always enough — quit VS Code completely, because windows
that were already open keep running the extension host they started with.

`--uninstall-extension` also leaves the old version's folder behind in `~/.vscode/extensions`, so
delete it and check that `extensions.json` lists only the version you want. To confirm the new build
loaded, look for `_doActivateExtension konradkriehmig.best-of-n` in
`%APPDATA%\Code\logs\<session>\window*\exthost\exthost.log`.

### End-to-end smoke test

`npm run smoke` builds a throwaway git repository, runs real agents in real worktrees, and asserts
the whole pipeline: CLI resolution, stdin prompt delivery, JSONL streaming, worktree isolation,
change capture, the judge and cleanup. It exercises the **`cli` engine**, because the language model
API is only available inside the extension host and cannot be driven from a plain Node script. The
`lm` engine's agent loop is covered instead by `src/run/lmAgent.test.ts`, which drives it against a
scripted model.

```bash
npm run smoke                        # 2 sessions on claude-haiku-4.5
npm run smoke -- claude-sonnet-5 3   # 3 sessions on another model
```

It spends AI credits, so it is not part of `npm test`.

## Licence

MIT
