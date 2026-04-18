import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'fs'

const BUILD_VERSION = Date.now().toString(36);

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'version-file',
      writeBundle() {
        writeFileSync('dist/version.json', JSON.stringify({ version: BUILD_VERSION }));
      },
    },
  ],
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
})
