import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /loupe-image-zoom/.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
