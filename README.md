# releasd

One page for the two feeds I actually follow, with inline playback and a shared "listened" state across devices.

- **Rinse FM** — newest episodes of followed shows, sorted by when the audio became available (shows are often
  archived days or weeks after airing). Badges: rebroadcast, backfilled, upcoming, not archived yet. Inline mp3 player,
  optional live BPM readout, auto-marked as listened when played to the end.
- **Bandcamp** — newest releases (last 60 days) from every artist/label my profile follows, split into Released and
  Pre-orders (with "n of m tracks available"). Official embedded player with full tracklist.

## Architecture

```
GitHub Pages (site/)  ──live──▶  admin.rinse.fm GraphQL          (Rinse, fetched by the browser)
        │ key from #k= link
        ▼
Cloudflare Worker (worker/) ── KV: seen marks, config cache, built Bandcamp dataset
        ▲ upload on success            │ egress proxy (Bandcamp blocks GitHub runner IPs)
GitHub Action (build.py, every ~3 h or on demand) ──▶ bandcamp.com mobile API
```

- The page is a static shell behind a passphrase login (sessions are HMAC tokens from the Worker, rate-limited per IP).
  Rinse is queried live; config, Bandcamp data, seen marks and saved sets all come from the Worker, nothing personal is on Pages.
- The Action only *uploads* when it produced data, so a blocked or failed run never blanks the page.
- Show/label edits from the UI are committed to `config.json` through the Worker (the GitHub token lives only there).
- Seen marks: per item, last-write-wins, merged server-side; a rebroadcast shares the state of its original;
  pre-orders and not-yet-archived episodes have their own key so a tick there does not stick once the real thing lands.

## Setup

1. Repo + Pages: `gh repo create releasd --public --source=. --push`, then
   `gh api -X POST repos/OWNER/releasd/pages -f build_type=workflow`.
2. Worker (free tier):
   ```sh
   cd worker
   npx wrangler login
   npx wrangler kv namespace create STATE        # id -> wrangler.toml
   npx wrangler secret put LOGIN_PASSWORD        # the passphrase typed into the page's login box
   npx wrangler secret put SESSION_SECRET        # random, signs sessions (rotate = log out everywhere)
   npx wrangler secret put API_KEY               # optional: a key accepted as Bearer for scripts / legacy #k= links
   npx wrangler secret put ADMIN_KEY             # shared with the Action
   npx wrangler secret put GH_TOKEN              # fine-grained PAT, this repo only: Contents RW + Actions RW
   npx wrangler deploy
   ```
   Set `API_URL` in `site/app.js` to the printed URL. `gh secret set RELEASD_ADMIN_KEY` with the same admin key.
3. Open `https://OWNER.github.io/releasd/`, log in with the passphrase; the session lasts 180 days per device.

## config.json

```json
{ "days_back": 60,
  "rinse":    { "shows": ["hodge", "josi-devil"] },
  "bandcamp": { "fan": "gmbt", "fan_id": 8528257, "labels": [], "exclude": [] } }
```

`rinse.shows` = slugs from `rinse.fm/shows/<slug>` (edit from the page: searchable list of all shows).
`bandcamp.fan`/`fan_id` = public Bandcamp profile; `labels` adds URLs not followed; `exclude` hides subdomains.

## Local

```sh
python3 build.py                      # direct to Bandcamp; RELEASD_API + RELEASD_ADMIN_KEY env -> via Worker + upload
python3 -m http.server -d site 8000
```

## Notes

- Rinse: Craft CMS GraphQL at `https://admin.rinse.fm/api` (public, CORS `*`). `episodeTime` is time-of-day only;
  `dateUpdated` marks when audio was attached. Artwork via `image.rinse.fm/_/<file>?w=&h=`.
- Bandcamp: unofficial mobile-app API (`band_details`, `tralbum_details`, `fancollection/.../following_bands`).
  Rate-limited per IP in bursts; the builder is sequential with backoff.
- GitHub's cron is unreliable; the Worker triggers the build every 2 h and the page has a refresh button.
