# Source tracker

Every live-TV/live-sport source considered for this repository, so the list
can be worked through without re-triaging from scratch. Update this file in
the same commit whenever a source's status changes -- a triage result that
only lives in a chat transcript is lost the next time someone picks this up.
Statuses:

- **implemented** -- shipped as (or as part of) a scraper in `scrapers/`.
- **backend-blocked** -- a specific backend BEHIND an implemented scraper
  resolves to a real stream in research, but can't be delivered under this
  repository's URL-only `ScrapedStream` contract (see AGENTS.md's "What this
  scraper contract cannot do"). Recorded against the parent scraper, not as
  its own row, since the scraper still ships for its other backends.
- **possible** -- a real lead (a stream was actually reached, at least once)
  but needs more work -- an undiscovered resolve step, a gate not yet
  cracked, a result not yet reproduced reliably -- before it's ready to
  build. See each row's note for exactly what's missing.
- **untriaged** -- listed on fmhy.net/video's Live TV / Live Sports sections
  as of 2026-09-28, not yet examined far enough to decide (the note says how
  far it got). Most of these are themselves
  front-ends over a handful of shared backends (dlhd/DaddyLive-family,
  hesgoal-family, streameast-style aggregators) already partly covered by
  `ntvst.mts` or ruled out by `zlive.mts`'s research -- check whether a new
  target actually resolves to one of those before assuming it needs its own
  scraper.
- **rejected** -- examined and ruled out; the reason is recorded so nobody
  retries it blindly.

Source: the "Live TV" and "Live Sports" sections of <https://fmhy.net/video>
(surveyed 2026-09-28). The site's separate "Sports Replays" and "IPTV Tools
& Players" sections are out of scope -- those are on-demand archives and
client apps, not live sources this repository's `Scraper.build()` contract
covers.

Totals: implemented 16 (one with a blocked backend), possible 7, untriaged
~29 (mostly sport-event sites), rejected 29.

Method note for whoever continues: the 2026-09-30 pass probed each site in
headless Chromium with request logging (research only -- see AGENTS.md),
then followed whatever JSON API or embed the page used. Recurring families
worth recognising on sight: iptv-org frontends (ids like `CNN.us`,
`jmp2.uk` links -- nothing new), the dlhd/DaddyLive family
(now `dlhd.mts`), TimStreams (IP-locked), the Streamed/PPV `bundle-jw.js`
embed family (looks obfuscated; it is a plain POST handshake, now `streamed.mts` and `ppv.mts`), and ntv.st reskins
(`livelive24.com`). Note that Node's `fetch` ignores `HTTPS_PROXY` unless
`NODE_USE_ENV_PROXY=1` is set -- in a proxied sandbox, an unexplained 403
from a scraper run may be the proxy, not the site.

## Implemented (17)

| Site | Note |
|---|---|
| [ntv.st](https://ntv.st/) (+ mirrors `ntvs.cx`, `ntvx.link`) | `scrapers/ntvst.mts`. ~10.4k channels across three unrelated backends: `cdnlive` (~4%, per-request randomised-variable JS assembly) and `hesgoales` (~87%, itself `hesgoal.team`→`wideiptv.top` plain JS literal, plus `epicsports-tv.com`'s `decode.php`, ~50% flaky) are both implemented (~91% of the catalogue). The third, `dlhd` (~9%), is still skipped here: those channels come from `dlhd.mts` instead, which covers the whole DaddyLive catalogue. Also builds a separate live-events rail from ntv.st's own sporting-events feed via its `falcon` mirror. |
| [zlive.st](https://zlive.st/) | `scrapers/zlive.mts`. ~201 24/7 channels, plus its own live sporting-events feed merged into the shared "Live Events" rail. Catalogue is plain JSON; resolving a channel needs a real AES-GCM-encrypted request, cracked by running the site's own bundle in a Node `vm` sandbox (see AGENTS.md's reverse-engineering section) -- not just obfuscation, an actual crypto scheme. The handshake CHANGED in Oct 2026 (v4: `GET /nonce`, key `SHA-256(nonce|date|salt|v4)`, nonce echoed as `x`); the old one is still answered with a looping decoy video rather than refused, so both are kept and the working one is detected at runtime. Streams are handles resolved at play time (`resolvers`), because the signed address lasts ~2.5h. The `Primary`/`IPTV` upstreams are dlhd-style PNG-disguised segments (decoder copied from `dlhd.mts`); ~177 of 204 channels are `TimStreams`-sourced and 404 from the house's address (IP-locked/expiring). The events feed (`POST /streams`, same crypto) was empty at implementation time, so its per-event field names are inferred, not confirmed against a real populated response -- see the scraper's own docstring. |
| [Pluto TV](https://pluto.tv/live-tv) | `scrapers/pluto.mts`. ~430 channels (US line-up; whichever region the server is in). Anonymous `boot.pluto.tv/v4/start` gives a 24h JWT; stream URLs carry it. The JWT-less legacy stitcher still answers but serves only a "takedown slate" -- verified, don't regress to it. |
| [vavoo.to](https://vavoo.to/) (+ [kool.to](https://kool.ws/), [huhu.to](https://huhu.to/), [oha.to](https://oha.to/)) | `scrapers/vavoo.mts`. ~7.5k channels / ~10k streams across 17 groups (Europe, Turkey, Arabia...). All four sites are one MediaHubMX addon (vavoo/kool: `mediahubmx-*`, huhu/oha: `mediaurl-*`), identical ids and stream servers. Unsigned `catalog` + `resolve` POSTs; resolved URLs are plain-HTTP `http://<ip>:8008/sunshine/<token>/...m3u8`, still playing after 45+ minutes (true lifetime unknown). ~2 min per build. |
| [Famelack](https://famelack.com/) | `scrapers/famelack.mts`. ~6.1k channels from its public GitHub dataset (`famelack/famelack-data`); overlaps iptv-org heavily, merges centrally. YouTube-only entries skipped. |
| [TVNow](https://tvnow.st/) | `scrapers/tvnow.mts`. ~175 US channels; `/api/channels` gives direct `playback` m3u8s. Playlist and segments need `Referer: https://tvnow.st/`. |
| [TV.Jest](https://tv.jest.one/) + [WorldNews24](https://worldnews24.tv/) | `scrapers/jestone.mts`. Same site, same list (`tvdata.jest.one`). ~11 direct broadcaster news streams (YouTube entries skipped). |
| [Xumo Play](https://play.xumo.com/networks) | `scrapers/xumo.mts`. ~450 US channels via `valencia-app-mds.xumo.com` (`broadcast.json` `ssaiStreamUrl`, or the live asset's provider source). US-only -- works from a US server (this session's egress was US). |
| [SHOWROOM](https://showroom-live.com/) | `scrapers/showroom.mts`. Japanese idol/talent rooms live right now (~50) from the public `api/live/onlives`; HLS plays with no headers. A 30-minute task refreshes the list since a room's URL dies when it goes offline. |
| [CXtv](https://www.cxtvlive.com/) | `scrapers/cxtv.mts`. ~1.8k channels (heavy on Brazilian/LatAm locals); `sitemap.xml` + each page's `data-stream-url`. ~2/3 of a 30-channel sample weren't in iptv-org. ~4 min per build. |
| [vipotv](https://vipotv.com/) | `scrapers/vipotv.mts`. WordPress directory; REST API lists posts/country categories, each page's `livetv.work/fireplayer` iframe hash resolves via `?do=getVideo` to a plain m3u8. ~1.2k channels; ~60% of a 25-channel sample weren't in iptv-org. Slow: pages take 5-11s each, so a build is ~16 min. |
| [Futbol-X](https://www.futbol-x.xyz/) | `scrapers/futbolx.mts`. Sport events from `/api/<category>.json` with direct m3u8s (`Referer` required); hourly task, shared "Live Events" rail. Only 2 upcoming events at implementation time. |
| [DaddyLive](https://dlhd.st/) (`dlive.sx`; also behind DaddyLiveHD, Watchott Live, TV247US, DamiTV's dlhd half) | `scrapers/dlhd.mts`. ~930 24/7 channels from `/24-7-channels.php` plus today's schedule (~30 events in a window around now) on the shared "Live Events" rail. Every stream is `edge.<host>/premium<id>/index.m3u8` (host learnt from one player page per build). Segments are PNGs with the TS gzipped into the pixels; the scraper ships a `tiktikpx` segment decoder and live-tv runs it on every segment through its relay. **Needs live-tv with segment decoders**; on a host without them these streams are dropped, not offered broken. |
| [CricHD](https://crichd.at/) | `scrapers/crichd.mts`. Server-rendered cricket listing: the home page's `data-start`/`data-end` say which matches are live, each `/events/<slug>` page is a table of sources (channel, quality, language, `hitsportshdd.xyz/fr.php?src=<embed>`). Each live match is one card on the shared "Live Events" rail and an identical "Live Cricket" rail, with every supported source as a stream; each source is also emitted as a plain channel named the way iptv-org spells it (looked up in its `channels.json` incl. alt names) so it merges as a mirror. Three embed families resolve over plain HTTP, as play-time `resolvers` (signed URLs last ~2.5h): `dembed.top` (the dlhd backend, PNG segments -> `tiktikpx` decoder), `trendy48` (`exmxbxe.cfd`, player config in an XOR-and-shift number array, decoded without eval; same PNG segments) and `streame.center` (Referer-locked; feed was off-air at implementation, segment format unverified). A fourth family, `embed.st/embed/<source>/<id>/<n>` (the Streamed player), resolves with the handshake of `streamed.mts` copied in (needs live-tv 1.10.0; `tiktikpx` unwraps its WebP segments; verified 2026-10-03 through the host relay for `admin-willow-cricket`), as does `embedindia.st` (PPV.ST's twin, none linked yet). **Not resolvable**: `s1.vertex.st` (-> `lineagest.click`, encrypted config + devtools-hostile bundle, never requested a stream in headless Chromium). The "Quality" column was a constant 1500 and "Ads" a constant 3 on every row seen; labels can be wrong (a "Willow" row linking `ch=sonysportsnetwork-in`), hence the slug cross-check. Needs live-tv 1.6.0 (resolvers). |
| [CricWeb](https://cricweb.vip/) (front for `live.mhdtv.online`) | `scrapers/cricweb.mts`. Cricket + football fixtures (live and next 12h) and a ~25-channel TV grid, read from the home page's `event-card`s and each `live.mhdtv.online/watch/<slug>` page (`data-stream-button`s, or a lone iframe/video). Fixtures go on "Live Events", "Live Cricket" and "Live Football" rails; the card's logo is the home side's flag/crest. The site's `data-status` is stale (Sep 30 fixtures still "live" on Oct 3) and `data-sport="cricket"` is set on football friendlies, so liveness comes from `data-event-ms` + a per-sport window and sport from the league title. Plain sources (`sportzfy24.com/m3u8.php?id=<m3u8>`, `playyyz1.cc/e?hls=<m3u8>`, `hls` buttons) are direct URLs. **Encrypted DASH is delivered as `ScrapedStream.clearKey`** (live-tv 1.8.0; the host decrypts with ffmpeg and serves HLS): `api.sportzf*.com/drm/player.php` pages (JSON constants `MANIFEST_URL`/`DRM_KID`/`DRM_KEY`/`STREAM_HEADERS`) and `dash` buttons with `data-stream-kid/key`. 2026-10-03, through the real host relay: 8 of 18 encrypted streams decoded to video; the rest were off air or 403 (a geo-locked Russian CDN for the Mat4 set). Not playable: `1freecdn.xyz` (P2P loader), `tmaxapp.site` (packed), plusbox, YouTube, keyless `dash`. Many direct hosts (`livetl00x`, `gpcdn.net/bpk-tv`, tapmad's) 403 from the research machine whatever the Referer -- probably geo/IP, offered anyway. Recognised sources are also emitted as channels under iptv-org's spelling (alt names trusted only on sports channels). The "Tapmad" grid page is a hub of unrelated channels (TSN, FOX, ITV, Sky Cricket...) and currently lands them all as mirrors of one "Tapmad" channel; the button labels say which is which. |
| [Streamed](https://streamed.pk/) (+ `streamed.st`; also behind Reedstreams, SportsBite, probably Fantastic Soda) | `scrapers/streamed.mts`. The largest free live-sport catalogue: `/api/matches/live` (~150-200 events at peak, football, NFL/NCAA, MLB, NHL, boxing/UFC PPV, motorsport) + `/api/stream/<source>/<id>` for the stream list (sources `admin`, `delta`, `hotel`, `foxtrot`, `golf`; only ~1/3 of listed sources have streams, and `foxtrot`/`golf` answered 404/403 on every title today). Each stream is a handle resolved at play time by the embed's own handshake: `POST embed.st/fetch` with a protobuf `{source, id, streamNo}` -> a base64-ish text in a fixed alphabet whose ChaCha20 key is the `goat` response header, giving a `lbN.strmd.st/secure/<token>/.../playlist.m3u8` (Referer `https://embed.st/`). Found by snapshotting the `lock.wasm` player's memory; none of the site's code runs. Segments are WebP images with the MPEG-TS inside (`admin`: EXIF chunk; `hotel`: straight after the VP8L stub; `delta`: bare TS) -> `webpexif` decoder. A feed whose newest segment is gone (404, or Akamai "Access Denied" after the redirect) resolves to null (1.3.0, 2026-10-04; ~11 of 37 delta feeds were dead that day). Verified 2026-10-03 through the real host relay: 1080p/540p H.264 + AAC decodes for admin/delta/hotel. **The CDN 403s Node's TLS 1.3 handshake** (curl/ffmpeg/browsers and Node at TLS 1.2 get 200) -- this is what the old rejection mistook for fingerprinting-without-a-fix; live-tv >= 1.10.0 retries a 403 at TLS 1.2. `/fetch` rate-limits (~40 burst), so the resolver paces itself. Needs live-tv 1.10.0 (the resolver needs 1.6.0, the TLS 1.2 retry 1.10.0). Several mirror domains are DNS-blocked in some countries (a German ISP's CUII list); the scraper tries three. |
| [PPV.ST](https://ppv.st/) (+ SportOnTV, 90minutes, DamiTV's PPV half, SportsBite's PPV half) | `scrapers/ppv.mts`. `api.ppv.st/api/streams` is plain JSON (~70 entries: US football/hockey/baseball/basketball, combat sports, motorsport, ~13 always-live channels such as NFL Network and Fox Footy); only events inside their window are offered, with `substreams` (e.g. SkyCast feeds) as extra streams on the same card. Each stream is a handle resolved at play time by the embed's own handshake: `POST embedindia.st/fetch` with a protobuf of the embed's path -> the SAME alphabet and ChaCha20 as Streamed, but the key's response header is `island`, not `goat` (every 32-letter header is tried now, `streamed.mts` too). Playlist `https://<edge>.indianservers.st/secure/...index.m3u8` needs `Referer: https://embedindia.st/`; segments are TikTok-CDN WebPs with the TS in an EXIF chunk (`webpexif`). Verified 2026-10-03 through the real host relay: 8 of 8 streams decode to 1080p H.264 + AAC. The earlier rejection ("embed does not initialise headless") was wrong in the same way as Streamed's: a plain POST, no browser needed. Needs live-tv 1.10.0. |

### Formerly backend-blocked

`dlhd` (PNG-wrapped segments) was listed here until the scraper contract
gained segment `decoders` (`ScrapedStream.decoder`) and live-tv
a relay that runs them -- see `dlhd.mts`. The decoder is a straight port of
`daddyliveplayer.st`'s own `unwrap()`.

## Possible (6)

| Site | What's missing |
|---|---|
| [Pitsport](https://pitsport.st/) | Clean JSON (`/api/v1/live-now`, `/api/v1/programs/<id>/play`) -> `embdlol.st/embed/<uuid>` -> `POST api.embdlol.st/watch {watchId}` answers a plain `prod-*.tonzoidio.st/out/v1/channel(<code>)/index.m3u8` plus an `hmk-token`. That URL 403s to curl with Referer/Origin and with `hmk-token` as a header, and headless Chromium never requested it within 12s -- the final gate is unidentified (a worker? a header name other than `hmk-token`?). |
| [RoxieStreams](https://roxiestreams.su/) | Static URL scheme found in the page source: `https://<subdomain, e.g. tedesco>.<random line of /domainsz77.txt>/<channel>.m3u8`. Every stream host Cloudflare-blocked this sandbox ("Attention Required", even in Chromium), so playback couldn't be confirmed -- retest from a different network. |
| [xyzstreams](https://xyzstreams.st/) | 24/7 channels play from a fully static scheme in `/247.html?<n>`: `https://xyzstreams.blog/3/<n>.m3u8` or `https://fishing342.b-cdn.net/3/<n>.m3u8`, with the channel list inline in the homepage JS (`{ id, displayName, embedUrl: '/247.html?<n>', logo }`). Both hosts answered 403/502 from this sandbox (with and without Referer), and headless Chromium never requested either -- retest from another network. |
| [AwardStreams](https://awardstreams.pages.dev/) | One hard-coded restream (`streamthe.awardshere.link/out/v2/<id>/index.m3u8`, in `/players/clappr`) that only answers during award shows (404 otherwise). Would need a short-interval task emitting one channel while it's up. Low value. |
| [NontonGP](https://esp32.nontonx.com/) | MotoGP only. `/mgpplayer2` hard-codes a pile of m3u8s, most stale; the one currently playing (`master3.s2stream.top/hls/stream.m3u8`) needs `Referer: https://esp32.nontonx.com/`. Needs a rule for picking the live URL out of the page. Low value. |
| [F1 Live](https://flive.dpdns.org/) | Plays via `ddelta.flive.dpdns.org/embed/racing/<ch>`, which this sandbox's egress could not reach (tunnel failed). Untested beyond that. |

## Untriaged (~30)

Mostly live-sport event sites. Each needs its own event -> embed -> stream
trace; the 2026-09-30 headless pass got as far as the note says.

| Site | Note |
|---|---|
| [StreamSports99](https://streamsports99.ru/) (+ mirrors) | Not probed past the homepage (client-rendered). |
| [SportsindX](https://sportsindx.st/) | Unreachable from this sandbox (connection failed). |
| [WatchSports](https://watchsports.st/) (+ `.su`) | Unreachable from this sandbox (connection failed). |
| [LiveTV](https://livetv.sx/enx/) | Unreachable to curl; blank page in headless Chromium. |
| [StreamCorner](https://streamcorner.st/) (+ mirrors) | Homepage is a blob-script loader that rendered `about:blank` headless. |
| [StreamEast](https://streameast.ga/) (+ mirrors) | `v2.streameast.ga`, behind an `auth.streamea.st` SSO hand-off and a "buy premium" wall; free streams not located. |
| [StreamFree](https://streamfree.top/) | Has `/player/<sport>/<slug>` pages and `strmfree.link/api/domains`; embed not traced. |
| [Watch Footy](https://watchfooty.st/) | Next.js app, `/en/match/<id>` pages; embed not traced. |
| [Sportsurge](https://v2.sportsurge.net/) | Cloudflare Turnstile ("Just a moment...") even in Chromium. |
| [TotalSportek](https://total-sportekk.st/) | No stream links reached from the homepage. |
| [Tap4Sport](https://tap4sport.st/) (+ mirrors) | Cloudflare Turnstile even in Chromium. |
| [CMVTV](https://cmvlinks.lovable.app/) | Lovable SPA using SofaScore for fixtures; streams not traced. |
| [Fantastic Soda](https://fantasticsoda.com/) | Uses a Streamed-style `/api/matches/all` (empty to curl) -- probably another Streamed mirror, unconfirmed; if so `streamed.mts` already covers it. |
| [FSL](https://freestreams-live1h.pk/) | Blob-script loader; no player reached. |
| [Streami](https://streamic.st/) | Loads `/api/J.php`; not traced. |
| [FalconStreams](https://falconstreams.app/) | Next.js; no player reached. |
| [TheTVApp](https://thetvapp.plus/) | `/watch/<league>-streams` listing pages; per-game player not traced. zerostream links `tvpass.org/live/<Channel>/hd`, probably the same family. |
| [MainPortal66](https://mainportal66.com/) | Links portal; not traced. |
| [FCTV33](https://www.fctv33hd.co/) | Redirects to `fctv33hd.uno`; calls `apis-data10.tcllu137fien.ru/api/common/params`; not traced. |
| [VIP Box Sports](https://vipleague.me/home) (+ mirrors) | `/watch-now`; not traced. |
| [FawaNews](http://www.fawanews.sc/) | 403 from this sandbox. |
| [Baked.live](https://baked.live/) | No player reached. |
| [NBAMonster](https://nbamonster.com/) | Redirects to `/vp33/`; not traced. |
| [OnHockey](https://onhockey.tv/) | Homepage shows standings widgets; per-game embeds not traced. |
| [OvertakeFans](https://overtakefans.com/) | `/f1-live-stream/` has no player in its static HTML; needs a live session to trace. |
| [Tiz-Cycling](https://tiz-cycling.tv/) | Mostly replays (out of scope); live pages not traced. |
| [Rugby24](https://rugby24.net/) | Cloudflare Turnstile even in Chromium. |
| [Strims24](https://strims24.pl/) / [Strumyk](https://strumyk.pk/) | Same backend (`/api/v1/<sport>/<date>` -> Flashscore match ids). Match pages carried no stream links when checked -- likely link-aggregators that only fill in near kick-off. |
| [r/rugbystreams](https://www.reddit.com/r/rugbystreams/) | A subreddit -- per-post link scraping, a different shape of scraper. |
| [Sportarr](https://sportarr.net/) | Self-described *arr-style automation tool, likely a client rather than a source. |

## Rejected (29)

| Site | Reason |
|---|---|
| [Live24](https://livelive24.com/) | Its own "API" link points straight at `livelive24.com/test/ntv/ntv.json` -- a reskin serving ntv.st's own data, not an independent source. `ntvst.mts` already covers the underlying catalogue (and separately uses this same site as its `falcon`-mirror event-resolution backend for `dlhd`-family events, which is unrelated to its 24/7-channel reskin). |
| [90minutes](https://www.90minutes.pro/) | Serves DamiTV's public API (PPV-family data), embed URLs only by design. |
| [SportOnTV](https://sportontv.click/) | Front-end over `api.ppv.st` (PPV, above). |
| [SportsBite TV](https://sportsbite.org/channels) | Aggregates PPV's and Streamed's APIs; its own 24/7 embeds bounced headless Chromium back to the homepage. The Streamed half is now `streamed.mts`; the PPV half is under *Possible*. Nothing of its own. |
| [TimStreams](https://timst.cfd/) | `timst.top/api/channels` is clean JSON, but each stream goes `exmxbxe.cfd/<id>` -> 302 `/play/<ts>.<sig>.<slug>`, an IP-locked page ("Access Denied (IP Lock)" from a different egress IP) whose obfuscated inline script (run in `node:vm` with jwplayer stubbed) yields `.../main/secure/<hash>/<expiry>/<slug>.m3u8` (zlive's backend URL family) expiring ~2.5h out; replay 404'd. Headless Chromium gets bounced to a decoy. IP-bound + shorter than a rebuild = unusable. |
| [DamiTV](https://damitv.st/livetv) | `/data/ts-channels.json`: 165 TimStreams channels (via `messi.damitv.st/papi/ts2/...`, all 502 when tested) + 38 dlhd (covered by `dlhd.mts`). The TimStreams half stays rejected. |
| [BINTV](https://www.bintv.cc/) (+ `cosectv.com`) | Reads `timst.top` (TimStreams) plus a Lovable "event-decoder" API over Streamed images -- front-end over rejected backends. |
| [Matchora](https://matchora.to/) | Clean `/api/v1/live` with per-channel `/api/play/<id>`, but the resulting `edge.matchora.pro/hls/<id>/index.m3u8?t=` token is `base64(id|expiry|sig)` with a 10-minute expiry; even the browser's own refetch 403'd. |
| [Guide TV](https://guidetv.live/) | Streams via `livelive24.com` (an ntv.st reskin, see Live24) with short-lived `wsSecret`/`wsABSTime` CDN tokens. |
| [Cinevid](https://cinevid.st/iptv/) | Aggregator over backends already covered: `tvn` = tvnow.st proxied (same media sequence), `cdn-live` = ntv.st's cdnlive (301/581 channels), `tms` returned `{"streamUrl":null}` for every channel tried, `stream` ECONNREFUSED. |
| [TVAtlas](https://tvatlas.app/) | Static iptv-org snapshot (`/data/channels/<cc>.json`, iptv-org ids). |
| [FreeTVGarden](https://freetvgarden.com/) | iptv-org API client. |
| [WatchTVs](https://watchtvs.live/) | `/tvgarden/` is a FreeTVGarden reskin (iptv-org); the rest is radio/music. |
| [EasyWebTV](https://zhangboheng.github.io/Easy-Web-TV-M3u8/routes/tv.html) | iptv-org API client. |
| [TV Explorer](https://tvexplorer.live/) | iptv-org (ids like `BBCEarth.uk`, `jmp2.uk` links). |
| [IPTV Web](https://iptv-web.app/) | Static site over iptv-org (`/AF/ShamsTV.af/`-style pages). |
| [Global Free TV](https://www.globalfreetv.com/) | iptv-org (`/channels/MiamiTV.us`-style pages). |
| [1TUbe](https://www.1tube.org/live-tv) | Loads `iptv-org.github.io/iptv/index.m3u` plus YouTube. |
| [SquidTV](https://www.squidtv.net/) | Link directory to broadcasters' own websites; no streams of its own. |
| [TVCL](https://www.tvchannellists.com/) | Cloudflare hard block ("Attention Required") from datacenter IPs even in Chromium -- which is also what a live-tv server would get; a channel directory per its own description anyway. |
| [TitanTV](https://titantv.com/) | US TV listings/EPG app; no streams. |
| [Puffer](https://puffer.stanford.edu/) | `/player/` requires an account (Stanford research study). |
| [Vegeta TV](http://vegetatv.duckdns.org/) | Front-end over an Xtream-Codes panel cache behind its own account/auth API -- a login-gated relay of paid-IPTV credentials. |
| [Koryo TV](https://koryo.tv/) | KCTV via `edge-*.koryo.tv`; `/session/anon` and the playlist 404 outside the page's own session, and the browser's own playlist refresh 401'd within seconds -- per-session cookie gate. |
| [KCNA](https://kcnawatch.us/korea-central-tv-livestream) | Livestream page 302s to a member sign-up form behind Cloudflare Turnstile. |
| [Rive IPTV](https://www.rivestream.app/iptv) | Its `/api/backendfetch?requestID=liveSportsLiveTvChannels` returns the app's HTML shell even to the real page in a real browser -- backend broken/moved. |
| [Zerostream](https://zerostream.alwaysdata.net/) | Mostly anime/VOD. Live part: a 16-entry gist M3U on a server iptv-org already lists, `tvpass.org` links (TheTVApp family) and `slingtv-proxy` iframes. |
| [Score808](https://score808hd.tv/) | Dead: Cloudflare 522 (origin timeout) on 2026-09-30. |
| [VenueVault](https://venuevault.live/) | Dead: Cloudflare 526 (invalid origin certificate) on 2026-09-30. |
