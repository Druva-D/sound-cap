// IndexedDB storage. A "play" is:
// { id, ts (end time, ms), ms (ms played), track, artist, album, trackId, artistId, image, nk (name key), source }
const DB_NAME = 'soundcap';
const VERSION = 1;
// Plays from the API and from a Spotify data export can describe the same listen with
// slightly different timestamps; treat same-song plays within this window as one.
const DEDUPE_WINDOW = 30_000;

let dbPromise;
function open() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('plays', { keyPath: 'id' }).createIndex('ts', 'ts');
      db.createObjectStore('lookup', { keyPath: 'key' });
      db.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
const store = async (name, mode = 'readonly') => (await open()).transaction(name, mode).objectStore(name);

export const allPlays = async () => req((await store('plays')).index('ts').getAll());
export const playsBetween = async (a, b) => req((await store('plays')).index('ts').getAll(IDBKeyRange.bound(a, b, false, true)));
export const getMeta = async (k) => req((await store('meta')).get(k));
export const setMeta = async (k, v) => req((await store('meta', 'readwrite')).put(v, k));
export const getLookup = async (k) => req((await store('lookup')).get(k));
export const putLookup = async (v) => req((await store('lookup', 'readwrite')).put(v));

export async function clearHistory() {
  const db = await open();
  const tx = db.transaction(['plays', 'meta'], 'readwrite');
  tx.objectStore('plays').clear();
  tx.objectStore('meta').delete('lastSync');
  tx.objectStore('meta').delete('lastPlayTs');
  await done(tx);
}

/**
 * Asks the browser not to clear Soundcap's data under storage pressure or inactivity.
 * Chrome/Edge decide silently; Firefox may show a prompt; Safari exempts home-screen apps.
 */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

export async function isPersisted() {
  try { return !!(await navigator.storage?.persisted?.()); } catch { return false; }
}

/** Deletes everything Soundcap stored about the user on this device. */
export async function clearAll() {
  const db = await open();
  const tx = db.transaction(['plays', 'lookup', 'meta'], 'readwrite');
  for (const name of ['plays', 'lookup', 'meta']) tx.objectStore(name).clear();
  await done(tx);
}

export const countPlays = async () => req((await store('plays')).count());

export class OwnerMismatchError extends Error {
  constructor() { super('Saved history belongs to a different session'); this.name = 'OwnerMismatchError'; }
}

/**
 * Runs writes in one transaction only if the saved history still belongs to `owner`.
 * The check and the writes are atomic, so work that started before a disconnect (in this
 * tab or another) can't put data back afterwards — the disconnect clears `ownerId`.
 */
async function guardedWrite(stores, owner, write) {
  if (!owner) throw new OwnerMismatchError();
  const db = await open();
  const tx = db.transaction(['meta', ...stores], 'readwrite');
  let mismatch = false;
  const r = tx.objectStore('meta').get('ownerId');
  r.onsuccess = () => {
    if (r.result !== owner) {
      mismatch = true;
      tx.abort();
      return;
    }
    write(tx);
  };
  try {
    await done(tx);
  } catch (e) {
    if (mismatch) throw new OwnerMismatchError();
    throw e;
  }
}

export const setOwnedMeta = (key, value, owner) => guardedWrite([], owner, (tx) => tx.objectStore('meta').put(value, key));

/**
 * Inserts plays owned by `owner`, skipping ones we already have. Returns the plays that were new.
 * The ownership check, the duplicate check and the writes all happen in one readwrite
 * transaction, so a concurrent sync and import (or another tab) can't both insert the same play.
 */
export async function addPlays(plays, owner) {
  if (!plays.length) return [];
  if (!owner) throw new OwnerMismatchError();
  const sorted = [...plays].sort((a, b) => a.ts - b.ts);
  const range = IDBKeyRange.bound(sorted[0].ts - DEDUPE_WINDOW, sorted[sorted.length - 1].ts + DEDUPE_WINDOW + 1, false, true);
  const db = await open();
  const tx = db.transaction(['meta', 'plays'], 'readwrite');
  const st = tx.objectStore('plays');
  const added = [];
  let mismatch = false;
  const ownerReq = tx.objectStore('meta').get('ownerId');
  ownerReq.onsuccess = () => {
    if (ownerReq.result !== owner) {
      mismatch = true;
      tx.abort();
      return;
    }
    const existingReq = st.index('ts').getAll(range);
    existingReq.onsuccess = () => {
      const existing = existingReq.result;
      const ids = new Set(existing.map((p) => p.id));
      const byName = new Map();
      for (const p of existing) {
        if (!byName.has(p.nk)) byName.set(p.nk, []);
        byName.get(p.nk).push(p);
      }
      for (const p of sorted) {
        if (ids.has(p.id)) continue;
        const same = byName.get(p.nk);
        if (same?.some((e) => e.source !== p.source && Math.abs(e.ts - p.ts) <= DEDUPE_WINDOW)) continue;
        ids.add(p.id);
        if (!same) byName.set(p.nk, [p]); else same.push(p);
        st.put(p);
        added.push(p);
      }
    };
  };
  try {
    await done(tx);
  } catch (e) {
    if (mismatch) throw new OwnerMismatchError();
    throw e;
  }
  return added;
}
