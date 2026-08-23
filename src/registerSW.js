/* Registers the service worker that makes the categorizer installable.

   Dev is deliberately excluded: a worker caching the Vite dev server's module
   graph makes edits appear not to apply, which costs more time than the offline
   shell saves. On an existing dev machine that once had one, we unregister. */
export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  if (!import.meta.env.PROD) {
    navigator.serviceWorker.getRegistrations?.()
      .then(regs => regs.forEach(r => r.scope.startsWith(window.location.origin) && r.unregister()))
      .catch(() => { /* nothing registered */ });
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // An install that fails is a missing offline shell, not a broken app.
      console.warn('Service worker registration failed:', err);
    });
  });
}
