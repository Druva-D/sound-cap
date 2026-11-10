import * as db from '../../src/db.js';
import { exportBackup, importFiles } from '../../src/importer.js';
import { shareCapsule } from '../../src/share.js';
import { spotifySource } from '../../src/source-spotify.js';
import { DAY, nameKey } from '../../src/stats.js';

const tests = [];
const test = (name, check, todo) => tests.push({ name, check, todo });
const BASE_TIME = Date.parse('2024-03-01T12:00:00Z');
const OWNER = 'listener';

/** Empty storage owned by the test listener, as after a fresh sign-in. */
async function reset() {
  await db.clearAll();
  await db.setMeta('ownerId', OWNER);
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message);
}

function equal(actual, expected) {
  const result = JSON.stringify(actual);
  const wanted = JSON.stringify(expected);
  assert(result === wanted, `Expected ${wanted}, got ${result}`);
}

async function rejects(check, pattern) {
  try {
    await check();
  } catch (error) {
    assert(pattern.test(error.message), `Unexpected error: ${error.message}`);
    return;
  }
  throw new Error(`Expected an error matching ${pattern}`);
}

function play(id, ts = BASE_TIME, source = 'api', track = 'Signal') {
  const artist = 'Velvet Static';
  return { id, ts, ms: 120_000, track, artist, nk: nameKey(artist, track), source };
}

function jsonFile(data) {
  return new File([JSON.stringify(data)], 'history.json', { type: 'application/json' });
}

test('IndexedDB keeps same-source repeats and filters exact IDs and cross-source copies', async () => {
  await reset();
  const first = play('first');
  const repeat = play('repeat', BASE_TIME + 15_000);
  const boundary = play('import-at-30s', repeat.ts + 30_000, 'import');
  const outside = play('import-outside', repeat.ts + 30_001, 'import');
  equal((await db.addPlays([repeat, first, first], OWNER)).map(({ id }) => id), ['first', 'repeat']);
  equal((await db.addPlays([boundary, outside], OWNER)).map(({ id }) => id), ['import-outside']);
  equal((await db.playsBetween(first.ts, outside.ts)).map(({ id }) => id), ['first', 'repeat']);
  equal((await db.allPlays()).map(({ id }) => id), ['first', 'repeat', 'import-outside']);
});

test('concurrent sync and import deduplicate inside the same IndexedDB write transaction', async () => {
  await reset();
  const copies = await Promise.all([db.addPlays([play('synced')], OWNER), db.addPlays([play('imported', BASE_TIME + 2000, 'import')], OWNER)]);
  equal(copies.flat().length, 1);
  equal((await db.allPlays()).length, 1);
});

test('erasing listening history preserves the owner and lookup cache while disconnect removes both', async () => {
  await reset();
  await db.addPlays([play('first')], OWNER);
  await db.setMeta('ownerId', 'listener');
  await db.setMeta('lastSync', 123);
  await db.setMeta('lastPlayTs', BASE_TIME);
  await db.putLookup({ key: 'track', found: true });
  await db.clearHistory();
  equal(await db.allPlays(), []);
  equal(await db.getMeta('lastSync'), undefined);
  equal(await db.getMeta('lastPlayTs'), undefined);
  equal(await db.getMeta('ownerId'), 'listener');
  equal(await db.getLookup('track'), { key: 'track', found: true });

  await db.clearAll();
  equal(await db.getMeta('ownerId'), undefined);
  equal(await db.getLookup('track'), undefined);
});

test('storage protection handles existing persistence, denial, and unsupported browsers', async () => {
  let requested = 0;
  const storage = { persisted: async () => true, persist: async () => { requested++; return false; } };
  Object.defineProperty(navigator, 'storage', { configurable: true, value: storage });
  try {
    equal(await db.isPersisted(), true);
    equal(await db.requestPersist(), true);
    equal(requested, 0);
    storage.persisted = async () => false;
    equal(await db.isPersisted(), false);
    equal(await db.requestPersist(), false);
    equal(requested, 1);
    storage.persisted = async () => { throw new Error('unavailable'); };
    equal(await db.isPersisted(), false);
    equal(await db.requestPersist(), false);
    Object.defineProperty(navigator, 'storage', { value: undefined });
    equal(await db.requestPersist(), false);
  } finally {
    delete navigator.storage;
  }
});

test('writes that finish after a disconnect, or for another account, are rejected without saving anything', async () => {
  await reset();
  await db.clearAll(); // "Disconnect and delete my data" while a sync is still in flight
  await rejects(() => db.addPlays([play('late-sync')], OWNER), /different session/);
  await rejects(() => db.setOwnedMeta('lastSync', 1, OWNER), /different session/);
  equal(await db.countPlays(), 0);
  equal(await db.getMeta('lastSync'), undefined);
  await db.setMeta('ownerId', 'someone-else');
  await rejects(() => db.addPlays([play('wrong-account')], OWNER), /different session/);
  equal(await db.countPlays(), 0);
});

test('ZIP import reads stored extended history and deflated account history and skips unrelated files', async () => {
  await reset();
  const fixture = await fetch(new URL('spotify-history.zip', import.meta.url));
  assert(fixture.ok, 'ZIP fixture unavailable');
  const file = new File([await fixture.arrayBuffer()], 'Spotify.zip', { type: 'application/zip' });
  const progress = [];
  const result = await importFiles([file], (message) => progress.push(message), OWNER);
  equal(result.found, 2);
  equal(result.added.map(({ track, artist, trackId, ts, ms }) => [track, artist, trackId, ts, ms]), [
    ['Signal', 'Velvet Static', 'fixture-track', BASE_TIME, 47_000],
    ['Blue', 'Moon Harbor', null, BASE_TIME + 60_000, 89_000],
  ]);
  assert(progress[0].startsWith('Reading Spotify.zip'));
  assert(progress[1].startsWith('Saving'));
  const repeat = await importFiles([file], undefined, OWNER);
  equal([repeat.found, repeat.added.length], [2, 0]);
});

test('invalid JSON, unreadable ZIP and unsupported history get useful errors without saving anything', async () => {
  await reset();
  await rejects(() => importFiles([new File(['{'], 'bad.json')]), /bad\.json isn't valid JSON/);
  await rejects(() => importFiles([new File(['not a ZIP'], 'bad.zip')]), /bad\.zip isn't a readable zip/);
  await rejects(() => importFiles([jsonFile([{ unrelated: true }])], undefined, OWNER), /Couldn't find any listening history/);
  equal(await db.allPlays(), []);
});

test('a malformed account-history row leaves valid rows in the same import usable', async () => {
  await reset();
  const valid = { endTime: '2024-03-01 12:00', msPlayed: 42_000, artistName: 'Velvet Static', trackName: 'Signal' };
  const file = jsonFile([{ ...valid, endTime: 123 }, valid]);
  const { found, added } = await importFiles([file], undefined, OWNER);
  equal([found, added.length], [1, 1]);
});

async function captureDownload(action) {
  const click = HTMLAnchorElement.prototype.click;
  const createObjectURL = URL.createObjectURL;
  const blobs = new Map();
  let download;
  HTMLAnchorElement.prototype.click = function () { download = { url: this.href, name: this.download }; };
  URL.createObjectURL = (blob) => {
    const url = createObjectURL(blob);
    blobs.set(url, blob);
    return url;
  };
  try {
    const result = await action();
    assert(download, 'No download was requested');
    const blob = blobs.get(download.url);
    assert(blob, 'The download did not reference a generated Blob');
    return { name: download.name, result, blob };
  } finally {
    HTMLAnchorElement.prototype.click = click;
    URL.createObjectURL = createObjectURL;
    for (const url of blobs.keys()) URL.revokeObjectURL(url);
  }
}

test('a ZIP that inflates past the size limit is rejected while decompressing, without saving anything', async () => {
  await reset();
  const fixture = await fetch(new URL('oversized-history.zip', import.meta.url));
  const file = new File([await fixture.blob()], 'oversized-history.zip', { type: 'application/zip' });
  assert(file.size < 1024 * 1024, 'fixture is small on disk');
  await rejects(() => importFiles([file], undefined, OWNER), /larger than Soundcap can safely import/);
  equal(await db.countPlays(), 0);
});

test('backup export downloads JSON that restores plays and source metadata after clearing storage', async () => {
  await reset();
  await db.addPlays([{ ...play('backup'), image: 'https://example.com/art.png' }], OWNER);
  const backup = await captureDownload(exportBackup);
  equal(backup.result, 1);
  equal(backup.blob.type, 'application/json');
  assert(/^soundcap-backup-\d{4}-\d{2}-\d{2}\.json$/.test(backup.name));
  const json = JSON.parse(await backup.blob.text());
  equal([json.soundcap, json.plays[0].id], [1, 'backup']);

  await reset();
  equal((await importFiles([new File([backup.blob], backup.name)], undefined, OWNER)).added.length, 1);
  const [restored] = await db.allPlays();
  equal([restored.id, restored.source, restored.image, restored.nk], ['backup', 'api', 'https://example.com/art.png', nameKey('Velvet Static', 'Signal')]);
});

test('Spotify sync stores normalized plays, detects a full-page gap and deduplicates a second sync', async () => {
  await reset();
  const original = window.fetch;
  localStorage.setItem('sc.token', JSON.stringify({ access: 'fixture-access', refresh: 'fixture-refresh', expiresAt: Date.now() + DAY }));
  const tracks = Array.from({ length: 50 }, (_, i) => ({
    played_at: new Date(BASE_TIME + i * 60_000).toISOString(),
    track: {
      id: 'fixture-track', name: 'Signal', duration_ms: 120_000,
      artists: [{ id: 'fixture-artist', name: 'Velvet Static' }],
      album: { name: 'First Album', images: [{ width: 640, url: 'big' }, { width: 160, url: 'cover' }] },
    },
  }));
  let items = tracks.toReversed();
  const calls = [];
  window.fetch = async (url, options) => {
    calls.push(new URL(url).pathname);
    equal(options.headers.Authorization, 'Bearer fixture-access');
    if (url.endsWith('/me')) return Response.json({ id: 'listener' });
    if (url.endsWith('/artists/fixture-artist')) return Response.json({ id: 'fixture-artist', genres: ['dream pop'] });
    if (url.includes('/me/top/tracks?')) return Response.json({ items: [tracks[0].track] });
    if (url.endsWith('/recently-played?limit=50')) return Response.json({ items });
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    await db.setMeta('lastPlayTs', BASE_TIME - 1);
    const spotify = spotifySource();
    spotify.setOwner(OWNER);
    equal(await spotify.me(), { id: 'listener', name: 'listener', image: null });
    const first = await spotify.sync();
    equal([first.added.length, first.gap], [50, true]);
    const { ts, ms, album, artistId, image, nk } = first.added[0];
    equal([ts, ms, album, artistId, image, nk], [BASE_TIME, 120_000, 'First Album', 'fixture-artist', 'cover', 'velvet static|signal']);
    equal(await spotify.sync(), { added: [], gap: false });
    const newest = BASE_TIME + 49 * 60_000;
    equal(await db.getMeta('lastPlayTs'), newest);
    items = [];
    equal(await spotify.sync(), { added: [], gap: false });
    equal(await db.getMeta('lastPlayTs'), newest);
    equal((await spotify.summary()).count, 50);
    assert(Number.isFinite(await spotify.lastSync()));

    equal((await spotify.artistInfo('Velvet Static', 'fixture-artist')).genres, ['dream pop']);
    equal((await spotify.artistInfo('  VÉLVET STATIC  ')).id, 'fixture-artist');
    equal(calls.filter((path) => path.startsWith('/v1/artists')).length, 1);
    const [rank] = await spotify.top('tracks', 'short_term');
    equal([rank.name, rank.sub, rank.image], ['Signal', 'Velvet Static', 'cover']);
  } finally {
    window.fetch = original;
    localStorage.removeItem('sc.token');
  }
});

test('share draws a 1080 × 1920 PNG for native sharing and download', async () => {
  const stats = {
    totalMs: 180_000, persona: 'night', topArtists: [{ name: 'Velvet Static' }],
    topTracks: [{ track: 'A long title '.repeat(30), artist: 'Velvet Static' }],
  };
  let shared;
  Object.defineProperties(navigator, {
    canShare: { configurable: true, value: ({ files }) => files.length === 1 },
    share: { configurable: true, value: async (data) => { shared = data; } },
  });
  try {
    await shareCapsule(stats, 'Last 7 days');
    equal(shared.title, 'My listening capsule');
    equal([shared.files[0].name, shared.files[0].type], ['soundcap.png', 'image/png']);

    Object.defineProperty(navigator, 'canShare', { value: () => false });
    const download = await captureDownload(() => shareCapsule(stats, 'Last 7 days'));
    equal([download.name, download.blob.type], ['soundcap.png', 'image/png']);
    const bitmap = await createImageBitmap(download.blob);
    equal([bitmap.width, bitmap.height], [1080, 1920]);
    bitmap.close();
  } finally {
    delete navigator.canShare;
    delete navigator.share;
  }
});

async function until(check, message) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

test('welcome validates the Client ID and demo supports period, ranking and settings navigation', async () => {
  await until(() => document.querySelector('.welcome-form'), 'Welcome form did not render');
  const ownApp = document.querySelector('details.own-app');
  if (ownApp) {
    equal(ownApp.open, false);
    ownApp.querySelector('summary').click();
    equal(ownApp.open, true);
  }
  document.querySelector('#client-id').value = 'invalid';
  document.querySelector('.welcome-form').requestSubmit();
  assert(document.querySelector('#toast').textContent.includes('Client ID'));

  const frame = document.createElement('iframe');
  frame.src = '/?demo';
  document.body.append(frame);
  const select = (selector) => frame.contentDocument?.querySelector(selector);
  try {
    await until(() => select('.capsule-head h1'), 'Demo capsule did not render');
    assert(select('.demo-bar').textContent.includes('demo data'));
    equal(select('.chip[aria-pressed="true"]').textContent, 'Last 7 days');
    const previousMonth = '.chip:nth-child(3)';
    select(previousMonth).click();
    equal(select(previousMonth).getAttribute('aria-pressed'), 'true');
    await until(() => select('.hero .kicker')?.textContent === select(previousMonth).textContent, 'Monthly capsule did not render');

    select('[role="tab"]:last-child').click();
    equal(select('[role="tab"][aria-selected="true"]').textContent, 'All time');
    await until(() => select('.track-list li'), 'Demo rankings did not render');

    select('[aria-label="Settings"]').click();
    assert(select('dialog[open]').textContent.includes('You’re exploring demo data.'));
    select('dialog [aria-label="Close"]').click();
    equal(select('dialog[open]'), null);
  } finally {
    frame.remove();
    localStorage.removeItem('sc.demo');
  }
});

test('the real service worker registers and precaches the app', async () => {
  const registration = await navigator.serviceWorker.ready;
  assert(registration.active.scriptURL.endsWith('/sw.js'));
  await until(() => navigator.serviceWorker.controller, 'Service worker did not claim the page');
  const shell = await caches.match('/index.html');
  assert((await shell.text()).includes('<title>Soundcap</title>'));
  assert((await caches.match('/src/main.js'))?.ok, 'App module missing from Cache Storage');
  assert((await caches.match('/privacy.html'))?.ok, 'Privacy policy missing from Cache Storage');
});

export async function run() {
  const results = [];
  for (const { name, check, todo } of tests) {
    try {
      await check();
      results.push({ name, todo });
    } catch (error) {
      results.push({ name, todo, error: error.stack || String(error) });
    }
  }
  return results;
}
