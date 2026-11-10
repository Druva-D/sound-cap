import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function freePort() {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function start(t, command, args, options, label) {
  const child = spawn(command, args, options);
  const closed = once(child, 'close').catch(() => {});
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
  t.after(async () => {
    child.kill();
    await closed;
  });
  try {
    await once(child, 'spawn');
  } catch (error) {
    throw new Error(`Could not launch ${label} (${command})`, { cause: error });
  }
  return { child, stderr: () => stderr };
}

function devtools(browser) {
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  const [input, output] = browser.child.stdio.slice(3);
  output.setEncoding('utf8').on('data', (chunk) => {
    const messages = (buffer + chunk).split('\0');
    buffer = messages.pop();
    for (const message of messages) {
      const { id, result, error } = JSON.parse(message);
      pending.get(id)?.(result, error?.message);
    }
  });
  browser.child.on('exit', () => {
    for (const finish of pending.values()) finish(null, `browser exited\n${browser.stderr()}`);
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const finish = (result, error) => {
      clearTimeout(timer);
      pending.delete(id);
      if (error) reject(new Error(`${method}: ${error}`));
      else resolve(result);
    };
    const timer = setTimeout(() => finish(null, `timed out\n${browser.stderr()}`), 25_000);
    pending.set(id, finish);
    input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`, (error) => {
      if (error) finish(null, error.message);
    });
  });
}

test('Soundcap in a real browser', async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await start(t, process.execPath, ['serve.mjs'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  }, 'the Soundcap dev server');
  const [output] = await Promise.race([once(server.child.stdout, 'data'), once(server.child, 'exit')]);
  assert.match(String(output), /Soundcap running/, server.stderr());

  await t.test('dev server serves the app and its modules, manifest, fonts and icons', async () => {
    for (const [path, contentType] of [
      ['/?demo', 'text/html'], ['/privacy.html', 'text/html'], ['/src/main.js', 'text/javascript'], ['/sw.js', 'text/javascript'],
      ['/styles.css', 'text/css'], ['/manifest.webmanifest', 'application/manifest+json'],
      ['/fonts/figtree-latin.woff2', 'font/woff2'], ['/icons/icon-192.png', 'image/png'],
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.ok(response.headers.get('content-type').startsWith(contentType), path);
      assert.equal(response.headers.get('cache-control'), 'no-cache', path);
      await response.arrayBuffer();
    }
    assert.equal((await fetch(base + '/missing.html')).status, 404);
  });

  const profile = await mkdtemp(join(tmpdir(), 'soundcap-test-'));
  let browser;
  try {
    browser = await start(t, process.env.BROWSER || 'chromium', [
      '--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }, 'a Chromium-based browser');
  } finally {
    t.after(() => rm(profile, { recursive: true, force: true }));
  }

  const send = devtools(browser);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page('Network.enable');
  await page('Network.setBlockedURLs', { urls: ['https://*'] });
  await page('Page.addScriptToEvaluateOnNewDocument', {
    source: 'Object.defineProperty(navigator, "globalPrivacyControl", { value: true })',
  });
  await page('Page.navigate', { url: `${base}/` });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await page('Runtime.evaluate', { expression: 'location.origin + " " + document.readyState', returnByValue: true });
    if (state.result?.value === `${base} complete`) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const { result, exceptionDetails } = await page('Runtime.evaluate', {
    expression: 'import("/test/browser/cases.js").then(({ run }) => run())',
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(exceptionDetails, undefined, result.description);
  assert.ok(result.value.length > 0, 'browser did not report test cases');
  for (const { name, todo, error } of result.value) {
    await t.test(name, { todo }, () => { if (error) throw new Error(error); });
  }
});
