import { initializeApp } from 'firebase/app';
import { initializeFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'YOUR_API_KEY',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'YOUR_PROJECT.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'YOUR_PROJECT_ID',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:000000000000:web:0000000000000000000000',
};

const app = initializeApp(firebaseConfig);

// Force HTTP long-polling instead of the default WebChannel/gRPC streaming
// transport. The streaming transport is silently blocked by many corporate
// proxies, VPNs, and some secondary networks — which made the config sync
// (category rules + per-transaction overrides) fail on some computers while
// working on others, so transactions showed up uncategorized there.
// Auto-detection still attempts the stream first and its fallback heuristic
// is unreliable on some of those networks, so we force long-polling outright;
// it's marginally slower to connect but works everywhere this app runs.
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
});
export default app;
