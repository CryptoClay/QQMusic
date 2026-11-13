// Reads what the service worker stored on POST /share-target (see public/sw.js — same DB layout).
export interface SharedPayload {
  files: File[];
  title: string;
  text: string;
  url: string;
  ts: number;
}

const DB = 'qqmusic-share';
const LEGACY_DB = 'homemusic-share';
const STORE = 'shares';
const KEY = 'pending';

function open(name = DB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, name = DB): Promise<T> {
  const db = await open(name);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const r = fn(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(r.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function readShare(): Promise<SharedPayload | null> {
  const v = await tx<SharedPayload | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<SharedPayload | undefined>);
  if (v) return v;
  const legacy = await tx<SharedPayload | undefined>(
    'readonly',
    (s) => s.get(KEY) as IDBRequest<SharedPayload | undefined>,
    LEGACY_DB,
  );
  if (!legacy) return null;
  // Keep the old payload until the new transaction has committed, including attached Files.
  await tx('readwrite', (s) => s.put(legacy, KEY));
  await tx('readwrite', (s) => s.delete(KEY), LEGACY_DB);
  return legacy;
}

export async function clearShare(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
  await tx('readwrite', (s) => s.delete(KEY), LEGACY_DB);
}
