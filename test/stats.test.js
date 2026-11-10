import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoSource } from '../src/source-demo.js';
import { addDays, computeStats, dayKey, emptySummary, mergeSummary, nameKey, periodRange, previousRange } from '../src/stats.js';
import { ago, hm, hourLabel, minutes, plural } from '../src/ui.js';

process.env.TZ = 'America/New_York';

const local = (day, hour = 0, minute = 0) => +new Date(2024, 2, day, hour, minute);
const NOW = local(13, 15);

function play(start, ms, track = 'Signal', artist = 'Velvet Static', details = {}) {
  return { ts: start + ms, ms, track, artist, nk: nameKey(artist, track), ...details };
}

test('week ranges use local calendar days across daylight saving time', () => {
  const week = periodRange('week', NOW);
  assert.deepEqual(week, { start: local(7), end: local(14), kind: 'week' });
  assert.equal((week.end - week.start) / 3_600_000, 167);
  const previous = previousRange('week', NOW);
  assert.equal(dayKey(previous.start), '2024-02-29');
  assert.equal(previous.end, week.start);
  assert.deepEqual(previousRange('2024-01'), {
    start: +new Date(2023, 11, 1), end: +new Date(2024, 0, 1), kind: 'month',
  });
  assert.equal(dayKey(periodRange('2024-02').end - 1), '2024-02-29');
});

test('summary uses play starts and updates the earliest artist and month across batches', () => {
  const sum = emptySummary();
  const first = play(local(0, 23, 59), 120_000);
  const second = play(local(1, 1), 60_000, 'Blue', 'Moon Harbor');
  const third = play(local(2), 30_000);
  assert.equal(mergeSummary(sum, [third]), sum);
  mergeSummary(sum, [second, first]);
  assert.equal(sum.count, 3);
  assert.equal(sum.earliest, local(0, 23, 59));
  assert.equal(sum.latest, local(2));
  assert.deepEqual([...sum.months].sort(), ['2024-02', '2024-03']);
  assert.equal(sum.firstSeen.get('Velvet Static'), local(0, 23, 59));
  assert.equal(nameKey('  VÉLVET\tStatic ', ' SiGnal '), first.nk);
});

test('stats assign plays by start time and separate listening duration from qualified streams', (t) => {
  t.mock.method(Date, 'now', () => local(14, 15));
  const range = periodRange('week', NOW);
  const plays = [
    play(range.start - 1, 240_000, 'Before'),
    play(range.start, 29_999, 'Short', 'Skip Artist'),
    play(local(7, 23, 59), 120_000),
    play(local(8, 23), 30_000),
    play(local(8, 23, 5), 45_000, 'Signal', 'Velvet Static', { trackId: 'track-id', artistId: 'artist-id', image: 'cover' }),
    play(local(8, 23, 8), 30_000),
    play(local(9, 9), 120_000, 'Blue', 'Moon Harbor'),
    play(local(13, 13), 30_000, 'Red', 'Moon Harbor'),
    play(local(13, 23, 59), 120_000),
    play(range.end, 240_000, 'After'),
  ];
  const stats = computeStats(plays, range);
  assert.deepEqual(stats.days.map(({ ms }) => ms), [149_999, 105_000, 120_000, 0, 0, 0, 150_000]);
  assert.equal(stats.totalMs, 524_999);
  assert.equal(stats.elapsed, 7);
  assert.equal(stats.activeDays, 4);
  assert.equal(stats.longestStreak, 3);
  assert.equal(stats.biggest.key, '2024-03-13');
  assert.equal(stats.streams, 7);
  assert.equal(stats.uniqueTracks, 3);
  assert.equal(stats.uniqueArtists, 3);
  assert.equal(stats.hours[23], 345_000);
  assert.equal(stats.peakHour, 23);
  assert.equal(stats.persona, 'night');
  assert.deepEqual(stats.topTracks.map(({ track, count }) => [track, count]), [['Signal', 5], ['Blue', 1], ['Red', 1]]);
  assert.deepEqual(stats.topArtists.map(({ name, ms, count }) => [name, ms, count]), [
    ['Velvet Static', 345_000, 5], ['Moon Harbor', 150_000, 2], ['Skip Artist', 29_999, 0],
  ]);
  assert.equal(stats.onRepeat.count, 3);
  assert.equal(dayKey(stats.onRepeat.date), '2024-03-08');
  assert.equal(stats.onRepeat.track.trackId, 'track-id');
  assert.equal(stats.onRepeat.track.image, 'cover');
});

test('monthly stats mark future days and require a week of history to show discoveries', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const month = periodRange('2024-03');
  const plays = [play(local(1, 9), 60_000), play(local(3, 9), 90_000, 'Blue', 'Moon Harbor')];
  const summary = mergeSummary(emptySummary(), plays);
  assert.equal(computeStats(plays, month, summary).newArtists, null);

  mergeSummary(summary, [play(+addDays(month.start, -8), 60_000)]);
  const stats = computeStats(plays, month, summary);
  assert.equal(stats.days.length, 31);
  assert.equal(stats.elapsed, 13);
  assert.equal(stats.days[12].future, false);
  assert.equal(stats.days[13].future, true);
  assert.deepEqual(stats.newArtists.map(({ name }) => name), ['Moon Harbor']);

  const empty = computeStats([], month);
  assert.equal(empty.totalMs, 0);
  assert.equal(empty.biggest, null);
  assert.equal(empty.onRepeat, null);
  assert.equal(empty.longestStreak, 0);
});

test('demo history is deterministic and serves bounded, ordered rankings without Spotify', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const demo = demoSource();
  const week = periodRange('week', NOW);
  const plays = await demo.playsBetween(week.start, week.end);
  assert.deepEqual(plays, await demoSource().playsBetween(week.start, week.end));
  assert.ok(plays.length > 0);
  assert.ok(plays.every((p, i) => p.source === 'demo' && p.ts <= NOW && (i === 0 || p.ts >= plays[i - 1].ts)));
  assert.equal((await demo.me()).name, 'Demo listener');
  assert.equal(demo.sync, null);
  assert.ok((await demo.summary()).count > plays.length);
  assert.ok((await demo.artistInfo(plays[0].artist)).genres.length > 0);
  assert.deepEqual((await demo.artistInfo('Unknown')).genres, []);

  for (const type of ['artists', 'tracks']) {
    const ranking = await demo.top(type, 'short_term');
    assert.equal(ranking.length, 20);
    assert.ok(ranking.every((p, i) => p.url === null && (i === 0 || p.score <= ranking[i - 1].score)));
    assert.equal(ranking[0].sub === null, type === 'artists');
  }
});

test('display formatters handle midnight, noon, rounding and relative dates', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  assert.deepEqual([hourLabel(0), hourLabel(12), hourLabel(23)], ['12am', '12pm', '11pm']);
  assert.deepEqual([minutes(29_999), minutes(30_000), hm(3_630_000)], [0, 1, '1h 1m']);
  assert.deepEqual([plural(1, 'day'), plural(2, 'day')], ['1 day', '2 days']);
  assert.equal(ago(NOW - 59_000), 'just now');
  assert.equal(ago(NOW - 90_000), '2m ago');
  assert.equal(ago(NOW - 7_200_000), '2h ago');
});
