// Renders a story-sized (1080×1920) capsule card and shares or downloads it.
import { minutes, fmtInt } from './ui.js';
import { PERSONAS } from './personas.js';

const FONT = 'Figtree, system-ui, sans-serif';

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function block(ctx, x, y, w, hgt, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, hgt, 48); else ctx.rect(x, y, w, hgt);
  ctx.fill();
}

function list(ctx, items, x, y, w, color) {
  items.forEach((it, i) => {
    const yy = y + i * 74;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.font = `800 40px ${FONT}`;
    ctx.fillText(String(i + 1), x, yy);
    ctx.globalAlpha = 1;
    ctx.font = `700 42px ${FONT}`;
    ctx.fillText(fit(ctx, it, w - 70), x + 64, yy);
  });
}

export async function shareCapsule(s, label) {
  await Promise.all([document.fonts.load(`900 100px ${FONT}`), document.fonts.load(`700 40px ${FONT}`)]).catch(() => {});
  const W = 1080, H = 1920, X = 64, BW = W - 2 * X;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#fff';
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText('My listening capsule', X, 140);
  ctx.font = `900 112px ${FONT}`;
  ctx.fillText(fit(ctx, label, BW), X, 260);

  block(ctx, X, 320, BW, 380, '#cdf564');
  ctx.fillStyle = '#000';
  ctx.font = `700 44px ${FONT}`;
  ctx.fillText('I listened for', X + 56, 410);
  ctx.font = `900 200px ${FONT}`;
  ctx.fillText(fmtInt(minutes(s.totalMs)), X + 48, 600);
  ctx.font = `800 52px ${FONT}`;
  ctx.fillText('minutes', X + 56, 664);

  block(ctx, X, 740, BW, 520, '#f573a0');
  ctx.fillStyle = '#000';
  ctx.font = `800 44px ${FONT}`;
  ctx.fillText('Top songs', X + 56, 830);
  list(ctx, s.topTracks.slice(0, 5).map((t) => `${t.track} · ${t.artist}`), X + 56, 920, BW - 112, '#000');

  block(ctx, X, 1300, BW, 440, '#4100f5');
  ctx.fillStyle = '#fff';
  ctx.font = `800 44px ${FONT}`;
  ctx.fillText('Top artists', X + 56, 1390);
  list(ctx, s.topArtists.slice(0, 5).map((a) => a.name), X + 56, 1480, BW - 112, '#fff');

  ctx.fillStyle = '#fff';
  ctx.font = `800 44px ${FONT}`;
  ctx.fillText(PERSONAS[s.persona].title, X, 1840);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#a7a7a7';
  ctx.font = `600 32px ${FONT}`;
  ctx.fillText('soundcap', W - X, 1840);

  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'soundcap.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'My listening capsule' });
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'soundcap.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
