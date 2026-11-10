// DOM + formatting helpers. All user/API text goes through textContent — never innerHTML.

export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.classList.add(...String(v).split(' ').filter(Boolean));
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  appendAll(el, children);
  return el;
}

/** Like el.replaceChildren(), but skips null/false (the native one prints them as text). */
export function setChildren(el, ...children) {
  el.replaceChildren();
  appendAll(el, children);
  return el;
}

function appendAll(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendAll(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

const ICONS = {
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9M20 20v-4h-4"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// Spotify icon, used only to attribute content to Spotify as its Developer Policy requires.
const SPOTIFY_PATH = 'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z';

export function spotifyIcon(size = 21) {
  const span = document.createElement('span');
  span.className = 'spotify-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="currentColor" d="${SPOTIFY_PATH}"/></svg>`;
  return span;
}

export function logoMark(size = 28) {
  const span = document.createElement('span');
  span.className = 'logo-mark';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 64 64"><g transform="rotate(-35 32 32)"><rect x="6" y="20" width="52" height="24" rx="12" fill="#f573a0"/><path d="M18 20h14v24H18a12 12 0 0 1 0-24z" fill="#cdf564"/></g></svg>`;
  return span;
}

// Placeholder art: a colored tile with initials, swapped for the real image when it arrives.
const PH = [['#cdf564', '#000'], ['#f573a0', '#000'], ['#9bf0e1', '#000'], ['#ffc864', '#000'], ['#ff6437', '#000'], ['#c4b1e6', '#000'], ['#4100f5', '#fff'], ['#af2896', '#fff']];
const hash = (s) => [...(s || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const initials = (s) => (s || '?').replace(/^the\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function art(src, label, { size = 'md', round = false, load } = {}) {
  const [bg, fg] = PH[hash(label) % PH.length];
  const el = h('div.art', { class: `art-${size}${round ? ' round' : ''}`, 'aria-hidden': 'true', style: { '--ph': bg, '--ph-fg': fg } }, initials(label));
  const setImg = (url) => {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => el.replaceChildren(img);
    img.src = url;
  };
  if (src) setImg(src);
  else if (load) load().then((u) => u && setImg(u)).catch(() => {});
  return el;
}

let toastTimer;
export function toast(msg, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 7000 : 4000);
}

export const fmtInt = (n) => Math.round(n).toLocaleString();
export const minutes = (ms) => Math.round(ms / 60_000);
export function hm(ms) {
  const m = Math.round(ms / 60_000);
  const hrs = Math.floor(m / 60);
  return hrs ? `${hrs}h ${m % 60}m` : `${m}m`;
}
export const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
export const fmtDate = (t, opts = { month: 'short', day: 'numeric' }) => new Date(t).toLocaleDateString(undefined, opts);
export const fmtDay = (t) => fmtDate(t, { weekday: 'long', month: 'short', day: 'numeric' });
export const hourLabel = (hr) => `${hr % 12 || 12}${hr < 12 ? 'am' : 'pm'}`;
export function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return fmtDate(t);
}
