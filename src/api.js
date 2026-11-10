import { getAccessToken, sessionId, SessionEndedError } from './auth.js';

const BASE = 'https://api.spotify.com/v1';
const MAX_CONCURRENT = 4;

export class AuthError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny semaphore so image/genre enrichment can't stampede the rate limiter.
let active = 0;
const waiting = [];
async function acquire() {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active++;
}
function release() {
  active--;
  waiting.shift()?.();
}

export async function api(path) {
  await acquire();
  try {
    let token = await getAccessToken();
    if (!token) throw new AuthError('Not signed in');
    const sid = sessionId();
    let refreshed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 401 && !refreshed) {
        refreshed = true;
        token = await getAccessToken(true);
        if (!token) throw new AuthError('Session expired');
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        const wait = Number(r.headers.get('Retry-After')) || 2 ** attempt;
        await sleep(Math.min(wait, 30) * 1000);
        continue;
      }
      // Drop responses that belong to a session that ended while the request was in flight.
      if (sessionId() !== sid) throw new SessionEndedError();
      if (r.status === 204) return null;
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        const e = r.status === 401 ? new AuthError('Session expired') : new Error(j?.error?.message || `Spotify API error ${r.status}`);
        e.status = r.status;
        throw e;
      }
      return r.json();
    }
    throw new Error('Spotify is busy right now. Try again in a minute.');
  } finally {
    release();
  }
}

export function pickImage(images, minSize = 160) {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 0) >= minSize) || sorted[sorted.length - 1]).url;
}
