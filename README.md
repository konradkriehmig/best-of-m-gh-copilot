Run multiple gh copilots, choose best result

## 1 Run different models simultaneously
<img width="2495" height="1603" alt="ran 10 different models" src="https://github.com/user-attachments/assets/f741c7d3-ad6f-4637-b381-c1695a02ec7c" />

## 2 Run same model multiple times
<img width="2495" height="1609" alt="ran claude opus 10 times" src="https://github.com/user-attachments/assets/75c5caa6-cb1b-4e18-a80e-80b81d18bd3e" />

## Running it

Needs GitHub Copilot in VS Code and a workspace inside a git repository. Nothing else — the default
engine runs on Copilot models through VS Code's own language model API.

Press **`Ctrl+Alt+M`**, or click **Best of M** in the status bar, or use `#bestofm` in agent mode.
Pick the prompt, the models and how many sessions each. Every variant runs at once in its own git
worktree on its own branch; your working tree is never touched. When they finish, compare the cards
and press **Keep this one** on the winner.

Losing branches are kept, so nothing is thrown away.

## Worth knowing before the first run

- **M agents cost roughly M times as much** as one session. Nothing asks you to confirm, so the
  number of variants you pick is the number that starts.
- **Agents run unsupervised** inside their own worktree. They have no shell, and every file path is
  rejected if it escapes that worktree — but a worktree is not a security boundary, it protects your
  branch rather than your machine.
- **Rendered previews execute model-written JavaScript** in a sandboxed frame with an opaque origin
  and no network or disk access. Set `bestOfM.preview.mode` to `source` or `off` to opt out.

[Full documentation](docs/reference.md) — settings, ranking, the two engines and the design notes.
