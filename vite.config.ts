import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port (1420) and no auto-open. PORT overrides for
// tooling that assigns its own port (e.g. preview harnesses).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: Number(process.env.PORT ?? 1420),
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
});
