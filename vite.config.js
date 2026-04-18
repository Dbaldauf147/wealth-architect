import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'version-file',
      writeBundle() {
        const version = Date.now().toString(36);
        writeFileSync('dist/version.json', JSON.stringify({ version }));
      },
    },
  ],
  define: {
    __BUILD_VERSION__: JSON.stringify(Date.now().toString(36)),
  },
})
