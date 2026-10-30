import { defineConfig } from 'vite';
import { catalogHtml } from './build/catalog.mjs';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [catalogHtml()],
  build: { rollupOptions: { input: {
    site: fileURLToPath(new URL('./index.html', import.meta.url)),
    admin: fileURLToPath(new URL('./admin/index.html', import.meta.url))
  } } }
});
