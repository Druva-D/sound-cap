// A believable, deterministic fake listening history so the app can be explored without Spotify.
import { DAY, emptySummary, mergeSummary, nameKey, startOfDay, addDays } from './stats.js';

const ARTISTS = [
  ['Velvet Static', 'dream pop'], ['Juno Vale', 'indie pop'], ['Moon Harbor', 'bedroom pop'],
  ['Coral Theory', 'neo soul'], ['Neon Pilgrim', 'synthwave'], ['Saffron Hours', 'alt r&b'],
  ['The Quiet Ferns', 'indie folk'], ['Lumen Drive', 'synthwave'], ['Mira Solano', 'latin pop'],
  ['Glasshouse Kid', 'jazz rap'], ['Pale Arcade', 'shoegaze'], ['Tidal Maps', 'math rock'],
  ['Ruby Overpass', 'indie pop'], ['Okra Bloom', 'afrobeats'], ['North of Nowhere', 'art rock'],
  ['Kiko & the Lanterns', 'city pop'], ['Halden Rue', 'lo-fi beats'], ['Seraphine Gold', 'neo soul'],
  ['Wax Comet', 'dream pop'], ['Dune Choir', 'ambient'], ['Bright Hollow', 'indie folk'],
  ['Paloma Ray', 'alt r&b'], ['Static Orchard', 'shoegaze'], ['Tokyo Fern', 'city pop'],
];
const WORDS_A = ['Golden', 'Paper', 'Velvet', 'Midnight', 'Silver', 'Electric', 'Quiet', 'Neon', 'Summer', 'Slow', 'Blue', 'Crystal', 'Honey', 'Lost', 'Wild'];
const WORDS_B = ['Hour', 'Satellite', 'Avenue', 'Heart', 'Weather', 'Signal', 'Garden', 'Motel', 'Echo', 'Ritual', 'Tide', 'Parade', 'Season', 'Daydream', 'Highway'];
const HOUR_WEIGHTS = [3, 2, 1, 0, 0, 0, 1, 4, 6, 5, 3, 3, 4, 3, 3, 4, 5, 6, 7, 8, 9, 9, 8, 6];

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const weighted = (r, weights) => {
  let x = r() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) < 0) return i;
  return weights.length - 1;
};

function generate() {
  const r = rng(20211);
  const artists = ARTISTS.map(([name, genre], i) => ({
    name, genre,
    debut: i < 14 ? -Infinity : 30 + (i - 14) * 11, // later artists get "discovered" over time
    tracks: Array.from({ length: 6 }, () => ({
      name: `${WORDS_A[Math.floor(r() * WORDS_A.length)]} ${WORDS_B[Math.floor(r() * WORDS_B.length)]}`,
      ms: (150 + Math.floor(r() * 130)) * 1000,
    })),
  }));
  const plays = [];
  const now = Date.now();
  const first = addDays(startOfDay(now), -150);
  for (let day = 0; day <= 150; day++) {
    const date = addDays(first, day);
    if (r() < 0.12) continue;
    const month = date.getMonth();
    const weights = artists.map((a, i) => (day < a.debut ? 0 : 1 / ((i + month * 5) % artists.length + 1) ** 1.15));
    const sessions = 1 + weighted(r, [5, 4, 2]);
    for (let s = 0; s < sessions; s++) {
      let t = +date + weighted(r, HOUR_WEIGHTS) * 3600_000 + Math.floor(r() * 3600_000);
      const n = 4 + Math.floor(r() * 18);
      for (let k = 0; k < n && t < now; k++) {
        const a = artists[weighted(r, weights)];
        const tr = a.tracks[weighted(r, [6, 4, 3, 2, 1, 1])];
        const ms = r() < 0.86 ? tr.ms : 8000 + Math.floor(r() * 30000);
        const end = t + ms;
        if (end > now) break;
        plays.push({
          id: `${end}|demo`, ts: end, ms, track: tr.name, artist: a.name, album: null,
          trackId: null, artistId: null, image: null, nk: nameKey(a.name, tr.name), source: 'demo',
        });
        t = end + 2000;
      }
    }
  }
  plays.sort((a, b) => a.ts - b.ts);
  return { plays, genres: new Map(artists.map((a) => [a.name, [a.genre]])) };
}

export function demoSource() {
  const { plays, genres } = generate();
  const between = (a, b) => plays.filter((p) => p.ts >= a && p.ts < b);
  return {
    kind: 'demo',
    me: async () => ({ id: 'demo', name: 'Demo listener', image: null }),
    summary: async () => mergeSummary(emptySummary(), plays),
    playsBetween: async (a, b) => between(a, b + 6 * 3600_000),
    lastSync: async () => null,
    sync: null,
    artistInfo: async (name) => ({ image: null, genres: genres.get(name) || [] }),
    trackArt: async () => null,
    trackInfo: async () => null,
    async top(type, range) {
      const since = { short_term: Date.now() - 28 * DAY, medium_term: Date.now() - 182 * DAY, long_term: 0 }[range];
      const agg = new Map();
      for (const p of between(since, Infinity)) {
        const k = type === 'artists' ? p.artist : p.nk;
        const e = agg.get(k) || { name: type === 'artists' ? p.artist : p.track, sub: type === 'artists' ? null : p.artist, image: null, url: null, score: 0 };
        e.score += p.ms;
        agg.set(k, e);
      }
      return [...agg.values()].sort((a, b) => b.score - a.score).slice(0, 20);
    },
  };
}
