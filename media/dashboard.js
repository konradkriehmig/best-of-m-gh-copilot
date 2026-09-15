(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  /** Per-variant choice of rendered output vs source, remembered across re-renders. */
  const showSource = {};

  /** All model- and agent-produced text goes through textContent, never innerHTML. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function button(label, onClick, primary, disabled) {
    const b = el('button', primary ? 'primary' : undefined, label);
    b.disabled = Boolean(disabled);
    b.addEventListener('click', onClick);
    return b;
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
      return '-';
    }
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? m + 'm ' + s + 's' : s + 's';
  }

  function elapsed(variant) {
    if (!variant.startedAt) {
      return '-';
    }
    return formatDuration((variant.endedAt || Date.now()) - variant.startedAt);
  }

  function statsFor(variant) {
    const stats = el('div', 'stats');
    stats.appendChild(el('span', undefined, 'time ' + elapsed(variant)));

    if (variant.diff) {
      stats.appendChild(
        el('span', undefined, variant.diff.filesChanged + ' files  +' + variant.diff.insertions + '/-' + variant.diff.deletions),
      );
    }
    if (variant.usage && typeof variant.usage.totalPremiumRequestCost === 'number') {
      stats.appendChild(el('span', undefined, 'cost ' + variant.usage.totalPremiumRequestCost.toFixed(2)));
    }
    if (variant.check) {
      const verdict = variant.check.timedOut
        ? 'checks timed out'
        : variant.check.exitCode === 0
          ? 'checks passed'
          : 'checks failed (' + variant.check.exitCode + ')';
      stats.appendChild(el('span', undefined, verdict));
    }
    const running = (variant.toolCalls || []).filter(function (t) { return t.status === 'running'; }).length;
    if ((variant.toolCalls || []).length > 0) {
      stats.appendChild(el('span', undefined, variant.toolCalls.length + ' tool calls' + (running ? ' (' + running + ' active)' : '')));
    }
    return stats;
  }

  function filesFor(variant) {
    if (!variant.diff || !variant.diff.files || variant.diff.files.length === 0) {
      return null;
    }
    const wrapper = el('div', 'files');
    wrapper.appendChild(el('div', undefined, 'Changed files (click to diff):'));
    const list = el('ul');
    variant.diff.files.slice(0, 40).forEach(function (file) {
      const item = el('li', undefined, file);
      item.addEventListener('click', function () {
        post({ type: 'openFileDiff', variantId: variant.id, file: file });
      });
      list.appendChild(item);
    });
    wrapper.appendChild(list);
    return wrapper;
  }

  function previewFor(variant, state) {
    const preview = variant.preview;
    const settings = state.preview || { mode: 'rendered', height: 320 };
    if (!preview || settings.mode === 'off') {
      return null;
    }

    const wrapper = el('div', 'preview');

    const bar = el('div', 'preview-bar');
    bar.appendChild(el('span', 'preview-file', preview.file));

    // Enforced here as well as in the extension: source mode must never execute
    // generated HTML, whatever the payload happens to contain.
    const isHtml =
      preview.kind === 'html' && Boolean(preview.uri) && settings.mode === 'rendered';
    // Rendered output is the point of the comparison, so it is the default when we have it.
    const key = variant.id;
    if (showSource[key] === undefined) {
      showSource[key] = !isHtml;
    }

    if (isHtml) {
      const toggle = el('div', 'preview-toggle');
      toggle.appendChild(button('Rendered', function () {
        showSource[key] = false;
        render(state);
      }, !showSource[key]));
      toggle.appendChild(button('Source', function () {
        showSource[key] = true;
        render(state);
      }, showSource[key]));
      bar.appendChild(toggle);
    }

    const open = button('Open file', function () {
      post({ type: 'openPreview', variantId: variant.id });
    });
    open.className = 'link';
    bar.appendChild(open);
    wrapper.appendChild(bar);

    if (isHtml && !showSource[key]) {
      const frame = document.createElement('iframe');
      frame.className = 'preview-frame';
      frame.style.height = settings.height + 'px';
      // No allow-same-origin: generated pages stay in an opaque origin and cannot reach
      // the dashboard, the extension host, or each other.
      frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
      frame.setAttribute('loading', 'lazy');
      frame.src = preview.uri;
      wrapper.appendChild(frame);
    } else if (preview.code) {
      const code = el('pre', 'preview-code', preview.code);
      code.style.maxHeight = settings.height + 'px';
      wrapper.appendChild(code);
      if (preview.truncated) {
        wrapper.appendChild(el('div', 'preview-note', 'Truncated. Use "Open file" for the rest.'));
      }
    } else {
      wrapper.appendChild(el('div', 'preview-note', 'Nothing to preview.'));
    }

    return wrapper;
  }

  function card(variant, ranked, state) {
    const isWinner = state.run && state.run.winnerId === variant.id;
    const node = el('div', 'card' + (isWinner ? ' winner' : ''));

    const head = el('div', 'card-head');
    const title = el('div');
    title.appendChild(el('span', 'model', variant.label));
    if (ranked) {
      title.appendChild(el('div', 'rank', 'rank #' + ranked.rank));
    }
    head.appendChild(title);
    head.appendChild(el('span', 'status ' + variant.status, isWinner ? 'winner' : variant.status));
    node.appendChild(head);

    node.appendChild(statsFor(variant));

    if (variant.status === 'running' || variant.status === 'verifying') {
      node.appendChild(el('div', 'activity', variant.activity ? '> ' + variant.activity : '> working'));
    }

    if (variant.error) {
      node.appendChild(el('div', 'error', variant.error));
    }

    if (variant.assistantText) {
      const text = variant.assistantText.length > 4000
        ? variant.assistantText.slice(variant.assistantText.length - 4000)
        : variant.assistantText;
      node.appendChild(el('pre', 'stream', text));
    }

    if (ranked && ranked.reasons && ranked.reasons.length > 0) {
      node.appendChild(el('div', 'reasons', ranked.reasons.join(' | ')));
    }

    if (state.run && state.run.judge && state.run.judge.ranking) {
      const verdict = state.run.judge.ranking.filter(function (r) { return r.variantId === variant.id; })[0];
      if (verdict && verdict.reasoning) {
        node.appendChild(el('div', 'judge', 'Judge ' + verdict.score + '/10: ' + verdict.reasoning));
      }
    }

    const files = filesFor(variant);
    if (files) {
      node.appendChild(files);
    }

    const preview = previewFor(variant, state);
    if (preview) {
      node.appendChild(preview);
    }

    const actions = el('div', 'actions');
    const finished = variant.status === 'done';
    const hasDiff = Boolean(variant.diff && !variant.diff.empty);
    const busy = Boolean(state.busy);

    actions.appendChild(button('Diff vs base', function () {
      post({ type: 'openDiff', variantId: variant.id });
    }, false, !hasDiff || busy));

    actions.appendChild(button('Keep this one', function () {
      post({ type: 'chooseWinner', variantId: variant.id });
    }, true, !finished || !hasDiff || busy));

    actions.appendChild(button('Terminal', function () {
      post({ type: 'openTerminal', variantId: variant.id });
    }, false, busy));

    actions.appendChild(button('Transcript', function () {
      post({ type: 'openTranscript', variantId: variant.id });
    }, false, busy));

    node.appendChild(actions);
    return node;
  }

  function render(state) {
    root.textContent = '';

    if (!state.run) {
      root.appendChild(el('p', 'empty', 'No run yet. Use "Best of N: Run Prompt Across Models".'));
      return;
    }

    const run = state.run;
    const header = el('div', 'header');
    const left = el('div');
    left.appendChild(el('h1', undefined, 'Best of N - ' + run.variants.length + ' variants'));
    left.appendChild(el('p', 'prompt', run.prompt));
    left.appendChild(el('div', 'meta', 'base ' + run.baseRef + '  |  run ' + run.runId + '  |  ' + run.status));
    header.appendChild(left);

    if (run.status === 'running') {
      header.appendChild(button('Cancel run', function () { post({ type: 'cancel' }); }, false, Boolean(state.busy)));
    }
    root.appendChild(header);

    if (state.busy) {
      root.appendChild(el('div', 'banner', state.busy));
    }

    if (run.judge && run.judge.error) {
      root.appendChild(el('div', 'banner', 'Judge unavailable: ' + run.judge.error));
    }
    if (run.judge && run.judge.caveats) {
      root.appendChild(el('div', 'banner', 'Judge caveats: ' + run.judge.caveats));
    }

    const rankedById = {};
    (state.ranking || []).forEach(function (entry) {
      rankedById[entry.variant.id] = entry;
    });

    const ordered = (state.ranking && state.ranking.length > 0)
      ? state.ranking.map(function (r) { return r.variant; })
      : run.variants;

    const grid = el('div', 'grid');
    ordered.forEach(function (variant) {
      grid.appendChild(card(variant, rankedById[variant.id], state));
    });
    root.appendChild(grid);
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'state') {
      render(message.state);
    }
  });

  post({ type: 'ready' });
})();
