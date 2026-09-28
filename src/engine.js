// Browser inference engine for Julia-1-ONNX (Apache-2.0, SupersonicLabs).
// Adapted from the upstream `index.js` WebGPU adapter, with additions:
//   - streaming download progress for every remote file
//   - automatic WebGPU -> WASM(CPU) execution-provider fallback
//   - true softmax probabilities (upstream's `predict` returns cleaned
//     "display" probabilities; here we expose raw softmax for visualization)
// The strict request encoding is byte-for-byte the upstream logic, which is
// parity-tested against the Python runtime (100/100 matching predictions).

const TYPES = { choice: 0, score: 1, noul: 2 };

// Mirror Python's repr for non-string `state` payloads (dict / list).
function pythonJSON(value) {
  if (Array.isArray(value)) return `[${value.map(pythonJSON).join(', ')}]`;
  if (value && value.constructor === Object)
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJSON(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}

export function softmax(values) {
  const peak = Math.max(...values);
  const weights = values.map((x) => Math.exp(x - peak));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((x) => x / total);
}

function encode(tokenizer, text) {
  return Array.from(tokenizer(text, { add_special_tokens: false }).input_ids.data, Number);
}

// Strict encoding: [CLS] type question: … [SEP] <MASK> option1 [SEP] state… [SEP]
// Each option is anchored on a MASK marker whose per-marker logit the model scores.
function serialize(tokenizer, row, maxLength, headLength, strict) {
  const type = row.type ?? 'choice';
  if (!(type in TYPES) || typeof row.question !== 'string' ||
    !(typeof row.state === 'string' || Array.isArray(row.state) || row.state?.constructor === Object) ||
    !Array.isArray(row.options) || row.options.length < 2 || row.options.length > 20 ||
    row.options.some((x) => typeof x !== 'string' || !x) || (type === 'noul' && row.options.length !== 2)) {
    throw new TypeError('Invalid Julia decision request');
  }
  const state = typeof row.state === 'string' ? row.state : pythonJSON(row.state);
  const marker = tokenizer.mask_token;
  if (strict && [state, row.question, ...row.options].some((x) => x.includes(marker)))
    throw new Error('Reserved model marker in request');
  const clean = (x) => x.replaceAll(marker, ' ');
  const head = encode(tokenizer, `${type} question: ${clean(row.question)}`);
  const optionIds = row.options.map((x) => encode(tokenizer, ` ${clean(x)}`));
  if (strict && optionIds.some((x) => x.length > 48)) throw new Error('Option exceeds 48-token model contract');
  let options = optionIds.map((x) => [tokenizer.mask_token_id, ...x.slice(0, 48)]);
  let budget = headLength - options.reduce((sum, x) => sum + x.length, 0);
  if (budget < 16) {
    const perOption = Math.max(4, Math.floor((headLength - 16) / options.length));
    options = options.map((x) => x.slice(0, perOption));
    budget = headLength - options.reduce((sum, x) => sum + x.length, 0);
  }
  if (strict && (head.length > budget || options.some((x, i) => x.length !== optionIds[i].length + 1)))
    throw new Error('Question/options exceed lossless head budget');
  const ids = [tokenizer.cls_token_id ?? tokenizer.bos_token_id, ...head.slice(0, Math.max(8, budget)), tokenizer.sep_token_id];
  const markers = [];
  for (const option of options) { markers.push(ids.length); ids.push(...option); }
  ids.push(tokenizer.sep_token_id);
  const stateIds = encode(tokenizer, clean(state));
  const room = maxLength - ids.length - 1;
  if (room < 1) throw new Error('Question/options exceed sequence budget');
  if (strict && stateIds.length > room) throw new Error('State exceeds lossless context budget');
  ids.push(...stateIds.slice(0, room), tokenizer.sep_token_id);
  return { ids, markers, qtype: TYPES[type] };
}

// Persistent model cache (OPFS): survives reloads and browser restarts, on
// localhost and on static hosts alike. The HTTP cache alone is not reliable
// for the big HF CDN files (signed redirects + revalidation), so we store the
// bytes explicitly on first download. OPFS is used because Cache Storage's
// cache.put silently failed for the 550 MB weights in testing; OPFS streams
// to disk and handles multi-hundred-MB blobs without issue.
let opfsRootPromise = null;
function opfsRoot() {
  if (!opfsRootPromise) {
    opfsRootPromise = navigator.storage?.getDirectory
      ? navigator.storage.getDirectory().catch(() => null)
      : Promise.resolve(null);
  }
  return opfsRootPromise;
}

async function readOpfsFile(dir, name, onProgress, label) {
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  // Read in chunks so the progress bar animates instead of freezing.
  const total = file.size;
  const bytes = new Uint8Array(total);
  const CHUNK = 16 * 1024 * 1024;
  for (let offset = 0; offset < total; offset += CHUNK) {
    const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
    bytes.set(new Uint8Array(buf), offset);
    onProgress?.(label, Math.min(offset + CHUNK, total), total, true);
  }
  return bytes;
}

async function writeOpfsFile(dir, name, bytes) {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function fetchWithProgress(url, onProgress, label, opfsName) {
  const dir = await opfsRoot();
  if (dir && opfsName) {
    try {
      const bytes = await readOpfsFile(dir, opfsName, onProgress, label);
      return bytes;
    } catch { /* not cached yet - fall through to network */ }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  // Preallocate when the size is known — avoids doubling memory on a 577 MB file.
  const single = total ? new Uint8Array(total) : null;
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (single) single.set(value, loaded);
    else chunks.push(value);
    loaded += value.length;
    onProgress?.(label, loaded, total, false);
  }
  const bytes = single ?? (() => {
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  })();
  // Persist after the read completes so a mid-download failure never stores
  // a truncated file. Storage errors are non-fatal: next load just re-downloads.
  if (dir && opfsName) {
    try { await writeOpfsFile(dir, opfsName, bytes); } catch { /* quota or unsupported */ }
  }
  return bytes;
}

export class JuliaEngine {
  static async load({
    baseUrl,
    onProgress = () => {},
    onFileDone = () => {},
    maxLength = 1024,
    headLength = 256,
    strictEncoding = true,
  } = {}) {
    const base = new URL(baseUrl, location.href).href;
    const progress = (label, loaded, total) => onProgress(label, loaded, total);
    const done = (label) => onFileDone(label);

    // 1) Rust->WASM tokenizer/encoder (primary, parity-tested path).
    // HF's `resolve/` CDN serves files as text/plain, which browsers refuse
    // for module scripts — so fetch the glue code and import it from a blob
    // URL instead. The .wasm is passed as bytes, so import.meta.url is unused.
    const wasmJsUrl = new URL('wasm/julia_webgpu_encode.js', base).href;
    const glueBytes = await fetchWithProgress(wasmJsUrl, progress, 'wasm-glue', 'julia-wasm-glue.js');
    const glueUrl = URL.createObjectURL(
      new Blob([glueBytes], { type: 'text/javascript' }));
    const encoderModule = await import(/* @vite-ignore */ glueUrl);
    URL.revokeObjectURL(glueUrl);
    const wasmBytes = await fetchWithProgress(
      new URL('wasm/julia_webgpu_encode_bg.wasm', base).href, progress, 'wasm-encoder', 'julia-wasm-encoder.wasm');
    await encoderModule.default({ module_or_path: wasmBytes });
    const tokenizerText = new TextDecoder().decode(await fetchWithProgress(
      new URL('tokenizer.json', base).href, progress, 'tokenizer.json', 'julia-tokenizer.json'));
    const encoder = new encoderModule.WasmEncoder(tokenizerText);
    done('wasm-glue');
    done('wasm-encoder');
    done('tokenizer.json');

    // 2) Model graph + external weights, both fetched manually so we can
    //    report progress (ORT would otherwise download silently).
    const modelUrl = new URL('model.onnx', base).href;
    const weightsUrl = `${modelUrl}.data`;
    const modelBytes = await fetchWithProgress(modelUrl, progress, 'model.onnx', 'julia-model.onnx');
    done('model.onnx');
    const weightsBytes = await fetchWithProgress(weightsUrl, progress, 'model.onnx.data', 'julia-model.onnx.data');
    done('model.onnx.data');

    const ort = await import('onnxruntime-web/webgpu');
    if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;

    // 3) Session: prefer WebGPU, fall back to the WASM CPU provider.
    const tried = [];
    for (const ep of navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']) {
      try {
        const session = await ort.InferenceSession.create(modelBytes, {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
          externalData: [{ path: 'model.onnx.data', data: weightsBytes }],
        });
        // ORT copied what it needs — release our JS-side copies.
        modelBytes.fill(0); weightsBytes.fill(0);
        const engine = new JuliaEngine(ort, session, encoder, maxLength, headLength, strictEncoding, ep);
        const t0 = performance.now();
        await engine.warm();
        engine.warmupMs = Math.round(performance.now() - t0);
        return engine;
      } catch (error) {
        tried.push(`${ep}: ${error.message ?? error}`);
      }
    }
    throw new Error(`Could not create an inference session. ${tried.join(' | ')}`);
  }

  constructor(ort, session, encoder, maxLength, headLength, strictEncoding, ep) {
    Object.assign(this, { ort, session, encoder, maxLength, headLength, strictEncoding, ep, warmupMs: 0 });
  }

  get info() {
    return { ep: this.ep, maxLength: this.maxLength, headLength: this.headLength, warmupMs: this.warmupMs };
  }

  async warm() {
    await this.logits([{ state: '', question: 'Ready?', options: ['Yes', 'No'] }]);
    return this;
  }

  async logits(rows) {
    if (!rows.length) return [];
    const items = rows.map((row) => {
      if (this.encoder) {
        return JSON.parse(this.encoder.encode(
          JSON.stringify(row), this.maxLength, this.headLength, this.strictEncoding));
      }
      return null; // JS-tokenizer fallback path is not wired up; WASM encoder is required.
    });
    const batch = items.length;
    const length = Math.ceil(Math.max(...items.map((x) => x.ids.length)) / 8) * 8;
    const count = Math.max(...items.map((x) => x.markers.length));
    const ids = new BigInt64Array(batch * length);
    const attention = new BigInt64Array(batch * length);
    const positions = new BigInt64Array(batch * count);
    const mask = new Uint8Array(batch * count);
    const qtype = new BigInt64Array(batch);
    items.forEach((item, i) => {
      item.ids.forEach((id, j) => { ids[i * length + j] = BigInt(id); attention[i * length + j] = 1n; });
      item.markers.forEach((pos, j) => { positions[i * count + j] = BigInt(pos); mask[i * count + j] = 1; });
      qtype[i] = BigInt(item.qtype);
    });
    const ort = this.ort;
    const output = await this.session.run({
      input_ids: new ort.Tensor('int64', ids, [batch, length]),
      attention_mask: new ort.Tensor('int64', attention, [batch, length]),
      marker_pos: new ort.Tensor('int64', positions, [batch, count]),
      marker_mask: new ort.Tensor('bool', mask, [batch, count]),
      qtype: new ort.Tensor('int64', qtype, [batch]),
    });
    const logitsOutput = output.logits ?? output[Object.keys(output)[0]];
    const values = await logitsOutput.getData();
    return items.map((item, i) => Array.from(values.slice(i * count, i * count + item.markers.length)));
  }

  async predict(rows) {
    const allLogits = await this.logits(rows);
    return allLogits.map((values) => ({
      index: values.indexOf(Math.max(...values)),
      probabilities: softmax(values),
      logits: values,
    }));
  }
}
