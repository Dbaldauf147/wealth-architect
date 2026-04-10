import { useState, useEffect, useCallback } from 'react';

const PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const API_KEY = import.meta.env.VITE_FIREBASE_API_KEY;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function docToObj(doc) {
  const fields = doc.fields || {};
  const obj = { id: doc.name.split('/').pop() };
  for (const [key, val] of Object.entries(fields)) {
    if ('stringValue' in val) obj[key] = val.stringValue;
    else if ('integerValue' in val) obj[key] = Number(val.integerValue);
    else if ('doubleValue' in val) obj[key] = val.doubleValue;
    else if ('booleanValue' in val) obj[key] = val.booleanValue;
    else if ('timestampValue' in val) obj[key] = val.timestampValue;
    else if ('arrayValue' in val) {
      obj[key] = (val.arrayValue.values || []).map(v => {
        if ('mapValue' in v) {
          const m = {};
          for (const [mk, mv] of Object.entries(v.mapValue.fields || {})) {
            if ('stringValue' in mv) m[mk] = mv.stringValue;
            else if ('integerValue' in mv) m[mk] = Number(mv.integerValue);
            else if ('doubleValue' in mv) m[mk] = mv.doubleValue;
          }
          return m;
        }
        return v.stringValue || '';
      });
    }
  }
  return obj;
}

function toFirestoreValue(val) {
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(v => typeof v === 'object' ? { mapValue: { fields: toFirestoreFields(v) } } : toFirestoreValue(v)) } };
  return { stringValue: String(val) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined && val !== null) fields[key] = toFirestoreValue(val);
  }
  return fields;
}

export function useBudgets() {
  const [budgets, setBudgets] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchBudgets = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/budgets?key=${API_KEY}`);
      const data = await res.json();
      const docs = (data.documents || []).map(docToObj);
      docs.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      setBudgets(docs);
    } catch (err) {
      console.error('Failed to fetch budgets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBudgets();
    const interval = setInterval(fetchBudgets, 30000);
    return () => clearInterval(interval);
  }, [fetchBudgets]);

  async function addBudget({ name, monthlyLimit, icon, color, period, subBudgets }) {
    const subs = (subBudgets || []).map(s => ({ id: crypto.randomUUID(), name: s.name, monthlyLimit: Number(s.monthlyLimit) || 0 }));
    const fields = toFirestoreFields({
      name, monthlyLimit: Number(monthlyLimit) || 0, icon: icon || 'savings',
      color: color || '#0058be', period: period || 'monthly',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      subBudgets: subs,
    });
    await fetch(`${BASE}/budgets?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    fetchBudgets();
  }

  async function updateBudget(id, updates) {
    const current = budgets.find(b => b.id === id);
    if (!current) return;
    const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };
    delete merged.id;
    const fields = toFirestoreFields(merged);
    if (merged.subBudgets) {
      fields.subBudgets = toFirestoreValue(merged.subBudgets);
    }
    await fetch(`${BASE}/budgets/${id}?key=${API_KEY}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    fetchBudgets();
  }

  async function deleteBudget(id) {
    await fetch(`${BASE}/budgets/${id}?key=${API_KEY}`, { method: 'DELETE' });
    fetchBudgets();
  }

  async function addSubBudget(budgetId, { name, monthlyLimit }) {
    const current = budgets.find(b => b.id === budgetId);
    if (!current) return;
    const subs = [...(current.subBudgets || []), { id: crypto.randomUUID(), name, monthlyLimit: Number(monthlyLimit) || 0 }];
    await updateBudget(budgetId, { subBudgets: subs });
  }

  async function updateSubBudget(budgetId, subId, updates) {
    const current = budgets.find(b => b.id === budgetId);
    if (!current) return;
    const subs = (current.subBudgets || []).map(s => s.id === subId ? { ...s, ...updates } : s);
    await updateBudget(budgetId, { subBudgets: subs });
  }

  async function deleteSubBudget(budgetId, subId) {
    const current = budgets.find(b => b.id === budgetId);
    if (!current) return;
    const subs = (current.subBudgets || []).filter(s => s.id !== subId);
    await updateBudget(budgetId, { subBudgets: subs });
  }

  return { budgets, loading, addBudget, updateBudget, deleteBudget, addSubBudget, updateSubBudget, deleteSubBudget };
}
