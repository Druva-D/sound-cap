// Spotify Authorization Code flow with PKCE — no client secret, no server.
import { DEFAULT_CLIENT_ID, SCOPES } from './config.js';

const LS = { client: 'sc.clientId', token: 'sc.token', verifier: 'sc.verifier', state: 'sc.state' };

export const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
export const getClientId = () => localStorage.getItem(LS.client) || DEFAULT_CLIENT_ID;
export const setClientId = (id) => localStorage.setItem(LS.client, id.trim());
export const clearClientId = () => localStorage.removeItem(LS.client);
export const hasBuiltInClientId = () => !!DEFAULT_CLIENT_ID;
export const usingOwnClientId = () => !!localStorage.getItem(LS.client) && localStorage.getItem(LS.client) !== DEFAULT_CLIENT_ID;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomString(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

const readToken = () => {
  try { return JSON.parse(localStorage.getItem(LS.token)); } catch { return null; }
};
const saveToken = (t) => localStorage.setItem(LS.token, JSON.stringify(t));

export const isLoggedIn = () => !!readToken()?.refresh;
export const logout = () => localStorage.removeItem(LS.token);

/**
 * Every login gets a random session id. Work that started under one session (a token refresh,
 * an API call, a sync) must not write anything once that session has ended — e.g. after
 * "Disconnect" in this or another tab.
 */
export const sessionId = () => readToken()?.sid ?? null;
export class SessionEndedError extends Error {
  constructor() { super('Signed out'); this.name = 'SessionEndedError'; }
}

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new Error('Add your Spotify Client ID first.');
  const verifier = randomString(64);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  localStorage.setItem(LS.verifier, verifier);
  localStorage.setItem(LS.state, state);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    redirect_uri: redirectUri(),
    state,
  });
  location.assign(`https://accounts.spotify.com/authorize?${params}`);
}

/** Completes the login if we're on the redirect back from Spotify. Returns true if it did. */
export async function handleCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return false;
  history.replaceState(null, '', redirectUri());
  const verifier = localStorage.getItem(LS.verifier);
  const expected = localStorage.getItem(LS.state);
  localStorage.removeItem(LS.verifier);
  localStorage.removeItem(LS.state);
  if (p.has('error')) {
    throw new Error(p.get('error') === 'access_denied' ? 'Spotify access was declined.' : `Spotify login failed: ${p.get('error')}`);
  }
  if (!verifier || p.get('state') !== expected) throw new Error('Login expired or was interrupted. Please try again.');
  await tokenRequest({ newSession: true }, {
    grant_type: 'authorization_code',
    code: p.get('code'),
    redirect_uri: redirectUri(),
    client_id: getClientId(),
    code_verifier: verifier,
  });
  return true;
}

async function tokenRequest({ newSession = false, expectSid } = {}, params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description || j.error || `Token request failed (${r.status})`);
    e.code = j.error;
    e.status = r.status;
    throw e;
  }
  const prev = readToken();
  // A refresh that finishes after the user signed out (or signed in again) must not resurrect the old session.
  if (!newSession && (!prev || prev.sid !== expectSid)) throw new SessionEndedError();
  saveToken({
    sid: newSession ? randomString(12) : expectSid,
    access: j.access_token,
    refresh: j.refresh_token || prev?.refresh,
    expiresAt: Date.now() + (j.expires_in - 60) * 1000,
  });
}

let refreshing = null;

export async function getAccessToken(force = false) {
  let t = readToken();
  if (!t) return null;
  if (!t.sid) saveToken((t = { ...t, sid: randomString(12) })); // sessions saved before session ids existed
  if (!force && t.expiresAt > Date.now()) return t.access;
  refreshing ??= tokenRequest({ expectSid: t.sid }, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: getClientId() })
    .finally(() => { refreshing = null; });
  try {
    await refreshing;
  } catch (e) {
    const now = readToken();
    // Another tab may have refreshed first (Spotify rotates refresh tokens); use its fresh token.
    if (now && now.sid === t.sid && now.refresh !== t.refresh && now.expiresAt > Date.now()) return now.access;
    if ((e.code === 'invalid_grant' || e.code === 'invalid_client') && now?.sid === t.sid) logout();
    throw e;
  }
  const now = readToken();
  if (!now || now.sid !== t.sid) throw new SessionEndedError();
  return now.access;
}
