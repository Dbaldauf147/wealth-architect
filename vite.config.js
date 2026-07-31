import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'fs'

const BUILD_VERSION = Date.now().toString(36);

// Serve /api/market-data from the dev server. In production Vercel runs the
// handler in api/market-data.js; without this the Stock Performance tab would
// only work on a deployment. Deliberately scoped to this one route — the cron
// endpoints need service-account env vars and shouldn't be reachable locally.
const marketDataDevRoute = {
  name: 'market-data-dev-route',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/api/market-data', async (req, res) => {
      try {
        const { default: handler } = await server.ssrLoadModule('/api/market-data.js');
        const url = new URL(req.url, 'http://localhost');
        await handler(
          { method: req.method, query: Object.fromEntries(url.searchParams) },
          {
            setHeader: (k, v) => res.setHeader(k, v),
            status(code) { res.statusCode = code; return this; },
            json(body) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
              return this;
            },
          },
        );
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    marketDataDevRoute,
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
