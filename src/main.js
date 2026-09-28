import { JuliaEngine } from './engine.js';
import { DEMOS } from './demos.js';
import { MODELS, EXPECTED_SIZES } from './config.js';
import { startBackdrop } from './backdrop.js';
import { createLatencyChart } from './latencyChart.js';

const $ = (id) => document.getElementById(id);

const els = {
  webgpuDetect: $('webgpu-detect'),
  loaderCard: $('loader-card'),
  loadBtn: $('load-btn'),
  loadProgress: $('load-progress'),
  loadBarFill: $('load-bar-fill'),
  loadFile: $('load-file'),
  loadPct: $('load-pct'),
  loadStatus: $('load-status'),
  modelSelect: $('model-select'),
  app: $('app'),
  demoTabs: $('demo-tabs'),
  state: $('state'),
  question: $('question'),
  type: $('type'),
  options: $('options'),
  typeHint: $('type-hint'),
  decideBtn: $('decide-btn'),
  error: $('error'),
  result: $('result'),
  resultEmpty: $('result-empty'),
  confidenceChip: $('confidence-chip'),
  stressBtn: $('stress-btn'),
  stressCancel: $('stress-cancel'),
  statLast: $('stat-last'),
  statMed: $('stat-med'),
  statP95: $('stat-p95'),
  statRate: $('stat-rate'),
};

let engine = null;
let activeDemo = DEMOS[0];

/* ---------------- 3D backdrop + latency chart ---------------- */

const backdrop = startBackdrop($('bg'));
const latencyChart = createLatencyChart($('latency-chart'));
const runTimes = [];

function recordRun(ms) {
  runTimes.push(ms);
  if (runTimes.length > 100) runTimes.shift();
  latencyChart.add(ms);
  backdrop.pulse();
  const last = runTimes[runTimes.length - 1];
  const sorted = [...runTimes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const span = Math.min(runTimes.length, 30);
  const recent = runTimes.slice(-span);
  const rate = 1000 / (recent.reduce((a, b) => a + b, 0) / span);
  els.statLast.textContent = `${last.toFixed(0)}ms`;
  els.statMed.textContent = `${median.toFixed(0)}ms`;
  els.statP95.textContent = `${p95.toFixed(0)}ms`;
  els.statRate.textContent = rate.toFixed(1);
}

/* ---------------- model loading ---------------- */

const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
els.webgpuDetect.textContent = hasWebGPU
  ? 'available - GPU acceleration enabled'
  : 'not found - will use the slower WASM CPU fallback';

// One merged bar: each file contributes its share of the total expected bytes.
const TOTAL_BYTES = Object.values(EXPECTED_SIZES).reduce((a, b) => a + b, 0);
const doneBytes = {};
let loadedBytes = {};

function setFileProgress(label, loaded, total, cached = false) {
  loadedBytes[label] = cached ? (EXPECTED_SIZES[label] ?? loaded) : loaded;
  const expected = EXPECTED_SIZES[label] ?? total ?? loaded;
  // A file is "done" once its fetch resolves; engine.js signals that by an
  // equal loaded/total pair. Files with unknown length report raw bytes.
  const overall = Object.entries(loadedBytes).reduce(
    (sum, [name, bytes]) => sum + Math.min(bytes, EXPECTED_SIZES[name] ?? bytes), 0);
  const pct = Math.min(100, (overall / TOTAL_BYTES) * 100);
  els.loadBarFill.style.width = `${pct}%`;
  els.loadPct.textContent = cached ? `${pct.toFixed(0)}% (cached)` : `${pct.toFixed(0)}%`;
  els.loadFile.textContent = cached ? `${label} · from cache` : label;
}

function markFileDone(label) {
  doneBytes[label] = true;
  loadedBytes[label] = EXPECTED_SIZES[label] ?? loadedBytes[label] ?? 0;
  els.loadFile.textContent = label;
}

// Populate the model selector from the registry (one model today, more later).
for (const [id, model] of Object.entries(MODELS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = model.label;
  els.modelSelect.append(opt);
}
els.modelSelect.value = 'julia-1';

els.loadBtn.addEventListener('click', async () => {
  els.loadBtn.disabled = true;
  els.loadProgress.hidden = false;
  els.loadStatus.textContent = 'Downloading and initializing. This can take a minute.';
  try {
    engine = await JuliaEngine.load({
      baseUrl: MODELS[els.modelSelect.value].baseUrl,
      onProgress: setFileProgress,
      onFileDone: markFileDone,
    });
    // Collapse the loader card away: it has served its purpose.
    els.loadStatus.textContent = `Model ready - session type: ${engine.ep === 'webgpu' ? 'WebGPU (GPU)' : 'WASM (CPU)'} · warmup ${engine.warmupMs} ms.`;
    els.loaderCard.classList.add('collapsing');
    setTimeout(() => els.loaderCard.remove(), 500);

    els.app.hidden = false;
    els.decideBtn.disabled = false;
    els.stressBtn.disabled = false;
    els.app.classList.add('revealed');
  } catch (error) {
    els.loadStatus.textContent = `Load failed: ${error.message ?? error}`;
    els.loadBtn.disabled = false;
  }
});

/* ---------------- demos + request types ---------------- */

const TYPE_HINTS = {
  choice: 'Pick one option out of 2 to 20, each up to 48 tokens.',
  score: 'Ordered rubric, lowest to highest. The result is the winning index.',
  noul: 'Boolean request. Exactly two options: false first, then true.',
};

function syncTypeHint() {
  els.typeHint.textContent = TYPE_HINTS[els.type.value] ?? '';
}
syncTypeHint();
els.type.addEventListener('change', syncTypeHint);

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
  els.confidenceChip.hidden = true;
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

function setConfidenceChip(maxProb, k) {
  // Confidence heuristic: winning share and the gap to the runner-up.
  const sorted = [...k].sort((a, b) => b - a);
  const gap = sorted[0] - (sorted[1] ?? 0);
  let cls = 'low';
  let text = 'Uncertain';
  if (maxProb > 0.85 || gap > 0.5) { cls = 'high'; text = 'High confidence'; }
  else if (maxProb > 0.55 || gap > 0.2) { cls = 'moderate'; text = 'Moderate'; }
  els.confidenceChip.className = `confidence-chip ${cls}`;
  els.confidenceChip.textContent = text;
  els.confidenceChip.hidden = false;
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
  setConfidenceChip(Math.max(...probs), probs);
  // Bar widths: scale the winner to full width so close calls are readable,
  // but keep the printed percentages honest.
  const scale = 100 / Math.max(...probs);
  labels.forEach((label, i) => {
    const item = document.createElement('div');
    item.className = 'score' + (i === prediction.index ? ' is-winner' : '');
    item.style.animationDelay = `${i * 45}ms`;

    const head = document.createElement('div');
    head.className = 'score-head';
    head.innerHTML = `<span>${escapeHtml(label)}</span><span class="pct" data-target="${probs[i]}">0.0%</span>`;

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

    // Count-up the percentage while the bar fills.
    const pctEl = head.querySelector('.pct');
    const target = probs[i];
    const dur = 650;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      pctEl.textContent = `${(target * eased * 100).toFixed(1)}%`;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
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

async function decide() {
  if (!engine) return;
  const row = readRow();
  els.error.hidden = true;
  els.decideBtn.disabled = true;
  try {
    const t0 = performance.now();
    const [prediction] = await engine.predict([row]);
    const elapsed = performance.now() - t0;
    renderResult(row, prediction, elapsed);
    recordRun(elapsed);  } catch (error) {
    els.error.textContent = error.message ?? String(error);
    els.error.hidden = false;
  } finally {
    els.decideBtn.disabled = false;
  }
}

els.decideBtn.addEventListener('click', decide);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !els.decideBtn.disabled) {
    e.preventDefault();
    decide();
  }
});

/* ---------------- stress test ---------------- */

let stressRunning = false;
let stressAbort = false;

els.stressBtn.addEventListener('click', runStress);
els.stressCancel.addEventListener('click', () => { stressAbort = true; });

async function runStress() {
  if (!engine || stressRunning) return;
  stressRunning = true;
  stressAbort = false;
  els.stressBtn.hidden = true;
  els.stressCancel.hidden = false;
  const row = readRow();
  try {
    for (let i = 0; i < 25 && !stressAbort; i++) {
      const t0 = performance.now();
      await engine.predict([row]);
      recordRun(performance.now() - t0);
      // Yield so the UI (and the backdrop pulse) stays fluid.
      await new Promise((r) => setTimeout(r, 16));
    }
  } catch (error) {
    els.error.textContent = `Stress test failed: ${error.message ?? error}`;
    els.error.hidden = false;
  } finally {
    stressRunning = false;
    els.stressBtn.hidden = false;
    els.stressCancel.hidden = true;
  }
}

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
