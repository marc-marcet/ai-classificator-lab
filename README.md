# AI Classificator Lab

A serverless lab for **AI classification models** — routing, scoring and boolean decisions with calibrated probabilities — running entirely in the visitor's browser. Its first resident is **[Julia-1](https://huggingface.co/SupersonicLabs/Julia-1)**, the open, Apache-2.0 reimplementation of TypeSafe's **[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)** "System One" decision model.

State + question + 2–20 options in → one selected option with calibrated probabilities out. **All inference runs in the visitor's browser** via ONNX Runtime Web (WebGPU, WASM fallback). No backend, no API keys, zero per-query cost, and user text never leaves the tab.

## Run it

```bash
npm install
npm run dev      # → http://127.0.0.1:5173
```

Then click **Load model**. First visit downloads ~590 MB from the Hugging Face CDN (FP32 weights 550 MB + graph 3 MB + tokenizer 34 MB + WASM encoder 3 MB) - the browser caches it afterwards.

Build for any static host (Cloudflare Pages / GitHub Pages / Netlify / HF Spaces):

```bash
npm run build    # → dist/
```

## What's inside

```
index.html          UI shell (loader card, demo tabs, decision form, result panel)
src/config.js       model CDN URL + context budgets
src/engine.js       inference engine — port of upstream JuliaWebGPU adapter with:
                    · streaming per-file download progress
                    · WebGPU → WASM(CPU) execution-provider fallback
                    · true softmax probabilities + raw logits
src/demos.js        5 presets covering choice / score / noul request types
src/main.js         app wiring: loader, tabs, form, animated probability bars
src/styles.css      dark theme
```

## How the model is called

One strict-encoded sequence (parity-tested upstream: 100/100 predictions match the Python runtime):

```
[CLS] {type} question: {question} [SEP] <MASK> {option} [SEP] {state} [SEP]
```

Each option sits behind a `[MASK]` marker; the model emits one logit per marker, and softmax over those logits is the probability distribution. The per-request contract:

| type | options | output |
|---|---|---|
| `choice` | 2–20 descriptions | index of the best option |
| `score` | 2–20 ordered rubric levels | expected index (0…n) |
| `noul` | exactly 2: false, then true | probability of true |

Limits: options ≤ 48 tokens each, question+options ≤ 256-token head budget, combined sequence ≤ 1024 tokens (strict mode rejects overflow instead of silently truncating).

## Notes & caveats

- **WebGPU**: Chrome/Edge (desktop), recent Safari. Without it, the app automatically falls back to the ONNX Runtime WASM CPU provider (~100–500 ms per decision instead of ~75 ms).
- **Accuracy claims are upstream's** (73% typed-decisions, 94% AG News pilot) and were measured on the original Python runtime, not rerun on WebGPU. Upstream's browser parity test (100/100 matching predictions, max logit delta 0.00225) covered **`choice` requests only** — `score`/`noul` outputs on the ONNX export are not independently parity-verified.
- **`score` is the model's weakest type** per its own metrics (≈68.9%): expect misrankings even for seemingly obvious rubrics. Verified here in testing — treat score outputs as signals, not truth.
- Julia compares *supplied* answers; it doesn't supply missing facts. Ambiguous wording, unfamiliar domains and long option lists cause mistakes (Banking77 pilot: 64/100).
- The model is pulled from the Hugging Face CDN at runtime, so the deployed site itself is a few hundred KB of static assets.

## Credits

- [SupersonicLabs/Julia-1](https://huggingface.co/SupersonicLabs/Julia-1) and [Julia-1-ONNX](https://huggingface.co/SupersonicLabs/Julia-1-ONNX) (Apache-2.0) — model, ONNX export, WASM tokenizer, and the upstream adapter this engine is adapted from.
- [TypeSafe AI](https://typesafe.ai) — the Jev / System One Models concept.
- Base encoder: [jhu-clsp/mmBERT-small](https://huggingface.co/jhu-clsp/mmBERT-small).
