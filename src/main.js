import { JuliaEngine } from './engine.js';
import { DEMOS } from './demos.js';
import { MODEL_BASE_URL, EXPECTED_SIZES } from './config.js';

const $ = (id) => document.getElementById(id);

const els = {
  webgpuDetect: $('webgpu-detect'),
  engineChip: $('engine-chip'),
  loaderCard: $('loader-card'),
  loadBtn: $('load-btn'),
  loadProgress: $('load-progress'),
  loadBarFill: $('load-bar-fill'),
  loadFile: $('load-file'),
  loadPct: $('load-pct'),
  loadStatus: $('load-status'),
  app: $('app'),
  demoTabs: $('demo-tabs'),
  state: $('state'),
  question: $('question'),
  type: $('type'),
  options: $('options'),
  typeHint: $('type-hint'),
  decideBtn: $('decide-btn'),
  decideTiming: $('decide-timing'),
  error: $('error'),
  result: $('result'),
  resultEmpty: $('result-empty'),
};

let engine = null;
let activeDemo = DEMOS[0];

/* ---------------- model loading ---------------- */

const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
els.webgpuDetect.textContent = hasWebGPU
  ? 'available - GPU acceleration enabled'
  : 'not found - will use the slower WASM CPU fallback';

// One merged bar: each file contributes its share of the total expected bytes.
const TOTAL_BYTES = Object.values(EXPECTED_SIZES).reduce((a, b) => a + b, 0);
const doneBytes = {};
let loadedBytes = {};

function setFileProgress(label, loaded, total) {
  loadedBytes[label] = loaded;
  const expected = EXPECTED_SIZES[label] ?? total ?? loaded;
  // A file is "done" once its fetch resolves; engine.js signals that by an
  // equal loaded/total pair. Files with unknown length report raw bytes.
  const overall = Object.entries(loadedBytes).reduce(
    (sum, [name, bytes]) => sum + Math.min(bytes, EXPECTED_SIZES[name] ?? bytes), 0);
  const pct = Math.min(100, (overall / TOTAL_BYTES) * 100);
  els.loadBarFill.style.width = `${pct}%`;
  els.loadPct.textContent = `${pct.toFixed(0)}%`;
  els.loadFile.textContent = label;
}

function markFileDone(label) {
  doneBytes[label] = true;
  loadedBytes[label] = EXPECTED_SIZES[label] ?? loadedBytes[label] ?? 0;
  els.loadFile.textContent = label;
}

els.loadBtn.addEventListener('click', async () => {
  els.loadBtn.disabled = true;
  els.loadProgress.hidden = false;
  els.loadStatus.textContent = 'Downloading and initializing. This can take a minute.';
  try {
    engine = await JuliaEngine.load({
      baseUrl: MODEL_BASE_URL,
      onProgress: setFileProgress,
      onFileDone: markFileDone,
    });
    // The loader card has served its purpose once the model is resident.
    els.loaderCard.remove();
    els.engineChip.hidden = false;
    els.engineChip.textContent = engine.ep === 'webgpu' ? 'WebGPU (GPU)' : 'WASM (CPU)';
    els.app.hidden = false;
    els.decideBtn.disabled = false;
  } catch (error) {
    els.loadStatus.textContent = `Load failed: ${error.message ?? error}`;
    els.loadBtn.disabled = false;
  }
});

/* ---------------- demos + request types ---------------- */

const TYPE_HINTS = {
  choice: 'Pick the best option. 2 to 20 options, each up to 48 tokens.',
  score: 'Ordered rubric, lowest to highest. The result is the winning index.',
  noul: 'Boolean request. Exactly two options: false first, then true.',
};

function loadDemo(demo) {
  activeDemo = demo;
  els.state.value = demo.state;
  els.question.value = demo.question;
  els.type.value = demo.tag;
  els.options.value = demo.options.join('\n');
  els.typeHint.textContent = TYPE_HINTS[demo.tag];
  clearResult();
  for (const tab of els.demoTabs.children) {
    tab.classList.toggle('active', tab.dataset.demo === demo.id);
  }
}

function buildTabs() {
  for (const demo of DEMOS) {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.dataset.demo = demo.id;
    const tag = demo.tag.charAt(0).toUpperCase() + demo.tag.slice(1);
    tab.innerHTML = `<span class="tab-name">${demo.name}</span><span class="tab-tag">${tag}</span>`;
    tab.title = demo.blurb;
    tab.addEventListener('click', () => loadDemo(demo));
    els.demoTabs.append(tab);
  }
  loadDemo(activeDemo);
}
buildTabs();

/* ---------------- inference + visualization ---------------- */

function clearResult() {
  els.result.replaceChildren();
  els.resultEmpty.hidden = false;
  els.decideTiming.textContent = '';
  els.error.hidden = true;
}

function optionLabels(row) {
  // Demo labels (e.g. Legitimate/Scam for noul) only apply while the form
  // still holds that demo's options — otherwise fall back to the raw options.
  const sameOptions =
    activeDemo &&
    row.options.length === activeDemo.options.length &&
    row.options.every((opt, i) => opt === activeDemo.options[i]);
  return sameOptions && activeDemo.labels ? activeDemo.labels : row.options;
}

function renderResult(row, prediction, elapsedMs) {
  els.resultEmpty.hidden = true;
  els.result.replaceChildren();

  const winner = document.createElement('div');
  winner.className = 'winner';
  const labels = optionLabels(row);
  if (row.type === 'score') {
    winner.innerHTML = `Score: <span class="accent">${prediction.index}</span> <span class="muted">/ ${row.options.length - 1}</span>`;
  } else if (row.type === 'noul') {
    winner.innerHTML = `P(true) = <span class="accent">${(prediction.probabilities[1] * 100).toFixed(1)}%</span>`;
  } else {
    winner.innerHTML = `→ <span class="accent">${escapeHtml(labels[prediction.index])}</span>`;
  }
  els.result.append(winner);

  const probs = prediction.probabilities;
  // Bar widths: scale the winner to full width so close calls are readable,
  // but keep the printed percentages honest.
  const scale = 100 / Math.max(...probs);
  labels.forEach((label, i) => {
    const item = document.createElement('div');
    item.className = 'score' + (i === prediction.index ? ' is-winner' : '');

    const head = document.createElement('div');
    head.className = 'score-head';
    head.innerHTML = `<span>${escapeHtml(label)}</span><span class="pct">${(probs[i] * 100).toFixed(1)}%</span>`;

    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    // Animate from 0 → target width on the next frame.
    fill.style.width = '0%';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { fill.style.width = `${Math.max(probs[i] * scale, 1.5)}%`; });
    });
    track.append(fill);

    const raw = document.createElement('div');
    raw.className = 'raw';
    raw.textContent = `logit ${prediction.logits[i].toFixed(4)}`;

    item.append(head, track, raw);
    els.result.append(item);
  });

  els.decideTiming.textContent = `${elapsedMs.toFixed(0)} ms`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function readRow() {
  const options = els.options.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return {
    state: els.state.value,
    question: els.question.value,
    type: els.type.value,
    options,
  };
}

els.decideBtn.addEventListener('click', async () => {
  if (!engine) return;
  const row = readRow();
  els.error.hidden = true;
  els.decideBtn.disabled = true;
  try {
    const t0 = performance.now();
    const [prediction] = await engine.predict([row]);
    renderResult(row, prediction, performance.now() - t0);
  } catch (error) {
    els.error.textContent = error.message ?? String(error);
    els.error.hidden = false;
  } finally {
    els.decideBtn.disabled = false;
  }
});

// Re-render live when the user edits inputs after a run? No — keep results
// stable; just clear the stale result so it can't be misread.
for (const el of [els.state, els.question, els.options]) {
  el.addEventListener('input', clearResult);
}
els.type.addEventListener('change', () => {
  // Swap in an example matching the selected type so the option format is
  // always valid for it (e.g. noul needs exactly two options: false, true).
  const match = DEMOS.find((demo) => demo.tag === els.type.value);
  if (match) loadDemo(match);
});
