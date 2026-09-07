import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'fs'

const BUILD_VERSION = Date.now().toString(36);

// Serve the read-only API routes from the dev server. In production Vercel runs
// these handlers; without this they would only work on a deployment.
// Deliberately a list rather than a glob — the cron endpoints write to Firestore
// with service-account credentials and have no business being reachable locally.
const DEV_ROUTES = ['market-data', 'splitwise'];

function devApiRoutes() {
  return {
    name: 'dev-api-routes',
    apply: 'serve',
    configureServer(server) {
      for (const route of DEV_ROUTES) {
        server.middlewares.use(`/api/${route}`, async (req, res) => {
          try {
            const { default: handler } = await server.ssrLoadModule(`/api/${route}.js`);
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
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Vite only exposes VITE_-prefixed vars to the client, and deliberately so.
  // The dev API handlers run in Node and read process.env, so a key in
  // .env.local reaches them the same way Vercel's env reaches production.
  const env = loadEnv(mode, process.cwd(), '');
  for (const k of ['SPLITWISE_API_KEY']) {
    if (env[k] && !process.env[k]) process.env[k] = env[k];
  }

  return {
    plugins: [
      react(),
      devApiRoutes(),
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
  };
})
