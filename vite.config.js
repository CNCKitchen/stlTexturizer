import { defineConfig } from 'vite';
import legacy from '@vitejs/plugin-legacy';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0'
  },
  root: 'src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    minify: 'terser',
    rollupOptions: {
      input: {
        main: 'src/index.html',
      },
    },
  },
  plugins: [
    legacy({
      targets: ['defaults', 'not IE 11'],
    }),
    viteStaticCopy({
      targets: [
        {
          src: 'textures/*',
          dest: '.'
        }
      ]
    })
  ],
});
