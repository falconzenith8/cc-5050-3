import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: 'public',
  server: {
    port: 5179,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
    // @openusd-wasm/pxr uses WebAssembly pthreads, which needs a cross-origin
    // isolated context. Applied to dev and preview alike.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: { manualChunks: undefined },
    },
  },
  optimizeDeps: {
    exclude: ['lightusd', '@openusd-wasm/three-loader', '@openusd-wasm/pxr'],
  },
  assetsInclude: ['**/*.wasm', '**/*.wasm.zst', '**/*.usda'],
});
