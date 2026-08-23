import { lazy, Suspense, useState, useEffect } from 'react';
import { App } from './App.jsx';

// The mobile categorizer is its own shell, not a page of the desktop app, so
// it is chosen here rather than in App's page switch. Only the surface the URL
// asks for is downloaded — a phone never fetches the desktop page chunks, and
// the desktop never fetches this one. The installed PWA starts at #m/review
// (see start_url in public/manifest.webmanifest).
const MobileApp = lazy(() => import('./mobile/MobileApp.jsx').then(m => ({ default: m.MobileApp })));

function isMobileRoute() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash === 'm' || hash.startsWith('m/');
}

export function Root() {
  const [mobile, setMobile] = useState(isMobileRoute);

  useEffect(() => {
    const onHash = () => setMobile(isMobileRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (mobile) {
    return (
      <Suspense fallback={null}>
        <MobileApp />
      </Suspense>
    );
  }
  return <App />;
}

export default Root;
