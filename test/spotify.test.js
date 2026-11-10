import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { initAnalytics } from '../src/analytics.js';
import { api, AuthError, pickImage } from '../src/api.js';
import * as auth from '../src/auth.js';
import { DEFAULT_CLIENT_ID, GA_MEASUREMENT_ID, GTM_CONTAINER_ID, SCOPES } from '../src/config.js';

const NOW = 1_710_000_000_000;
const ORIGIN = 'http://127.0.0.1:5173';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

function globalForTest(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}

function browser(t) {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  const location = { origin: ORIGIN, pathname: '/app/index.html', search: '', assign: t.mock.fn() };
  const history = { replaceState: t.mock.fn() };
  globalForTest(t, 'localStorage', storage);
  globalForTest(t, 'location', location);
  globalForTest(t, 'history', history);
  t.mock.method(Date, 'now', () => NOW);
  auth.setClientId('  fixture-client  ');
  return {
    storage, location, history,
    setToken: (overrides) => storage.setItem('sc.token', JSON.stringify({ access: 'old-access', refresh: 'fixture-refresh', expiresAt: NOW + 1000, ...overrides })),
    getToken: () => JSON.parse(storage.getItem('sc.token')),
  };
}

test('Spotify login creates a PKCE challenge and exchanges a matching callback once', async (t) => {
  const { storage, location, history, getToken } = browser(t);
  await auth.login();
  const url = new URL(location.assign.mock.calls[0].arguments[0]);
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  const verifier = storage.getItem('sc.verifier');
  const state = storage.getItem('sc.state');
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(state, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: 'code', client_id: 'fixture-client', scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    redirect_uri: `${ORIGIN}/app/`, state,
  });

  location.search = `?code=fixture-code&state=${state}`;
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }));
  assert.equal(await auth.handleCallback(), true);
  assert.deepEqual(history.replaceState.mock.calls[0].arguments, [null, '', `${ORIGIN}/app/`]);
  const [tokenUrl, options] = fetch.mock.calls[0].arguments;
  assert.equal(tokenUrl, TOKEN_URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(options.body), {
    grant_type: 'authorization_code', code: 'fixture-code', client_id: 'fixture-client',
    redirect_uri: `${ORIGIN}/app/`, code_verifier: verifier,
  });
  assert.equal(storage.getItem('sc.verifier'), null);
  assert.equal(storage.getItem('sc.state'), null);
  const { sid, ...token } = getToken();
  assert.deepEqual(token, { access: 'access', refresh: 'refresh', expiresAt: NOW + 3_540_000 });
  assert.match(sid, /^[\w-]{16}$/, 'each login gets a random session id');
  assert.equal(auth.isLoggedIn(), true);
  assert.equal(await auth.getAccessToken(), 'access');
  assert.equal(fetch.mock.callCount(), 1);
});

test('callback ignores ordinary visits and rejects a state mismatch or declined login', async (t) => {
  const { storage, location, history } = browser(t);
  const fetch = t.mock.method(globalThis, 'fetch');
  location.search = '?demo';
  assert.equal(await auth.handleCallback(), false);
  assert.equal(history.replaceState.mock.callCount(), 0);

  await auth.login();
  location.search = '?code=fixture-code&state=wrong';
  await assert.rejects(auth.handleCallback(), /Login expired/);
  assert.equal(storage.getItem('sc.state'), null);
  assert.equal(storage.getItem('sc.verifier'), null);
  location.search = '?error=access_denied';
  await assert.rejects(auth.handleCallback(), /access was declined/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(history.replaceState.mock.callCount(), 2);
});

test('an entered Client ID overrides the built-in app and clearing it restores the default', async (t) => {
  browser(t);
  assert.equal(auth.hasBuiltInClientId(), Boolean(DEFAULT_CLIENT_ID));
  assert.equal(auth.usingOwnClientId(), true);
  assert.equal(auth.getClientId(), 'fixture-client');
  auth.clearClientId();
  assert.equal(auth.getClientId(), DEFAULT_CLIENT_ID);
  assert.equal(auth.usingOwnClientId(), false);
  if (!auth.getClientId()) await assert.rejects(auth.login(), /Add your Spotify Client ID/);
});

test('simultaneous token refreshes coalesce and retain the refresh token Spotify omits', async (t) => {
  const { setToken, getToken } = browser(t);
  setToken({ expiresAt: NOW });
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'new-access', expires_in: 3600 }));
  assert.deepEqual(await Promise.all([auth.getAccessToken(), auth.getAccessToken(true)]), ['new-access', 'new-access']);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, { body }] = fetch.mock.calls[0].arguments;
  assert.equal(url, TOKEN_URL);
  assert.deepEqual(Object.fromEntries(body), { grant_type: 'refresh_token', refresh_token: 'fixture-refresh', client_id: 'fixture-client' });
  assert.equal(getToken().refresh, 'fixture-refresh');
});

test('invalid grants sign out while a transient refresh error leaves the session retryable', async (t) => {
  const { setToken, getToken, storage } = browser(t);
  storage.setItem('sc.token', '{bad json');
  assert.equal(await auth.getAccessToken(), null);
  setToken({ expiresAt: NOW });
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'server_error' }, { status: 503 }));
  await assert.rejects(auth.getAccessToken(), { code: 'server_error', status: 503 });
  assert.equal(auth.isLoggedIn(), true);
  fetch.mock.mockImplementation(async () => Response.json({ error: 'invalid_grant', error_description: 'Expired grant' }, { status: 400 }));
  await assert.rejects(auth.getAccessToken(), { message: 'Expired grant', code: 'invalid_grant' });
  assert.equal(getToken(), null);
  assert.equal(auth.isLoggedIn(), false);
});

test('API sends bearer tokens, refreshes on an initial 401 and handles an empty response', async (t) => {
  const { setToken } = browser(t);
  const urls = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url);
    if (url === TOKEN_URL) return Response.json({ access_token: 'new-access', expires_in: 3600 });
    if (options.headers.Authorization === 'Bearer old-access') return new Response(null, { status: 401 });
    assert.equal(options.headers.Authorization, 'Bearer new-access');
    return new Response(null, { status: 204 });
  });
  await assert.rejects(api('/me'), AuthError);
  assert.equal(fetch.mock.callCount(), 0);
  setToken();
  assert.equal(await api('/me'), null);
  assert.deepEqual(urls, ['https://api.spotify.com/v1/me', TOKEN_URL, 'https://api.spotify.com/v1/me']);
});

function skipRetryDelays(t) {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { delays.push(delay); queueMicrotask(fn); });
  return delays;
}

test('API retries rate limiting and server errors with bounded delays and surfaces Spotify errors', async (t) => {
  browser(t).setToken();
  const delays = skipRetryDelays(t);
  const responses = [
    new Response(null, { status: 429, headers: { 'Retry-After': '45' } }),
    new Response(null, { status: 503 }),
    Response.json({ items: [] }),
    Response.json({ error: { message: 'Forbidden by Spotify' } }, { status: 403 }),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  assert.deepEqual(await api('/me'), { items: [] });
  assert.deepEqual(delays, [30_000, 2_000]);
  await assert.rejects(api('/me'), { message: 'Forbidden by Spotify', status: 403 });
});

test('API caps concurrency and starts the queued request after a failed request settles', async (t) => {
  browser(t).setToken();
  const respond = [];
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => respond.push(resolve)));
  const requests = Array.from({ length: 5 }, (_, i) => api(`/track/${i}`));
  const results = Promise.allSettled(requests);
  await new Promise(setImmediate);
  assert.equal(respond.length, 4);
  respond[0](new Response('forbidden', { status: 403 }));
  await new Promise(setImmediate);
  assert.equal(respond.length, 5);
  respond.slice(1).forEach((resolve) => resolve(Response.json({ ok: true })));
  assert.deepEqual((await results).map((result) => result.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
});

test('API still refreshes once if its first 401 follows a transient error', async (t) => {
  browser(t).setToken();
  skipRetryDelays(t);
  const responses = [
    new Response(null, { status: 503 }),
    new Response(null, { status: 401 }),
    Response.json({ access_token: 'new-access', expires_in: 3600 }),
    Response.json({ id: 'listener' }),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  assert.deepEqual(await api('/me'), { id: 'listener' });
});

test('image picking uses the smallest suitable image and preserves the supplied order', () => {
  const images = [{ width: 640, url: 'large' }, { width: 64, url: 'small' }, { width: 300, url: 'medium' }];
  assert.equal(pickImage(images), 'medium');
  assert.equal(pickImage(images, 640), 'large');
  assert.equal(pickImage(images, 1200), 'large');
  assert.equal(pickImage([]), null);
  assert.deepEqual(images.map(({ url }) => url), ['large', 'small', 'medium']);
});

test('analytics honors both browser privacy signals and initializes the configured container otherwise', (t) => {
  const scripts = [];
  const window = {};
  const navigator = { doNotTrack: '1', globalPrivacyControl: false };
  globalForTest(t, 'navigator', navigator);
  globalForTest(t, 'window', window);
  globalForTest(t, 'document', { createElement: () => ({}), head: { append: (script) => scripts.push(script) } });
  initAnalytics();
  navigator.doNotTrack = '0';
  navigator.globalPrivacyControl = true;
  initAnalytics();
  assert.equal(scripts.length, 0);
  assert.equal(window.dataLayer, undefined);

  navigator.globalPrivacyControl = false;
  const expected = [];
  const gtm = GTM_CONTAINER_ID.trim();
  const ga = GA_MEASUREMENT_ID.trim();
  if (/^GTM-[A-Z0-9]+$/i.test(gtm)) expected.push(`https://www.googletagmanager.com/gtm.js?id=${gtm}`);
  if (/^G-[A-Z0-9]+$/i.test(ga)) expected.push(`https://www.googletagmanager.com/gtag/js?id=${ga}`);
  initAnalytics();
  assert.deepEqual(scripts, expected.map((src) => ({ async: true, src })));
  if (expected.length) assert.equal(window.dataLayer[0][0], 'js');
});

test('signing out during a token refresh is not undone when the refresh finishes', async (t) => {
  const { storage, setToken } = browser(t);
  setToken({ sid: 'session-a', expiresAt: NOW });
  let respond;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { respond = resolve; }));
  const pending = auth.getAccessToken();
  await new Promise((r) => setImmediate(r));
  auth.logout(); // e.g. "Disconnect" in this or another tab
  respond(Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 }));
  await assert.rejects(pending, auth.SessionEndedError);
  assert.equal(storage.getItem('sc.token'), null, 'the ended session stays ended');
  assert.equal(auth.isLoggedIn(), false);
});

test('a refresh that finishes after a new login does not overwrite the new session', async (t) => {
  const { setToken, getToken } = browser(t);
  setToken({ sid: 'session-a', expiresAt: NOW });
  let respond;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { respond = resolve; }));
  const pending = auth.getAccessToken();
  await new Promise((r) => setImmediate(r));
  setToken({ sid: 'session-b', access: 'b-access', refresh: 'b-refresh', expiresAt: NOW + 3_600_000 });
  respond(Response.json({ access_token: 'a-access', refresh_token: 'a-refresh', expires_in: 3600 }));
  await assert.rejects(pending, auth.SessionEndedError);
  assert.deepEqual(getToken(), { sid: 'session-b', access: 'b-access', refresh: 'b-refresh', expiresAt: NOW + 3_600_000 });
});

test('losing a refresh race to another tab uses its rotated token instead of signing out', async (t) => {
  const { setToken, getToken } = browser(t);
  setToken({ sid: 'session-a', expiresAt: NOW });
  t.mock.method(globalThis, 'fetch', async () => {
    // The other tab already rotated the refresh token, so ours is rejected.
    setToken({ sid: 'session-a', access: 'other-tab-access', refresh: 'rotated', expiresAt: NOW + 3_600_000 });
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  });
  assert.equal(await auth.getAccessToken(), 'other-tab-access');
  assert.equal(getToken().refresh, 'rotated', 'still signed in');
});

test('API responses that arrive after the session ended are discarded', async (t) => {
  const { setToken } = browser(t);
  setToken({ sid: 'session-a', access: 'live', expiresAt: NOW + 3_600_000 });
  t.mock.method(globalThis, 'fetch', async () => {
    auth.logout();
    return Response.json({ items: [{ secret: 'listening' }] });
  });
  await assert.rejects(api('/me/player/recently-played'), auth.SessionEndedError);
});
