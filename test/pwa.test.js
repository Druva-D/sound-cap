import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const ORIGIN = 'https://soundcap.example';

async function worker({ fetch, keys = [], match = async () => undefined } = {}) {
  const handlers = new Map();
  const calls = { cached: [], deleted: [], writes: [], matches: [], skipped: false, claimed: false };
  const cache = {
    addAll: async (paths) => { calls.cached.push(...paths); },
    match: async (request, options) => { calls.matches.push([request, options]); return match(request); },
    put: async (request, response) => { calls.writes.push([request, response]); },
  };
  runInNewContext(await read('sw.js'), {
    URL, Response, fetch, location: { origin: ORIGIN },
    caches: {
      open: async () => cache,
      keys: async () => keys,
      delete: async (key) => { calls.deleted.push(key); },
    },
    self: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: async () => { calls.skipped = true; },
      clients: { claim: async () => { calls.claimed = true; } },
    },
  });
  return {
    calls,
    lifecycle(name) {
      let result;
      handlers.get(name)({ waitUntil: (promise) => { result = promise; } });
      assert.ok(result, `${name} should wait for its cache operations`);
      return result;
    },
    request(request) {
      let result;
      handlers.get('fetch')({ request, respondWith: (promise) => { result = promise; } });
      return result;
    },
  };
}

const request = (path, options) => ({ url: new URL(path, ORIGIN).href, method: 'GET', mode: 'same-origin', ...options });

test('service worker precaches the app shell and takes control after activation', async () => {
  const sw = await worker();
  await sw.lifecycle('install');
  await sw.lifecycle('activate');
  assert.equal(sw.calls.skipped, true);
  assert.equal(sw.calls.claimed, true);
  for (const entry of ['index.html', 'privacy.html', 'styles.css', 'manifest.webmanifest', 'src/main.js', 'fonts/figtree-latin.woff2']) {
    assert.ok(sw.calls.cached.includes(entry), `missing offline asset ${entry}`);
  }
  await Promise.all(sw.calls.cached.map((path) => access(new URL(path, root))));
});

test('service worker caches successful first-party responses and ignores other origins and methods', async () => {
  const sw = await worker({ fetch: async ({ url }) => new Response(url, { status: url.endsWith('missing') ? 404 : 200 }) });
  assert.equal(sw.request(request('https://api.spotify.com/v1/me')), undefined);
  assert.equal(sw.request(request('/src/stats.js', { method: 'POST' })), undefined);
  const module = request('/src/stats.js');
  assert.equal(await (await sw.request(module)).text(), module.url);
  assert.equal((await sw.request(request('/missing'))).status, 404);
  assert.equal(sw.calls.writes.length, 1);
  assert.equal(sw.calls.writes[0][0], module);
  assert.equal(await sw.calls.writes[0][1].text(), module.url);
});

test('offline navigation ignores query strings and falls back to the app shell', async () => {
  const sw = await worker({
    fetch: async () => { throw new TypeError('offline'); },
    match: async (req) => req === 'index.html' ? new Response('offline app') : undefined,
  });
  const navigation = request('/?demo', { mode: 'navigate' });
  assert.equal(await (await sw.request(navigation)).text(), 'offline app');
  assert.equal(sw.calls.matches[0][0], navigation);
  assert.equal(sw.calls.matches[0][1].ignoreSearch, true);
  assert.equal((await sw.request(request('/missing.js'))).type, 'error');
  assert.equal(sw.calls.matches.at(-1)[1].ignoreSearch, false);
});

test('service worker activation leaves unrelated same-origin caches intact', async () => {
  const sw = await worker({ keys: ['soundcap-v3', 'other-app-cache'] });
  await sw.lifecycle('activate');
  assert.deepEqual(sw.calls.deleted, ['soundcap-v3']);
});

test('manifest, HTML and CSS point to real install assets with matching icon dimensions', async () => {
  const [html, css, manifestText] = await Promise.all([read('index.html'), read('styles.css'), read('manifest.webmanifest')]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(({ purpose }) => purpose === 'maskable'));

  const references = [...html.matchAll(/(?:href|src)="([^"]+\.(?:js|css|woff2|webmanifest|png|svg))"/g), ...css.matchAll(/url\((fonts\/[^)]+)\)/g)];
  await Promise.all(references.map(([, path]) => access(new URL(path, root))));
  for (const { src, sizes, type } of manifest.icons) {
    const data = await readFile(new URL(src, root));
    if (type === 'image/png') {
      assert.equal(data.subarray(1, 4).toString(), 'PNG');
      assert.equal(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`, sizes);
    }
  }
});

test('deployment configurations use matching CSP and service worker cache headers', async () => {
  const [html, netlify, vercelText] = await Promise.all([read('index.html'), read('netlify.toml'), read('vercel.json')]);
  const vercel = JSON.parse(vercelText);
  const policy = vercel.headers[0].headers.find(({ key }) => key === 'Content-Security-Policy').value;
  assert.equal(netlify.match(/Content-Security-Policy = "([^"]+)"/)[1], policy);
  const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.equal(policy, `${meta}; frame-ancestors 'none'`);
  assert.match(netlify, /for = "\/sw\.js"\s+\[headers\.values\]\s+Cache-Control = "no-cache"/);
  assert.deepEqual(vercel.headers.find(({ source }) => source === '/sw.js').headers, [{ key: 'Cache-Control', value: 'no-cache' }]);
});

test('onboarding, settings and the footer link to the privacy policy', async () => {
  const app = await read('src/main.js');
  const targets = [...app.matchAll(/href: '([^']+)'\s*}, 'Privacy policy'/g)].map(([, href]) => href);
  assert.ok(targets.length >= 3);
  for (const path of new Set(targets)) assert.match(await read(path), /<h1>Privacy policy<\/h1>/);
});
