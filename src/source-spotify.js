// Data source backed by the Spotify Web API + local IndexedDB history.
import * as db from './db.js';
import { api, pickImage } from './api.js';
import { sessionId } from './auth.js';
import { importFiles } from './importer.js';
import { DAY, emptySummary, mergeSummary, nameKey, norm } from './stats.js';

const RETRY_MISSING_AFTER = 7 * DAY;
const LOOKAHEAD = 6 * 3600_000; // plays are keyed by end time; catch ones that started before the range ended

function fromRecentItem(it) {
  const t = it.track;
  const a = t.artists?.[0] || {};
  const ts = Date.parse(it.played_at);
  return {
    id: `${ts}|${t.id || nameKey(a.name, t.name)}`,
    ts,
    ms: t.duration_ms,
    track: t.name,
    artist: a.name || 'Unknown artist',
    album: t.album?.name || null,
    trackId: t.id || null,
    artistId: a.id || null,
    image: pickImage(t.album?.images, 160),
    nk: nameKey(a.name, t.name),
    source: 'api',
  };
}

async function cached(key, fetcher) {
  const c = await db.getLookup(key);
  if (c && (c.found || Date.now() - c.at < RETRY_MISSING_AFTER)) return c.found ? c : null;
  let value = null;
  try {
    value = await fetcher();
  } catch (e) {
    if (e.status !== 400 && e.status !== 404) throw e;
  }
  const rec = { key, at: Date.now(), found: !!value, ...(value || {}) };
  await db.putLookup(rec);
  return rec.found ? rec : null;
}

export function spotifySource() {
  let owner = null; // Spotify user id the saved history belongs to; set once the account is verified
  const quiet = (p) => p.catch(() => {}); // cache writes are best-effort

  return {
    kind: 'spotify',

    setOwner(id) { owner = id; },

    async me() {
      try {
        const m = await api('/me');
        const me = { id: m.id, name: m.display_name || m.id, image: pickImage(m.images, 64) };
        // Cached for offline use, tagged with this login session and only once this account owns the history.
        quiet(db.setOwnedMeta('me', { ...me, sid: sessionId() }, m.id));
        return me;
      } catch (e) {
        const c = await db.getMeta('me');
        // Never fall back to a profile cached by a different (earlier) session: that could be another account.
        if (c && !navigator.onLine && c.sid && c.sid === sessionId()) {
          const { sid, ...me } = c;
          return me;
        }
        throw e;
      }
    },

    async summary() {
      return mergeSummary(emptySummary(), await db.allPlays());
    },

    playsBetween: (a, b) => db.playsBetween(a, b + LOOKAHEAD),

    importFiles: (files, onProgress) => importFiles(files, onProgress, owner),

    lastSync: () => db.getMeta('lastSync'),

    async sync() {
      if (!owner) throw new db.OwnerMismatchError();
      const data = await api('/me/player/recently-played?limit=50');
      const plays = (data?.items || []).filter((it) => it.track).map(fromRecentItem);
      const lastPlayTs = await db.getMeta('lastPlayTs');
      const added = await db.addPlays(plays, owner);
      const oldest = Math.min(...plays.map((p) => p.ts));
      const newest = Math.max(...plays.map((p) => p.ts), lastPlayTs || 0);
      // A full page whose oldest play is newer than anything we had means we missed some in between.
      const gap = !!lastPlayTs && plays.length >= 50 && oldest > lastPlayTs;
      await db.setOwnedMeta('lastPlayTs', newest, owner);
      await db.setOwnedMeta('lastSync', Date.now(), owner);
      return { added, gap };
    },

    artistInfo(name, idHint) {
      return cached(`a:${norm(name)}`, async () => {
        let a = null;
        if (idHint) a = await api(`/artists/${idHint}`);
        else {
          const r = await api(`/search?type=artist&limit=5&q=${encodeURIComponent(name)}`);
          a = r?.artists?.items?.find((x) => norm(x.name) === norm(name)) || null;
        }
        return a && { id: a.id, image: pickImage(a.images, 160), genres: a.genres || [], url: a.external_urls?.spotify };
      });
    },

    async trackArt(t) {
      return t.image || (await this.trackInfo(t))?.image || null;
    },

    /** Album art + Spotify link for a track, looked up by ID or by name. */
    async trackInfo(t) {
      if (t.image && t.trackId) return { image: t.image, url: `https://open.spotify.com/track/${t.trackId}` };
      return cached(`t2:${t.nk}`, async () => {
        let tr = null;
        if (t.trackId) tr = await api(`/tracks/${t.trackId}`);
        else {
          const q = encodeURIComponent(`track:${t.track} artist:${t.artist}`);
          const r = await api(`/search?type=track&limit=5&q=${q}`);
          tr = r?.tracks?.items?.find((x) => norm(x.name) === norm(t.track)) || null;
        }
        return tr && { image: pickImage(tr.album?.images, 160), url: tr.external_urls?.spotify };
      });
    },

    async top(type, range) {
      const key = `top:${type}:${range}`;
      try {
        const r = await api(`/me/top/${type}?time_range=${range}&limit=20`);
        const items = (r?.items || []).map((x) =>
          type === 'artists'
            ? { name: x.name, sub: null, image: pickImage(x.images, 160), url: x.external_urls?.spotify }
            : { name: x.name, sub: x.artists.map((a) => a.name).join(', '), image: pickImage(x.album?.images, 64), url: x.external_urls?.spotify },
        );
        quiet(db.setOwnedMeta(key, items, owner));
        return items;
      } catch (e) {
        const c = await db.getMeta(key);
        if (c && !navigator.onLine) return c;
        throw e;
      }
    },
  };
}
