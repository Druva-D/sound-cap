// Imports Spotify "Download your data" exports (zip or JSON) and Soundcap backups.
import * as db from './db.js';
import { nameKey } from './stats.js';

const HISTORY_FILE = /(StreamingHistory|Streaming_History_Audio)[^/]*\.json$/i;
const SKIP_FILE = /podcast|video/i;

// Limits that comfortably fit a real Spotify export (a heavy listener's extended history is a
// few dozen ~12 MB JSON files) but stop a crafted file from exhausting the tab's memory.
const LIMITS = {
  zipBytes: 300 * 2 ** 20,      // compressed .zip size
  jsonBytes: 150 * 2 ** 20,     // a single JSON file, or one file inside the zip once inflated
  totalBytes: 1024 * 2 ** 20,   // everything inflated in one import
  zipEntries: 5000,
  records: 3_000_000,
};
const MB = (n) => `${Math.round(n / 2 ** 20)} MB`;
const tooBig = (what, limit) => new Error(`${what} is larger than Soundcap can safely import (limit ${MB(limit)}).`);

/** Inflates zip entry data, giving up as soon as the output passes `limit` bytes. */
async function inflate(data, method, limit, name) {
  if (method === 0) {
    if (data.length > limit) throw tooBig(name, limit);
    return data;
  }
  if (method !== 8) throw new Error(`Unsupported compression in ${name}`);
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooBig(name, limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Minimal zip reader using the browser's built-in deflate decoder. */
async function readZip(file) {
  if (file.size > LIMITS.zipBytes) throw tooBig(file.name, LIMITS.zipBytes);
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const bad = () => new Error(`${file.name} isn't a readable zip file.`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad();
  const count = dv.getUint16(eocd + 10, true);
  if (count > LIMITS.zipEntries) throw new Error(`${file.name} contains too many files to import.`);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const size = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
    entries.push({
      name,
      async bytes(limit) {
        if (local + 30 > buf.length) throw bad();
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        if (start + size > buf.length) throw bad();
        return inflate(buf.subarray(start, start + size), method, limit, name);
      },
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function parseRecord(r) {
  let ts, ms, track, artist, album = null, trackId = null;
  if ('ts' in r && 'ms_played' in r) {
    // Extended streaming history
    track = r.master_metadata_track_name;
    artist = r.master_metadata_album_artist_name;
    album = r.master_metadata_album_album_name || null;
    trackId = r.spotify_track_uri?.split(':')[2] || null;
    ts = Date.parse(r.ts);
    ms = r.ms_played;
  } else if (typeof r.endTime === 'string' && 'msPlayed' in r) {
    // Account data (past year) — endTime is UTC "YYYY-MM-DD HH:mm"
    track = r.trackName;
    artist = r.artistName;
    ts = Date.parse(`${r.endTime.replace(' ', 'T')}:00Z`);
    ms = r.msPlayed;
  } else return null;
  if (typeof track !== 'string' || typeof artist !== 'string' || !track || !artist) return null; // podcasts, audiobooks, junk
  if (typeof ms !== 'number' || !(ms > 0) || !Number.isFinite(ts)) return null;
  const nk = nameKey(artist, track);
  return { id: `${ts}|${nk}`, ts, ms, track, artist, album, trackId, artistId: null, image: null, nk, source: 'import' };
}

function parseBackupPlay(p) {
  if (typeof p?.ts !== 'number' || typeof p.ms !== 'number' || typeof p.track !== 'string' || typeof p.artist !== 'string') return null;
  return {
    id: String(p.id || `${p.ts}|${nameKey(p.artist, p.track)}`), ts: p.ts, ms: p.ms, track: p.track, artist: p.artist,
    album: p.album ?? null, trackId: p.trackId ?? null, artistId: p.artistId ?? null,
    image: typeof p.image === 'string' && p.image.startsWith('https://') ? p.image : null,
    nk: nameKey(p.artist, p.track), source: p.source === 'api' ? 'api' : 'import',
  };
}

function collect(json, out) {
  const list = json?.soundcap && Array.isArray(json.plays) ? json.plays : Array.isArray(json) ? json : null;
  if (!list) return 0;
  if (out.length + list.length > LIMITS.records) throw new Error('That’s more listening history than Soundcap can import at once.');
  const parse = json?.soundcap ? parseBackupPlay : parseRecord;
  let n = 0;
  for (const r of list) {
    let p = null;
    try { p = r && typeof r === 'object' ? parse(r) : null; } catch { p = null; } // skip malformed rows, keep the rest
    if (p) { out.push(p); n++; }
  }
  return n;
}

const parseJson = (bytes, name) => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${name} isn't valid JSON.`);
  }
};

/** Imports Spotify exports or Soundcap backups into the history owned by `owner`. */
export async function importFiles(files, onProgress = () => {}, owner) {
  const plays = [];
  let recognised = 0;
  let budget = LIMITS.totalBytes;
  const take = (bytes) => {
    budget -= bytes.length;
    if (budget < 0) throw tooBig('This import', LIMITS.totalBytes);
    return bytes;
  };
  for (const f of files) {
    onProgress(`Reading ${f.name}…`);
    if (/\.zip$/i.test(f.name) || f.type.includes('zip')) {
      for (const e of await readZip(f)) {
        if (!HISTORY_FILE.test(e.name) || SKIP_FILE.test(e.name.split('/').pop())) continue;
        const bytes = take(await e.bytes(Math.min(LIMITS.jsonBytes, budget)));
        if (collect(parseJson(bytes, e.name), plays)) recognised++;
      }
    } else {
      if (f.size > LIMITS.jsonBytes) throw tooBig(f.name, LIMITS.jsonBytes);
      const bytes = take(new Uint8Array(await f.arrayBuffer()));
      if (collect(parseJson(bytes, f.name), plays)) recognised++;
    }
  }
  if (!recognised) {
    throw new Error("Couldn't find any listening history in those files. Look for StreamingHistory or Streaming_History_Audio files.");
  }
  plays.sort((a, b) => a.ts - b.ts);
  const added = [];
  const CHUNK = 5000;
  for (let i = 0; i < plays.length; i += CHUNK) {
    onProgress(`Saving ${Math.min(i + CHUNK, plays.length).toLocaleString()} of ${plays.length.toLocaleString()} plays…`);
    for (const p of await db.addPlays(plays.slice(i, i + CHUNK), owner)) added.push(p);
  }
  return { found: plays.length, added };
}

export async function exportBackup() {
  const plays = await db.allPlays();
  const blob = new Blob([JSON.stringify({ soundcap: 1, exportedAt: new Date().toISOString(), plays })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `soundcap-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return plays.length;
}
