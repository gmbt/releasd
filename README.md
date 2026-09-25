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
4. Optional, to edit shows/labels from the page: create a **fine-grained PAT**
   (GitHub → Settings → Developer settings → Fine-grained tokens): repository access = only this repo,
   permission **Contents: Read and write**. Paste it into the page's *settings*. It is stored only in your browser.
   Every edit becomes a commit to `config.json`, which triggers a rebuild (~5 min). Without a token, edits stay in the browser.
5. The same token syncs your **seen** checkmarks across devices: they are written to `seen.json` on a `state` branch
   (created automatically; never triggers a build). Per-item last-write-wins, so phone and laptop can be used interchangeably.

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
