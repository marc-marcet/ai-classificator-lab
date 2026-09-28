// Where the ONNX model + WASM tokenizer are pulled from.
// HF `resolve/` URLs are CORS-enabled static file servers — no API key needed.
// Keep the trailing slash: the loader joins file names onto it.
export const MODEL_BASE_URL =
  'https://huggingface.co/SupersonicLabs/Julia-1-ONNX/resolve/main/';

// File sizes are only used for progress display (bytes are also taken from
// Content-Length when available; these are the fallbacks, measured from the CDN).
export const EXPECTED_SIZES = {
  'tokenizer.json': 34.4 * 1024 * 1024,
  'wasm-encoder': 2.9 * 1024 * 1024,
  'model.onnx': 3 * 1024 * 1024,
  'model.onnx.data': 550 * 1024 * 1024,
};

// Upstream default context budgets (parity-tested against the Python runtime).
export const MAX_LENGTH = 1024;
export const HEAD_LENGTH = 256;
