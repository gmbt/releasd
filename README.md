# releasd

One page for the two feeds you actually follow:

- **Rinse FM** — newest episodes of the shows you pick, playable inline (mp3 from replay.rinse.fm). Rebroadcasts flagged.
- **Bandcamp** — newest releases (last 30 days + pre-orders) from every artist/label your Bandcamp profile follows. Official embedded player.

No backend. Static page on GitHub Pages. A Python script in GitHub Actions refreshes Bandcamp data every 3 h; Rinse is queried live from the browser.

## Setup

1. Create a GitHub repo (e.g. `releasd`), push this.
2. Pages source = **GitHub Actions**:
   `gh api -X POST repos/OWNER/releasd/pages -f build_type=workflow`
   (or Settings → Pages → Source → GitHub Actions).
3. Run the `build` workflow (it also runs on every push and every 3 h). Page: `https://OWNER.github.io/releasd/`.
4. **Sync backend** (optional, but needed for editing from the page and for seen marks across devices):
   a tiny Cloudflare Worker in `worker/`, free tier.

   ```sh
   cd worker
   npx wrangler login                                  # once, opens the browser
   npx wrangler kv namespace create STATE              # paste the returned id into wrangler.toml
   npx wrangler secret put API_KEY                     # long random string, e.g. `openssl rand -hex 24`
   npx wrangler secret put GH_TOKEN                    # fine-grained PAT: only this repo, Contents: read & write
   npx wrangler deploy                                 # prints https://releasd-api.<you>.workers.dev
   ```

   Put the Worker URL into `API_URL` at the top of `site/app.js`, push. Then open the page once per device via your
   personal link `https://OWNER.github.io/releasd/#k=<API_KEY>`; the key is remembered in that browser (settings shows
   the link with a copy button). The GitHub token lives only in the Worker, never in a browser.

   - `GET/PUT /seen` — seen marks in Workers KV, merged per item (last-write-wins), pruned after 180 days.
   - `GET/PUT /config` — reads/commits `config.json` in the repo (a commit triggers the rebuild).
   - CORS is limited to `ALLOWED_ORIGINS` in `wrangler.toml`.
   - `GET /bandcamp` — the built Bandcamp dataset. The Action uploads it via `PUT /admin/bandcamp` (secret `ADMIN_KEY`,
     repo secret `RELEASD_ADMIN_KEY`) only when a build succeeded, so a failed run never blanks the page.
   - `/admin/bc` — Bandcamp egress proxy for the Action: Bandcamp serves a bot-challenge page to GitHub's runner IPs.
   - `POST /refresh` + a 2-hourly cron trigger start the GitHub build (GitHub's own schedule is often delayed);
     both need the GitHub token to also have **Actions: read & write**.

   Without the backend the page still works read-only: edits and seen marks stay in the browser.

## config.json

```json
{
  "days_back": 30,
  "rinse":    { "shows": ["hodge", "josi-devil", "portway"] },
  "bandcamp": { "fan": "gmbt", "labels": ["https://hyperdub.bandcamp.com"], "exclude": ["somesubdomain"] }
}
```

- `rinse.shows` — slugs from `rinse.fm/shows/<slug>`.
- `bandcamp.fan` — your Bandcamp username; profile must be public. All followed artists/labels are included.
- `bandcamp.labels` — extra label/artist URLs not in your follows.
- `bandcamp.exclude` — subdomains (or URLs / band ids) to hide.

## Local

```sh
python3 build.py                      # -> site/data/bandcamp.json, site/config.json
python3 -m http.server -d site 8000   # http://localhost:8000
```

## How it works

- Rinse: Craft CMS GraphQL at `https://admin.rinse.fm/api` (public, CORS `*`). Episodes filtered by `parentShow` slug,
  ordered by `episodeDate`; `episodeTime` only carries the time of day. Rinse "My Rinse" follows are not exposed by any API.
- Bandcamp: the mobile-app JSON API. `fancollection/1/following_bands` → your follows;
  `mobile/24/band_details` → discography with release dates; `mobile/24/tralbum_details` → page URL and tracklist.
  No CORS, hence prebuilt.

Both APIs are unofficial and may change.

## Importing your Rinse follows (untested)

On your My Rinse page, run this bookmarklet; it lists the show slugs linked on the page:

```js
javascript:(()=>{const s=[...new Set([...document.querySelectorAll('a[href*="/shows/"]')].map(a=>a.getAttribute('href').split('/shows/')[1].split(/[/?#]/)[0]).filter(Boolean))];prompt('Rinse show slugs',s.join(', '))})()
```

## Notes

- GitHub disables scheduled workflows on public repos after 60 days without commits. Any edit from the page counts as activity, or re-enable it under Actions.
