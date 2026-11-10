import { h, setChildren, icon, logoMark, spotifyIcon, art, toast, fmtInt, minutes, hm, plural, fmtDate, fmtDay, hourLabel, ago } from './ui.js';
import * as auth from './auth.js';
import * as db from './db.js';
import { AuthError } from './api.js';
import { SessionEndedError } from './auth.js';
import { OwnerMismatchError } from './db.js';
import { spotifySource } from './source-spotify.js';
import { demoSource } from './source-demo.js';
import { computeStats, periodRange, previousRange, monthKey, mergeSummary, DAY } from './stats.js';
import { exportBackup } from './importer.js';
import { shareCapsule } from './share.js';
import { PERSONAS } from './personas.js';
import { initAnalytics } from './analytics.js';

const app = document.getElementById('app');
const state = { period: 'week', topRange: 'short_term', summary: null, stats: null, renderId: 0, lastSync: null, syncing: false };
const shell = {};
let source = null;

// ───────────────────────────── boot ─────────────────────────────

function watchSessionAcrossTabs() {
  const sid = (v) => { try { return JSON.parse(v)?.sid ?? null; } catch { return null; } };
  window.addEventListener('storage', (e) => {
    if (e.key === null || (e.key === 'sc.token' && sid(e.oldValue) !== sid(e.newValue))) location.reload();
  });
}

async function boot() {
  watchSessionAcrossTabs();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    await auth.handleCallback();
  } catch (e) {
    toast(e.message, 'error');
  }
  if (new URLSearchParams(location.search).has('demo')) {
    localStorage.setItem('sc.demo', '1');
    history.replaceState(null, '', auth.redirectUri());
  }
  initAnalytics(); // after the OAuth ?code= has been removed from the URL
  if (localStorage.getItem('sc.demo') === '1') {
    source = demoSource();
    return startApp();
  }
  if (auth.getClientId() && auth.isLoggedIn()) {
    source = spotifySource();
    return startApp();
  }
  renderWelcome();
}

function handleError(e) {
  // Work from a session that has since ended. The tab reloads on session changes, so stay quiet.
  if (e instanceof SessionEndedError || e instanceof OwnerMismatchError) return;
  console.error(e);
  if (e instanceof AuthError || e.code === 'invalid_grant') {
    auth.logout();
    toast('Your Spotify session ended. Connect again to keep syncing.', 'error');
    return renderWelcome();
  }
  if (e.status === 403) {
    return toast('Spotify refused access — this Spotify account isn’t approved for this app. Try Settings → Use a different Spotify app.', 'error');
  }
  if (!navigator.onLine) return toast("You're offline — showing what's saved on this device.");
  toast(e.message || 'Something went wrong.', 'error');
}

// ───────────────────────────── welcome ─────────────────────────────

function copyField(text) {
  const btn = h('button.copy-btn', { type: 'button', 'aria-label': 'Copy redirect URI' }, icon('copy'));
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Redirect URI copied');
    } catch {
      toast("Couldn't copy — select it manually.");
    }
  };
  return h('div.copy-field', {}, h('code', {}, text), btn);
}

async function startLogin(btn, label) {
  btn.disabled = true;
  btn.textContent = 'Opening Spotify…';
  try {
    await auth.login();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    toast(e.message, 'error');
  }
}

function ownAppForm(builtIn) {
  const uri = auth.redirectUri();
  const input = h('input.input', {
    id: 'client-id', placeholder: 'e.g. 3f2a9c…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    value: auth.usingOwnClientId() || !builtIn ? auth.getClientId() || '' : '',
  });
  const label = builtIn ? 'Connect with my own app' : 'Connect Spotify';
  const connect = h('button.btn', { type: 'submit', class: builtIn ? 'btn-outline' : 'btn-primary' }, label);
  return h('form.welcome-form', {
    onsubmit: (ev) => {
      ev.preventDefault();
      const id = input.value.trim();
      if (!/^[0-9a-f]{32}$/i.test(id)) {
        input.focus();
        return toast("That doesn't look like a Client ID — it's 32 letters and numbers.", 'error');
      }
      auth.setClientId(id);
      startLogin(connect, label);
    },
  },
    h('ol.steps', {},
      h('li', {},
        h('strong', {}, 'Create a Spotify app'),
        h('p', {}, 'In the ', h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'Spotify developer dashboard'),
          ', create an app and tick “Web API”. Then add your own Spotify account under User Management.')),
      h('li', {},
        h('strong', {}, 'Add this redirect URI'),
        h('p', {}, 'Paste it into the app’s Redirect URIs setting, exactly as shown.'),
        copyField(uri)),
      h('li', {},
        h('label', { for: 'client-id' }, h('strong', {}, 'Paste your Client ID')),
        h('p', {}, 'You’ll find it on the app’s Settings page. It isn’t a secret.'),
        input)),
    connect,
  );
}

function renderWelcome() {
  const builtIn = auth.hasBuiltInClientId();
  const onLocalhost = location.hostname === 'localhost';
  const connectLabel = 'Connect Spotify';
  const connect = h('button.btn.btn-primary.btn-connect', {
    type: 'button',
    onclick: () => {
      auth.clearClientId(); // use the site's built-in app
      startLogin(connect, connectLabel);
    },
  }, spotifyIcon(22), connectLabel);
  const openOwn = sessionStorage.getItem('sc.ownApp') === '1' || auth.usingOwnClientId();
  sessionStorage.removeItem('sc.ownApp');

  setChildren(app,
    h('main.welcome', {},
      h('div.welcome-hero', {},
        h('div.pills', { 'aria-hidden': 'true' }, h('i.p1'), h('i.p2'), h('i.p3'), h('i.p4')),
        h('div.brand', {}, logoMark(30), h('span', {}, 'Soundcap')),
        h('h1', {}, 'Your listening, in a capsule.'),
        h('p.lede', {}, 'Minutes listened, top songs and artists, the hours you press play, and the artists you just discovered — every week, every month.')),
      onLocalhost && h('p.notice', {}, 'Spotify doesn’t accept “localhost” redirect URIs. ',
        h('a', { href: location.href.replace('//localhost', '//127.0.0.1') }, 'Open this page on 127.0.0.1 instead'), '.'),
      builtIn
        ? [
          connect,
          h('p.fine', {}, 'You’ll sign in on Spotify’s own page. Soundcap only gets read access to your recently played and top tracks and artists.'),
          h('details.own-app', { open: openOwn || null },
            h('summary', {}, 'Use your own Spotify app instead'),
            h('p.muted', {}, 'This site’s Spotify app only lets in accounts its owner has approved. If yours isn’t one of them, you can connect through your own free Spotify developer app.'),
            ownAppForm(true)),
        ]
        : ownAppForm(false),
      h('button.btn.btn-ghost', { type: 'button', onclick: () => { localStorage.setItem('sc.demo', '1'); location.reload(); } }, 'Look around with demo data'),
      h('p.fine', {}, 'Your listening history stays on this device. Soundcap talks to Spotify straight from your browser — there’s no Soundcap server or account. ',
        h('a', { href: 'privacy.html' }, 'Privacy policy'), '. Soundcap is an unofficial fan project, not affiliated with or endorsed by Spotify.'),
    ),
  );
}

// ───────────────────────────── app shell ─────────────────────────────

/**
 * History is saved per browser, not per account. If a different Spotify account signs in
 * here, don't show it the previous person's listening; offer to erase it instead.
 */
async function checkOwner() {
  let me;
  try {
    me = await source.me();
  } catch (e) {
    if (e.status === 403) {
      // Development-mode Spotify apps only admit accounts the owner added under User Management.
      setChildren(app, h('main.welcome', {},
        h('div.brand', {}, logoMark(30), h('span', {}, 'Soundcap')),
        h('h1.switch-title', {}, 'Your account isn’t on the list yet.'),
        h('p.lede', {}, auth.usingOwnClientId()
          ? 'Spotify refused access. In your Spotify developer dashboard, add this Spotify account under User Management, then try again.'
          : 'This Soundcap uses a Spotify app that only lets in accounts its owner has approved. Ask them to add your Spotify account, or connect through your own free Spotify app instead.'),
        h('button.btn.btn-primary', { onclick: () => { sessionStorage.setItem('sc.ownApp', '1'); auth.logout(); location.reload(); } }, 'Use my own Spotify app'),
        h('button.btn.btn-ghost', { onclick: () => { auth.logout(); location.reload(); } }, 'Log out')));
      return false;
    }
    handleError(e);
    if (e instanceof AuthError) return false;
    setChildren(app, h('main.welcome', {},
      h('div.brand', {}, logoMark(30), h('span', {}, 'Soundcap')),
      h('p.lede', {}, 'Couldn’t reach Spotify to check who’s signed in.'),
      h('button.btn.btn-primary', { onclick: () => location.reload() }, 'Try again')));
    return false;
  }
  state.me = me;
  if (!me.id) return false;
  const owner = await db.getMeta('ownerId');
  const claim = async () => {
    await db.setMeta('ownerId', me.id);
    source.setOwner(me.id);
  };
  if (owner === me.id) {
    source.setOwner(me.id);
    return true;
  }
  // Nothing saved yet: this account starts the history.
  if (!owner && !(await db.countPlays())) {
    await claim();
    return true;
  }
  const erase = async () => {
    await db.clearAll();
    await claim();
    location.reload();
  };
  const logOut = h('button.btn.btn-ghost', { onclick: () => { auth.logout(); location.reload(); } }, 'Log out');
  if (!owner) {
    // History with no owner (e.g. saved by an older version) — never adopt it silently.
    setChildren(app, h('main.welcome', {},
      h('div.brand', {}, logoMark(30), h('span', {}, 'Soundcap')),
      h('h1.switch-title', {}, 'Is this your listening history?'),
      h('p.lede', {}, `This browser has saved history that isn’t linked to a Spotify account yet. Only keep it if it’s yours, ${me.name}.`),
      h('button.btn.btn-primary', { onclick: async () => { await claim(); location.reload(); } }, 'Yes, it’s mine'),
      h('button.btn.btn-outline', { onclick: erase }, 'No, erase it and start fresh'),
      logOut));
    return false;
  }
  setChildren(app, h('main.welcome', {},
    h('div.brand', {}, logoMark(30), h('span', {}, 'Soundcap')),
    h('h1.switch-title', {}, 'This browser has someone else’s history.'),
    h('p.lede', {}, `You’re signed in as ${me.name}, but the listening history saved here belongs to a different Spotify account, so Soundcap won’t show it to you.`),
    h('button.btn.btn-primary', { onclick: erase }, 'Erase it and start fresh'),
    logOut));
  return false;
}

async function startApp() {
  if (source.kind === 'spotify' && !(await checkOwner())) return;
  renderShell();
  setChildren(shell.capsule, ...[0, 1, 2, 3].map((i) => h('div.card.skeleton', { class: i ? '' : 'wide' })));
  try {
    state.summary = await source.summary();
    state.lastSync = await source.lastSync();
  } catch (e) {
    return handleError(e);
  }
  if (!state.summary.count && source.sync) await runSync();
  if (source.kind === 'spotify' && !localStorage.getItem('sc.persistAsked')) {
    localStorage.setItem('sc.persistAsked', '1');
    db.requestPersist();
  }
  renderChips();
  await renderCapsule();
  renderTop();
  renderFooter();
  if (source.sync) {
    if (Date.now() - (state.lastSync || 0) > 60_000) runSync();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - (state.lastSync || 0) > 2 * 60_000) runSync();
    });
    setInterval(() => document.visibilityState === 'visible' && runSync(), 10 * 60_000);
  }
}

function renderShell() {
  shell.avatar = h('button.avatar', { 'aria-label': 'Settings', onclick: openSettings }, h('span', {}, '·'));
  shell.syncBtn = source.sync && h('button.icon-btn', { 'aria-label': 'Sync now', title: 'Sync now', onclick: () => runSync({ announce: true }) }, icon('sync'));
  shell.chips = h('nav.chips', { 'aria-label': 'Choose a period' });
  shell.title = h('div.capsule-head');
  shell.capsule = h('section.capsule', { 'aria-live': 'polite' });
  shell.top = h('section.top');
  shell.footer = h('footer.foot');
  setChildren(app, 
    source.kind === 'demo' && h('div.demo-bar', {}, h('span', {}, 'You’re looking at demo data.'),
      h('button', { onclick: () => { localStorage.removeItem('sc.demo'); location.reload(); } }, 'Connect your Spotify')),
    h('header.topbar', {},
      h('div.brand', {}, logoMark(26), h('span', {}, 'Soundcap')),
      h('div.topbar-actions', {}, shell.syncBtn, shell.avatar)),
    h('main.main', {}, shell.title, shell.chips, shell.capsule, shell.top, shell.footer),
  );
  (state.me ? Promise.resolve(state.me) : source.me()).then((me) => {
    setChildren(shell.avatar, art(me.image, me.name, { size: 'avatar', round: true }));
    shell.avatar.title = me.name;
    state.me = me;
  }).catch(handleError);
}

async function runSync({ announce = false } = {}) {
  if (!source?.sync || state.syncing) return;
  state.syncing = true;
  shell.syncBtn?.classList.add('spinning');
  try {
    const { added, gap } = await source.sync();
    state.lastSync = Date.now();
    if (added.length && state.summary) {
      mergeSummary(state.summary, added);
      renderChips();
      renderCapsule();
    }
    if (gap) toast('Some plays may be missing — Spotify only shares your last 50. Open Soundcap more often, or import your history.');
    else if (announce) toast(added.length ? `${plural(added.length, 'new play')} saved` : 'You’re up to date');
  } catch (e) {
    handleError(e);
  } finally {
    state.syncing = false;
    shell.syncBtn?.classList.remove('spinning');
    if (state.summary) renderFooter();
  }
}

// ───────────────────────────── periods ─────────────────────────────

function periodLabel(p) {
  if (p === 'week') return 'Last 7 days';
  const [y, m] = p.split('-').map(Number);
  const opts = { month: 'long', ...(y === new Date().getFullYear() ? {} : { year: 'numeric' }) };
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, opts);
}

function renderChips() {
  const months = new Set(state.summary.months);
  months.add(monthKey(Date.now()));
  const list = ['week', ...[...months].sort().reverse()];
  setChildren(shell.chips, ...list.map((p) => h('button.chip', {
    class: p === state.period ? 'on' : '',
    'aria-pressed': String(p === state.period),
    onclick: () => {
      if (state.period === p) return;
      state.period = p;
      renderChips();
      renderCapsule();
    },
  }, periodLabel(p))));
  if (source.kind !== 'demo') {
    shell.chips.append(h('button.chip.more', { onclick: openEarlierMonths }, '+ Earlier months'));
  }
}

function openEarlierMonths() {
  const since = state.summary.earliest;
  const dlg = h('dialog.sheet', { 'aria-label': 'Earlier months' },
    h('div.sheet-head', {},
      h('h2', {}, 'Earlier months'),
      h('button.icon-btn', { 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close'))),
    h('section.sheet-section', {},
      h('p', {}, since
        ? `Your saved history starts on ${fmtDate(since, { month: 'long', day: 'numeric', year: 'numeric' })}. `
        : 'You don’t have any saved history yet. ',
        'Spotify only shares your last 50 plays with apps, so Soundcap can’t go back further on its own. Your Spotify data export can fill in the past:'),
      h('ol.mini-steps', {},
        h('li', {}, 'Open Spotify’s ', h('a', { href: 'https://www.spotify.com/account/privacy/', target: '_blank', rel: 'noopener' }, 'Privacy page'), ' and request your data:',
          h('ul', {},
            h('li', {}, h('b', {}, 'Extended streaming history'), ': your whole history, ready within 30 days.'),
            h('li', {}, h('b', {}, 'Account data'), ': the past year, ready in about 5 days.'))),
        h('li', {}, 'When Spotify emails you, download the zip.'),
        h('li', {}, 'Add it in Settings. Each month in the export gets its own recap, and nothing is counted twice.')),
      h('button.btn.btn-light', { onclick: () => { dlg.close(); openSettings(); } }, icon('upload'), 'I have my data. Import it')),
  );
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ───────────────────────────── capsule ─────────────────────────────

async function renderCapsule() {
  const id = ++state.renderId;
  const range = periodRange(state.period);
  const prev = previousRange(state.period);
  let plays, prevPlays;
  try {
    [plays, prevPlays] = await Promise.all([source.playsBetween(range.start, range.end), source.playsBetween(prev.start, prev.end)]);
  } catch (e) {
    return handleError(e);
  }
  if (id !== state.renderId) return;
  const s = computeStats(plays, range, state.summary);
  const ps = computeStats(prevPlays, prev);
  const hasPrev = ps.totalMs > 0 && state.summary.earliest != null && state.summary.earliest <= prev.start + DAY;
  state.stats = s;
  const label = periodLabel(state.period);

  const subtitle = range.kind === 'week'
    ? `${fmtDate(range.start)} – ${fmtDate(range.end - 1)}`
    : new Date(range.start).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const shareBtn = s.streams > 0 && h('button.share-btn', {
    onclick: () => shareCapsule(s, label).catch(handleError),
  }, icon('share'), 'Share');
  setChildren(shell.title, h('div', {}, h('h1', {}, 'Your capsule'), h('p.muted', {}, subtitle)), shareBtn);

  if (!s.totalMs) {
    setChildren(shell.capsule, emptyCard(label));
    return;
  }
  const cards = [
    heroCard(s, ps, hasPrev, range, label),
    dailyCard(s),
    topSongsCard(s),
    topArtistsCard(s),
    timeCard(s),
    onRepeatCard(s),
    discoveriesCard(s),
    streakCard(s),
    genresCard(s, id),
  ].filter(Boolean);
  cards.forEach((c, i) => c.style.setProperty('--i', i));
  setChildren(shell.capsule, ...cards);
}

const card = (cls, ...children) => h('article.card', { class: cls }, ...children);
const kicker = (text) => h('p.kicker', {}, text);

function emptyCard(label) {
  const first = !state.summary.count;
  return card('c-surface wide empty',
    kicker(first ? 'Warming up' : label),
    h('p.big-title', {}, first ? 'Your capsule fills up as you listen.' : 'Nothing played here yet.'),
    h('p.caption', {}, source.kind === 'demo'
      ? 'Pick another period above.'
      : first
        ? 'Play something on Spotify, then come back. Soundcap saves your recent plays every time you open it — or import your Spotify data to bring in your past.'
        : 'No listening was recorded for this period. If you listened before Soundcap was tracking, import your Spotify data to fill it in.'),
    source.kind !== 'demo' && h('button.btn.btn-light', { onclick: openSettings }, icon('upload'), 'Import listening history'),
  );
}

function heroCard(s, ps, hasPrev, range, label) {
  let delta = null;
  if (hasPrev) {
    // Months compare per-day averages, so a half-finished month isn't unfairly behind.
    const cur = range.kind === 'month' ? s.totalMs / Math.max(s.elapsed, 1) : s.totalMs;
    const before = range.kind === 'month' ? ps.totalMs / Math.max(ps.elapsed, 1) : ps.totalMs;
    const pct = Math.round(((cur - before) / before) * 100);
    const vs = range.kind === 'week' ? 'than the week before' : `a day than ${new Date(ps.range.start).toLocaleDateString(undefined, { month: 'long' })}`;
    delta = h('p.delta', { class: pct >= 0 ? 'up' : 'down' }, pct >= 0 ? '▲ ' : '▼ ', `${Math.abs(pct)}% ${pct >= 0 ? 'more' : 'less'} ${vs}`);
  }
  return card('c-lime wide hero',
    kicker(label),
    h('p.label', {}, 'You listened for'),
    h('p.mega', {}, fmtInt(minutes(s.totalMs))),
    h('p.unit', {}, minutes(s.totalMs) === 1 ? 'minute' : 'minutes'),
    delta,
    h('div.hero-meta', {},
      h('div', {}, h('b', {}, fmtInt(s.uniqueTracks)), h('span', {}, s.uniqueTracks === 1 ? 'song' : 'songs')),
      h('div', {}, h('b', {}, fmtInt(s.uniqueArtists)), h('span', {}, s.uniqueArtists === 1 ? 'artist' : 'artists')),
      h('div', {}, h('b', {}, `${s.activeDays}/${s.elapsed}`), h('span', {}, 'days listening'))),
  );
}

function bars(values, { peakIndex, futureMask = [], labels = [], titles = [] }) {
  const max = Math.max(...values, 1);
  return h('div.chart', { style: { '--n': values.length } },
    h('div.bars', { role: 'img', 'aria-label': titles.filter(Boolean).join('; ') },
      values.map((v, i) => h('div.bar', { class: [i === peakIndex && 'peak', futureMask[i] && 'future'].filter(Boolean).join(' '), title: titles[i] || null },
        h('i', { style: { '--v': (v / max).toFixed(4), '--d': `${i * 18}ms` } })))),
    h('div.bar-labels', { 'aria-hidden': 'true' }, values.map((_, i) => h('span', {}, labels[i] || ''))),
  );
}

function dailyCard(s) {
  const week = s.days.length <= 7;
  const peakIndex = s.biggest ? s.days.indexOf(s.biggest) : -1;
  const labels = s.days.map((d) =>
    week ? d.date.toLocaleDateString(undefined, { weekday: 'short' }) : [1, 8, 15, 22, 29].includes(d.date.getDate()) ? String(d.date.getDate()) : '');
  const avg = s.totalMs / Math.max(s.activeDays, 1);
  return card('c-surface wide',
    kicker('Your daily listening'),
    h('div.split', {},
      h('div', {},
        h('p.stat', {}, hm(avg)),
        h('p.stat-label', {}, 'on an average listening day')),
      s.biggest && h('div', {},
        h('p.stat.accent', {}, hm(s.biggest.ms)),
        h('p.stat-label', {}, `your biggest day — ${fmtDay(s.biggest.date)}`))),
    bars(s.days.map((d) => d.ms), {
      peakIndex,
      futureMask: s.days.map((d) => d.future),
      labels,
      titles: s.days.map((d) => (d.future ? null : `${fmtDay(d.date)}: ${hm(d.ms)}`)),
    }),
  );
}

// ── Spotify links + attribution (required by Spotify's Developer Policy, section II) ──

const spotifyUrl = (type, id, query) =>
  source.kind === 'demo' ? null : id ? `https://open.spotify.com/${type}/${id}` : `https://open.spotify.com/search/${encodeURIComponent(query)}`;

function linkTo(url, cls, ...kids) {
  return url
    ? h(`a.${cls}`, { href: url, target: '_blank', rel: 'noopener', title: 'Open in Spotify' }, ...kids)
    : h(`div.${cls}`, {}, ...kids);
}

/** Link to a track; starts as a Spotify search and upgrades to the exact track once it's looked up. */
function trackLink(t, cls, ...kids) {
  const el = linkTo(spotifyUrl('track', t.trackId, `${t.track} ${t.artist}`), cls, ...kids);
  if (el.tagName === 'A' && !t.trackId) source.trackInfo(t).then((i) => { if (i?.url) el.href = i.url; }).catch(() => {});
  return el;
}

function artistLink(a, cls, ...kids) {
  const el = linkTo(spotifyUrl('artist', a.artistId, a.name), cls, ...kids);
  if (el.tagName === 'A' && !a.artistId) source.artistInfo(a.name).then((i) => { if (i?.url) el.href = i.url; }).catch(() => {});
  return el;
}

const credit = () => source.kind === 'demo' ? null
  : h('a.credit', { href: 'https://open.spotify.com', target: '_blank', rel: 'noopener' }, spotifyIcon(21), h('span', {}, 'Content from Spotify'));

function topSongsCard(s) {
  const top = s.topTracks.slice(0, 5);
  if (!top.length) return null;
  const [first, ...rest] = top;
  const load = (t) => () => source.trackArt(t);
  return card('c-pink',
    kicker('Your top songs'),
    trackLink(first, 'top1',
      art(first.image, first.track, { size: 'xl', load: load(first) }),
      h('div.top1-text', {},
        h('p.rank', {}, '#1'),
        h('p.top1-title', {}, first.track),
        h('p.top1-sub', {}, first.artist),
        h('p.top1-meta', {}, plural(first.count, 'play')))),
    rest.length > 0 && h('ol.rows', { start: 2 }, rest.map((t, i) => h('li', {},
      trackLink(t, 'row',
        h('span.num', {}, i + 2),
        art(t.image, t.track, { size: 'sm', load: load(t) }),
        h('div.row-text', {}, h('p.row-title', {}, t.track), h('p.row-sub', {}, t.artist)),
        h('span.row-meta', {}, plural(t.count, 'play')))))),
    credit(),
  );
}

function topArtistsCard(s) {
  const top = s.topArtists.slice(0, 5);
  if (!top.length) return null;
  const [first, ...rest] = top;
  const load = (a) => () => source.artistInfo(a.name, a.artistId).then((r) => r?.image);
  return card('c-blue',
    kicker('Your top artists'),
    artistLink(first, 'top1',
      art(null, first.name, { size: 'xl', round: true, load: load(first) }),
      h('div.top1-text', {},
        h('p.rank', {}, '#1'),
        h('p.top1-title', {}, first.name),
        h('p.top1-meta', {}, `${fmtInt(minutes(first.ms))} min`))),
    rest.length > 0 && h('ol.rows', { start: 2 }, rest.map((a, i) => h('li', {},
      artistLink(a, 'row',
        h('span.num', {}, i + 2),
        art(null, a.name, { size: 'sm', round: true, load: load(a) }),
        h('div.row-text', {}, h('p.row-title', {}, a.name)),
        h('span.row-meta', {}, `${fmtInt(minutes(a.ms))} min`))))),
    credit(),
  );
}

function timeCard(s) {
  const p = PERSONAS[s.persona];
  return card('c-orange',
    kicker('When you listen'),
    h('p.big-title', {}, p.title),
    h('p.caption', {}, `${p.desc} Your peak hour was ${hourLabel(s.peakHour)}.`),
    bars(s.hours, {
      peakIndex: s.peakHour,
      labels: s.hours.map((_, i) => (i % 6 === 0 ? hourLabel(i) : '')),
      titles: s.hours.map((ms, i) => `${hourLabel(i)}: ${hm(ms)}`),
    }),
  );
}

function onRepeatCard(s) {
  const r = s.onRepeat;
  if (!r || r.count < 3) return null;
  return card('c-mint',
    kicker('On repeat'),
    trackLink(r.track, 'repeat',
      art(r.track.image, r.track.track, { size: 'lg', load: () => source.trackArt(r.track) }),
      h('p.mega.sm', {}, `${r.count}×`)),
    h('p.caption', {}, 'You played ', h('b', {}, r.track.track), ` by ${r.track.artist} ${r.count} times on ${fmtDay(r.date)}.`),
    credit(),
  );
}

function discoveriesCard(s) {
  if (!s.newArtists?.length) return null;
  const n = s.newArtists.length;
  return card('c-yellow',
    kicker('New discoveries'),
    h('p.mega.sm', {}, fmtInt(n)),
    h('p.caption', {}, n === 1 ? 'artist you listened to for the first time.' : 'artists you listened to for the first time.'),
    h('ul.name-pills', {}, s.newArtists.slice(0, 6).map((a) => h('li', {},
      artistLink(a, 'name-pill',
        art(null, a.name, { size: 'xs', round: true, load: () => source.artistInfo(a.name, a.artistId).then((x) => x?.image) }),
        h('span', {}, a.name))))),
    credit(),
  );
}

function streakCard(s) {
  const week = s.days.length <= 7;
  return card('c-purple',
    kicker('Your listening streak'),
    h('p.mega.sm', {}, String(s.longestStreak)),
    h('p.unit', {}, s.longestStreak === 1 ? 'day in a row' : 'days in a row'),
    h('div.dots', { class: week ? 'week' : '', 'aria-hidden': 'true' }, s.days.map((d) => h('i', { class: d.future ? 'future' : d.ms ? 'on' : '' }))),
    h('p.caption', {}, `You listened on ${s.activeDays} of the last ${plural(s.elapsed, 'day')}.`),
  );
}

function genresCard(s, renderId) {
  const top = s.topArtists.slice(0, 15);
  if (!top.length) return null;
  const body = h('p.caption.loading', {}, 'Tuning in…');
  const el = card('c-lav', kicker('Your top genres'), body);
  Promise.allSettled(top.map((a) => source.artistInfo(a.name, a.artistId))).then((results) => {
    if (renderId !== state.renderId) return;
    const weights = new Map();
    results.forEach((r, i) => {
      for (const g of (r.status === 'fulfilled' && r.value?.genres) || []) weights.set(g, (weights.get(g) || 0) + top[i].ms);
    });
    const genres = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    // Spotify doesn't always return genres (and has removed them for some apps) — hide rather than show an empty card.
    if (!genres.length) return el.remove();
    body.replaceWith(h('ol.genres', {}, genres.map(([g], i) => h('li', { style: { '--rank': i } }, g))));
  });
  return el;
}

// ───────────────────────────── Spotify's top lists ─────────────────────────────

async function renderTop() {
  const tabs = [['short_term', '4 weeks'], ['medium_term', '6 months'], ['long_term', 'All time']];
  const body = h('div.top-body', {}, h('div.skeleton.strip'));
  setChildren(shell.top, 
    h('div.section-head', {},
      h('h2', {}, 'How Spotify sees you'),
      h('p.muted', {}, 'Your top artists and songs as ranked by Spotify — no tracking needed.')),
    h('div.seg', { role: 'tablist' }, tabs.map(([k, l]) => h('button', {
      role: 'tab', 'aria-selected': String(k === state.topRange), class: k === state.topRange ? 'on' : '',
      onclick: () => { state.topRange = k; renderTop(); },
    }, l))),
    body,
  );
  const range = state.topRange;
  try {
    const [artists, tracks] = await Promise.all([source.top('artists', range), source.top('tracks', range)]);
    if (range !== state.topRange) return;
    const link = (url, cls, ...kids) => (url ? h(`a.${cls}`, { href: url, target: '_blank', rel: 'noopener' }, ...kids) : h(`div.${cls}`, {}, ...kids));
    setChildren(body, 
      artists.length ? h('div.artist-strip', {}, artists.slice(0, 12).map((a, i) =>
        link(a.url, 'artist-tile', art(a.image, a.name, { size: 'lg', round: true }), h('span.t-rank', {}, i + 1), h('span.t-name', {}, a.name))))
        : h('p.muted', {}, 'Not enough listening yet for Spotify to rank your artists.'),
      tracks.length > 0 && h('ol.rows.track-list', {}, tracks.slice(0, 10).map((t, i) => h('li', {},
        link(t.url, 'row', h('span.num', {}, i + 1), art(t.image, t.name, { size: 'sm' }),
          h('div.row-text', {}, h('p.row-title', {}, t.name), h('p.row-sub', {}, t.sub)))))),
      credit(),
    );
  } catch (e) {
    if (range !== state.topRange) return;
    setChildren(body, h('p.muted', {}, 'Couldn’t load Spotify’s rankings right now.'));
    if (!(e instanceof AuthError)) console.error(e);
    else handleError(e);
  }
}

// ───────────────────────────── footer + settings ─────────────────────────────

function renderFooter() {
  const s = state.summary;
  const demo = source.kind === 'demo';
  setChildren(shell.footer, 
    h('div.foot-card', {},
      h('p.foot-title', {}, s.count ? `${plural(s.count, 'play')} saved since ${fmtDate(s.earliest, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'No plays saved yet'),
      !demo && h('p.muted', {}, state.lastSync ? `Last synced ${ago(state.lastSync)}.` : 'Not synced yet.',
        ' Spotify only shares your 50 most recent plays, so Soundcap saves them each time you open it. Import your Spotify data to fill in the past.'),
      !demo && h('button.btn.btn-small', { onclick: openSettings }, icon('upload'), 'Import history'),
    ),
    credit(),
    h('p.fine', {}, 'Soundcap is an unofficial fan project, not affiliated with or endorsed by Spotify. ', h('a', { href: 'privacy.html' }, 'Privacy policy'), '.'),
  );
}

function storageStatus() {
  const el = h('p.storage-status', {}, 'Checking storage…');
  db.isPersisted().then(async (persisted) => {
    let usage = '';
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.usage != null) usage = ` Using ${(est.usage / 1048576).toFixed(1)} MB.`;
    } catch { /* not supported */ }
    if (persisted) {
      setChildren(el, h('b', {}, '✓ Protected.'), ` Your browser won’t clear this data on its own.${usage}`);
      return;
    }
    const btn = h('button.btn.btn-small', {
      onclick: async () => {
        if (await db.requestPersist()) setChildren(el, h('b', {}, '✓ Protected.'), ` Your browser won’t clear this data on its own.${usage}`);
        else toast('Your browser didn’t allow it. Installing Soundcap as an app usually does.');
      },
    }, 'Protect my data');
    setChildren(el, 'Saved, but your browser may clear it if storage runs low or you don’t visit for a long time.', usage, ' ', btn);
  });
  return el;
}

function openSettings() {
  const demo = source?.kind === 'demo';
  const progress = h('p.progress', { role: 'status' });
  const fileInput = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', multiple: true, hidden: true });
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length) return;
    try {
      const { found, added } = await source.importFiles(files, (msg) => { progress.textContent = msg; });
      mergeSummary(state.summary, added);
      progress.textContent = `Done — ${plural(added.length, 'new play')} added (${fmtInt(found - added.length)} already saved).`;
      renderChips();
      renderCapsule();
      renderFooter();
    } catch (e) {
      progress.textContent = '';
      toast(e.message, 'error');
    }
  };

  const section = (title, ...kids) => h('section.sheet-section', {}, h('h3', {}, title), ...kids);
  const dlg = h('dialog.sheet', { 'aria-label': 'Settings' },
    h('div.sheet-head', {},
      h('h2', {}, 'Settings'),
      h('button.icon-btn', { 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close'))),
    !demo && section('Bring in your history',
      h('p', {}, 'Spotify only shares your last 50 plays, so your capsule starts when you start using Soundcap. To fill in the past:'),
      h('ol.mini-steps', {},
        h('li', {}, 'On Spotify’s ', h('a', { href: 'https://www.spotify.com/account/privacy/', target: '_blank', rel: 'noopener' }, 'Privacy page'),
          ', request “Extended streaming history” (your whole history, takes up to 30 days) or “Account data” (the past year, about 5 days).'),
        h('li', {}, 'When the email arrives, download the zip and add it here — no need to unzip.')),
      h('button.btn.btn-light', { onclick: () => fileInput.click() }, icon('upload'), 'Add Spotify data or backup'),
      fileInput, progress),
    !demo && section('Backup',
      h('p', {}, 'Your history only lives in this browser. Export a backup now and then — you can add it back with the button above.'),
      storageStatus(),
      h('button.btn.btn-outline', {
        onclick: async () => toast(`Exported ${plural(await exportBackup(), 'play')}`),
      }, icon('download'), 'Export backup')),
    section('Account',
      demo
        ? h('p', {}, 'You’re exploring demo data.')
        : h('p', {}, 'Signed in as ', h('b', {}, state.me?.name || 'you'), '.'),
      h('div.btn-row', {},
        demo
          ? h('button.btn.btn-outline', { onclick: () => { localStorage.removeItem('sc.demo'); location.reload(); } }, 'Leave demo')
          : h('button.btn.btn-danger', {
            onclick: async () => {
              const ok = confirm('Disconnect Spotify?\n\nThis signs you out and deletes all of your listening history saved by Soundcap on this device. Export a backup first if you want to keep it.');
              if (!ok) return;
              // Sign out first: that ends the session, so in-flight work here and in other tabs
              // is discarded instead of writing data back after the wipe.
              auth.logout();
              await db.clearAll();
              location.reload();
            },
          }, 'Disconnect and delete my data'),
        !demo && h('button.btn.btn-outline', {
          onclick: () => { sessionStorage.setItem('sc.ownApp', '1'); auth.logout(); auth.clearClientId(); location.reload(); },
        }, 'Use a different Spotify app')),
      !demo && h('p.muted', {}, 'To also remove Soundcap’s access on Spotify’s side, go to ',
        h('a', { href: 'https://www.spotify.com/account/apps/', target: '_blank', rel: 'noopener' }, 'spotify.com/account/apps'),
        '. ', h('a', { href: 'privacy.html' }, 'Privacy policy'), '.')),
    !demo && section('Erase',
      h('p', {}, 'Delete every play saved on this device. Spotify’s copy isn’t affected.'),
      h('button.btn.btn-danger', {
        onclick: async () => {
          if (!confirm('Erase all listening history saved in Soundcap on this device?')) return;
          await db.clearHistory();
          location.reload();
        },
      }, 'Erase saved history')),
  );
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

boot();
