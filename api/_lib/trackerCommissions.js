// The Prospect Tracker's Commissions table, read from its Firestore with the
// same service account the crons use. Shared by api/commissions (the pages)
// and api/over-income-alert (the expected-income email). See api/commissions
// for where the table lives and who can read it.

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { parseCommissionRows } from '../../src/lib/commissions.js';

const APP_NAME = 'prospect-tracker';
const PROJECT_ID = process.env.TRACKER_PROJECT_ID || 'tracker-3161a';
// The tracker account the table belongs to (baldaufdan@gmail.com).
const OWNER_UID = process.env.TRACKER_UID || 'sAaCkgRoLpR4WF8Bn0FuWmlnQBQ2';
const MIRROR_KEY = 'commissions-list-override';

export function trackerDb() {
  if (!getApps().some(a => a.name === APP_NAME)) {
    const raw = process.env.TRACKER_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('Service account JSON is not valid JSON'); }
    initializeApp({ credential: cert(parsed), projectId: PROJECT_ID }, APP_NAME);
  }
  return getFirestore(getApp(APP_NAME));
}

export async function readMirror(db) {
  const ref = db.collection('userSettings').doc(OWNER_UID).collection('localMirrors').doc(MIRROR_KEY);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const chunkCount = Number(data.chunkCount) || 0;
  let json = typeof data.json === 'string' ? data.json : '';
  if (chunkCount > 0) {
    const parts = new Array(chunkCount).fill('');
    const chunks = await ref.collection('chunks').get();
    chunks.forEach(d => {
      const i = Number(d.id);
      if (Number.isInteger(i) && i >= 0 && i < chunkCount) parts[i] = String(d.data()?.s || '');
    });
    json = parts.join('');
  }
  return { json, updatedAt: Number(data.updatedAt) || null };
}

/** The parsed commissions table, or [] when the tracker has none saved.
 *  Throws when it can't be read. */
export async function readTrackerCommissions() {
  const db = trackerDb();
  if (!db) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  const mirror = await readMirror(db);
  if (!mirror || !mirror.json) return [];
  return parseCommissionRows(JSON.parse(mirror.json));
}
