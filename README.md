# Soundcap

An installable PWA, inspired by Spotify's discontinued Sound Capsule, built on the Spotify Web API. Unofficial; not affiliated with Spotify. It shows minutes listened, daily listening, top songs and artists, when you listen, songs on repeat, new discoveries, streaks and genres, for the last 7 days and for each month. You can share any of them as an image sized for stories.

No build step, no dependencies, no server. It's static files that talk to Spotify straight from the browser.

## Run it

```sh
npm start            # → http://127.0.0.1:5173/
```

Open `http://127.0.0.1:5173/?demo` to look around with generated data.

## Tests

With Node.js 24 or newer, run `npm test` for statistics, authentication, Spotify API, and PWA checks. Run `npm run test:browser` for end-to-end checks with a locally installed Chromium browser. Set `BROWSER=brave` or `BROWSER=/path/to/chrome` to use another Chromium executable.

The browser suite starts the development server on a temporary loopback port and uses an isolated browser profile. It covers real IndexedDB, ZIP import, backup restore, Canvas sharing, demo navigation, and service worker registration. Spotify responses are mocked. Tests marked TODO exercise defects found during review and are reported separately from passing tests.

## Connect Spotify

1. Create an app at <https://developer.spotify.com/dashboard> and tick **Web API**.
2. Add the redirect URI the app shows you (e.g. `http://127.0.0.1:5173/`). Spotify rejects `localhost`, so use `127.0.0.1`.
3. Under **User Management**, add the Spotify account(s) that will use it (required in Development Mode).
4. Paste the Client ID into Soundcap and connect.

## Deploy (free)

There's no build step. Deploy the folder as it is.

- **Netlify:** `npx netlify-cli deploy --prod --dir .`, or drag the folder onto app.netlify.com/drop, or connect the git repo. `netlify.toml` sets the security headers.
- **Vercel:** `npx vercel --prod`, or import the git repo. `vercel.json` sets the same headers.

Then add the deployed URL, with its trailing slash (e.g. `https://your-site.netlify.app/`), as a redirect URI in your Spotify app. You can hard-code your Client ID in `src/config.js` to skip the setup step.

## Install it

It's a PWA, so after opening the deployed site:
- **Android / Chrome / Edge / Brave:** use the install icon in the address bar, or the menu's *Install app* / *Add to Home screen*.
- **iPhone / iPad:** in Safari, tap Share, then *Add to Home Screen*.

Each installed copy keeps its own history (on iOS, the home-screen app doesn't share storage with Safari), so use the same one consistently.

## How the data works

Spotify has no "minutes listened" endpoint. It only exposes your **50 most recent plays**. So Soundcap:

- **Saves plays locally** (IndexedDB) each time it opens, comes back into focus, or every 10 minutes while open. Open it at least every few hours of listening and nothing gets lost. You'll be warned if a gap was detected.
- **Imports your past** from Spotify's privacy data export (*Account data* or *Extended streaming history*). Drop the `.zip` straight in and duplicates against synced plays are skipped. Podcasts and audiobooks are ignored.
- **Shows Spotify's own rankings** (`/me/top`) for 4 weeks, 6 months and all time. These work from day one, without any tracking.

Data never leaves the browser. Use **Settings → Export backup** occasionally, because clearing site data deletes it.

## Spotify Developer Policy

- `privacy.html` is the privacy policy (Section I). Update it if you change analytics or data handling.
- **Settings → Disconnect and delete my data** signs out and wipes everything on the device (Section I).
- Spotify content is credited with the Spotify icon and links back to the track or artist on Spotify (Section II).
- History is tied to the Spotify account that created it. Another account signing in on the same browser is asked to erase it, and isn't shown it.
- Known conflict: Section III item 13 forbids deriving "listenership metrics" from Spotify data, which is the app's core purpose.

Notes:
- Plays from the API count the full track length, since Spotify doesn't say how much was played. Imported history uses the real time played. A "play" in top lists means at least 30 seconds.
- Genres come from artist data. Spotify returns them inconsistently, and the card hides itself when there are none.
- Not affiliated with Spotify.

## Files

| | |
|---|---|
| `src/main.js` | UI: welcome/setup, capsule cards, top lists, settings |
| `src/stats.js` | Period maths: totals, days, hours, streaks, repeats, discoveries |
| `src/auth.js` / `src/api.js` | PKCE login, token refresh, rate-limited API client |
| `src/db.js` | IndexedDB storage with cross-source de-duplication |
| `src/source-spotify.js` / `src/source-demo.js` | Real and demo data sources |
| `src/importer.js` | Spotify export (zip/JSON) and backup import/export |
| `src/share.js` | 1080×1920 share image |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA shell |
