export const DAY = 86_400_000;
export const STREAM_MS = 30_000; // Spotify counts a play as a stream after 30s

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const monthKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
export const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
export const nameKey = (artist, track) => `${norm(artist)}|${norm(track)}`;
export const playStart = (p) => p.ts - p.ms;

export function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; }
export function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d; }

/** period is 'week' (last 7 days) or 'YYYY-MM'. */
export function periodRange(period, now = Date.now()) {
  if (period === 'week') {
    const end = addDays(startOfDay(now), 1);
    return { start: +addDays(end, -7), end: +end, kind: 'week' };
  }
  const [y, m] = period.split('-').map(Number);
  return { start: +new Date(y, m - 1, 1), end: +new Date(y, m, 1), kind: 'month' };
}

export function previousRange(period, now = Date.now()) {
  if (period === 'week') {
    const r = periodRange('week', now);
    return { start: +addDays(r.start, -7), end: r.start, kind: 'week' };
  }
  const [y, m] = period.split('-').map(Number);
  return periodRange(monthKey(new Date(y, m - 2, 1)));
}

export const emptySummary = () => ({ count: 0, earliest: null, latest: null, months: new Set(), firstSeen: new Map() });

export function mergeSummary(sum, plays) {
  for (const p of plays) {
    const s = playStart(p);
    sum.count++;
    if (sum.earliest == null || s < sum.earliest) sum.earliest = s;
    if (sum.latest == null || s > sum.latest) sum.latest = s;
    sum.months.add(monthKey(s));
    const f = sum.firstSeen.get(p.artist);
    if (f == null || s < f) sum.firstSeen.set(p.artist, s);
  }
  return sum;
}

const PERSONA_HOURS = {
  morning: [5, 6, 7, 8, 9, 10, 11],
  afternoon: [12, 13, 14, 15, 16],
  evening: [17, 18, 19, 20, 21],
  night: [22, 23, 0, 1, 2, 3, 4],
};

export function computeStats(plays, range, summary = null) {
  const now = Date.now();
  const days = [];
  for (let d = new Date(range.start); +d < range.end; d = addDays(d, 1)) {
    days.push({ key: dayKey(d), date: new Date(d), ms: 0, future: +d > now });
  }
  const dayIdx = new Map(days.map((d, i) => [d.key, i]));
  const hours = new Array(24).fill(0);
  const tracks = new Map();
  const artists = new Map();
  const dayTrack = new Map();
  let totalMs = 0;
  let streams = 0;

  for (const p of plays) {
    const start = playStart(p);
    if (start < range.start || start >= range.end) continue;
    const i = dayIdx.get(dayKey(start));
    if (i == null) continue;
    totalMs += p.ms;
    days[i].ms += p.ms;
    hours[new Date(start).getHours()] += p.ms;

    let a = artists.get(p.artist);
    if (!a) artists.set(p.artist, (a = { name: p.artist, artistId: null, ms: 0, count: 0 }));
    a.ms += p.ms;
    a.artistId ||= p.artistId;

    if (p.ms < STREAM_MS) continue;
    streams++;
    a.count++;
    let t = tracks.get(p.nk);
    if (!t) tracks.set(p.nk, (t = { nk: p.nk, track: p.track, artist: p.artist, trackId: null, image: null, count: 0, ms: 0 }));
    t.count++;
    t.ms += p.ms;
    t.image ||= p.image;
    t.trackId ||= p.trackId;
    const k = `${i}|${p.nk}`;
    dayTrack.set(k, (dayTrack.get(k) || 0) + 1);
  }

  const past = days.filter((d) => !d.future);
  let longestStreak = 0;
  let run = 0;
  for (const d of past) {
    run = d.ms > 0 ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }
  const biggest = days.reduce((m, d) => (d.ms > (m?.ms ?? 0) ? d : m), null);
  const peakHour = hours.indexOf(Math.max(...hours));
  const buckets = Object.entries(PERSONA_HOURS).map(([key, hs]) => ({ key, ms: hs.reduce((s, h) => s + hours[h], 0) }));
  const persona = buckets.sort((a, b) => b.ms - a.ms)[0].key;

  let onRepeat = null;
  for (const [k, count] of dayTrack) {
    if (!onRepeat || count > onRepeat.count) {
      const [i, nk] = [Number(k.slice(0, k.indexOf('|'))), k.slice(k.indexOf('|') + 1)];
      onRepeat = { count, date: days[i].date, track: tracks.get(nk) };
    }
  }

  const topArtists = [...artists.values()].sort((a, b) => b.ms - a.ms);
  let newArtists = null;
  if (summary?.earliest != null && summary.earliest <= range.start - 7 * DAY) {
    newArtists = topArtists.filter((a) => {
      const f = summary.firstSeen.get(a.name);
      return f != null && f >= range.start && f < range.end;
    });
  }

  return {
    range,
    totalMs,
    streams,
    days,
    elapsed: past.length,
    activeDays: past.filter((d) => d.ms > 0).length,
    longestStreak,
    biggest: biggest?.ms ? biggest : null,
    hours,
    peakHour,
    persona,
    topTracks: [...tracks.values()].sort((a, b) => b.count - a.count || b.ms - a.ms),
    topArtists,
    uniqueTracks: tracks.size,
    uniqueArtists: artists.size,
    onRepeat,
    newArtists,
  };
}
