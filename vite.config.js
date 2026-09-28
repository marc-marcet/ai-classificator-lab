import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works when hosted at a subpath, e.g.
  // https://<user>.github.io/<repo>/ (GitHub Pages project pages).
  base: './',
  // onnxruntime-web / our adapter use BigInt64Array and top-level dynamic
  // imports of remote modules — target esnext so nothing gets transpiled away.
  build: {
    target: 'esnext',
  },
});
