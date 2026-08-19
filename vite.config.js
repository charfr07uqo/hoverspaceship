import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 9876,
    // Fail loudly instead of silently sliding to another port, which would leave
    // the .vscode launch profiles pointing at nothing.
    strictPort: true,
    open: false
  }
});
