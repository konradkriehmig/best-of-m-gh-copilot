# Changelog

## 0.12.0

- Image results are previewed. A run that produces an SVG, PNG, JPEG, GIF, WebP or AVIF now draws it
  under the card, on a checkerboard so a transparent background is visible. Previously `.svg` was in
  neither the renderable nor the source list, so a run whose whole output was a logo showed no
  preview at all.
- An SVG that references a bitmap has that bitmap inlined first. Asked to clean up an `image.png`,
  models routinely answer with an SVG that *points at* it — a reasonable answer that draws as an
  empty box anywhere the file cannot be fetched, including the preview frame.
- Images are picked over source, vector before bitmap, and still lose to an HTML entry point.
- Image previews cannot execute anything: the file is base64'd into an `<img>`, which renders SVG in
  secure static mode, and the frame is given an empty `sandbox`. A bitmap therefore keeps rendering
  when `bestOfM.preview.mode` is `source`, since it has nothing to execute and no source to show.

## 0.11.0

- Renamed to **Best of M**. Command ids, settings (`bestOfM.*`), the chat tool (`#bestofm`) and the
  keybinding (**`Ctrl+Alt+M`**) all moved with it. The `bon/` branch prefix deliberately did not, so
  worktrees created before the rename are still found by orphan cleanup.
- The judge's verdict now renders at the bottom of each card, under the preview and the buttons,
  instead of pushing the result being judged further down.

## 0.10.0

- Previews resolve a page's stylesheets and scripts in the worktree first, then at the same position
  relative to the repository. A worktree does not sit where the repo sits, so pages that correctly
  linked something like `../shared/common.css` previously rendered unstyled — white wireframes on a
  background that never loaded.
- Anything still unresolved is named under the preview, rather than leaving a blank white box.

## 0.9.0

- Every variant now starts at once. `bestOfM.maxConcurrent` defaults to `0`, and a positive value is
  an opt-in cap.
- Removed the confirmation dialog; the cost multiple moved to the dashboard header, where it stays
  visible for the whole run.
- Each card has an **×** that stops that one agent and leaves the rest running. A stopped agent is
  reported **cancelled**, not done, so its partial work cannot be committed, ranked or merged.

## 0.8.0

- Rendered previews actually render. Pages are inlined into a self-contained document and shown in a
  frame sandboxed with `allow-scripts` only.
- Removed the Transcript and Terminal buttons from the cards.

## 0.7.0

- Cards show a live step list of tool calls, so models that do not narrate still visibly progress.
- A queued card says it is waiting for a slot and names the setting responsible.

## 0.6.0

- Cards preview what the variant actually produced: HTML rendered, everything else as source.

## 0.5.0

- A variant that finishes without changing any file is marked **failed**, not done.

## 0.4.0

- `#bestofm` language model tool for agent mode, alongside the `@bestofm` participant.
- Status bar button and a keybinding, since chat entry points move between VS Code versions.

## 0.3.0

- Rebuilt on the stable `vscode.lm` API so runs happen inside VS Code on GitHub Copilot models. The
  Copilot CLI engine remains available behind `bestOfM.engine: "cli"`.

## 0.1.0

- First version: one prompt, N Copilot CLI sessions, one git worktree each, then judge and rank.
