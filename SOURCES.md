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

## Infrastructure (not a channel source)

| What | Note |
|---|---|
| Proxy pool | `scrapers/proxy-pool.mts`. Returns no channels; exports `proxies` (per-country HTTP proxies, tested for exit country, latency, jitter, HTTPS speed and reliability, scored 0-100). live-tv uses it for any stream with `country` set and lists it on its VPN settings page. Candidates: proxifly, proxyscrape (repo + API), maximilianfeix, GeoNode, monosans, Thordata, spys.me, free-proxy-list.net family, TheSpeedX/clarketm/jetkai/MuRongPIG/vakhov/ShiftyTR/roosterkid/ErcinDedeoglu/Anonym0usWork1221/mmpx12/rdavydov/hideip.me and the lists gfpcom indexes, geolocated via ip-api batch. Reddit rejected: unauthenticated JSON/search/RSS answer 403 (2026-10-05). First live run 2026-10-05: DE gave 4 proxies at 48-78 Mbit/s and 26-61 ms, ES 1; free-proxy supply per country is thin, so expect a handful. 2026-10-05, v1.2.0: US needed ~4000 candidates tested (about 1 in 400 survives) and gave 8 proxies at 80-97, 8-18 Mbit/s; a list entry with a leading zero in an address (`078.84.81.60`) once threw out of `build()`, fixed. |

## Implemented (32)

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
| [Pitsport](https://pitsport.st/) | `scrapers/pitsport.mts`. Events only (~11 live: Nations League, NFL/MLB/NBA, NASCAR, F1...). `/api/v1/live-now` -> `/api/v1/programs/<id>/play` (`videos[].embedUrl` = `embdlol.st/embed/<uuid>`, one per mirror) -> `POST api.embdlol.st/watch {watchId}` -> `prod-eN.tonzoidio.st/hmk/<token>/out/v1/channel(<code>)/index.m3u8`. **No header is needed at all** -- the earlier "unidentified final gate" did not exist (the `hmk-token` is in the URL path, and the playlist, variants and segments answer with no Referer/Origin/token header). Segments are TikTok-CDN WebPs with the TS inside (`webpexif`, same as Streamed/PPV); `onAir` checks the newest segment. Verified 2026-10-04 through the real host relay: 11 of 11 streams decode (1080p H.264 + AAC). Needs live-tv 1.6.0 (resolvers). |
| [RoxieStreams](https://roxiestreams.su/) | `scrapers/roxiestreams.mts`. Events only (US sport, football, fighting, motorsport; ~4-20 live). Sport pages list rows with Pacific-time starts; each event page's `getRandomStream('<feed>.m3u8', '<sub>')` buttons build `https://<sub>.<domain from /domainsz77.txt>/<feed>.m3u8`: plain HLS, MPEG-TS `.js` segments, no header. Feeds are shared 24/7 restreams, so a mirror is kept only when its newest segment fetches. Reachable from here since the DoH patch (the earlier "Cloudflare-blocked" note was the ISP's DNS). |
| [CDN Live TV](https://cdnlivetv.is/) (front-ends: Fantastic Soda, StreamSports99; its channel list is also `ntvst.mts`'s `cdnlive` backend) | `scrapers/cdnlive.mts` (1.1.0). Events from the documented `api.cdnlivetv.is/api/v1/events/sports/?user=cdnlivetv&plan=free` (UTC starts, teams, tournament, a channel list per event). Most listed channels are off air, so the first few whose stream answers are kept; handles are resolved at play time by unwrapping the randomised-variable player page (same shape as ntvst's `cdnlive`), paced to the site's 100 requests a minute. 1.1.0 also lists the 24/7 channels from `/api/v1/channels/` (the ~165 marked online; about half of those serve anything, the resolver returns null for the rest). |
| [WatchFooty](https://watchfooty.st/) (`sportsembed.su` players) | `scrapers/watchfooty.mts`, events only (the API has no channels). `api.watchfooty.st/api/v1/matches/live` is plain JSON with teams, league, sport and a start in ms; each feed's `url` is a `sportsembed.su/embed/...` page. The old "WASM lock" verdict was wrong the way the Streamed one was: `stream-lock.wasm` has **zero imports** and four exports, so it is fetched at resolve time and called as a black box (`op 23` -> factor, `op 41` -> proof, `op 59` -> the playlist URL; layout in the scraper's header) around one `POST /api/get`. Playlists need `Referer: https://sportsembed.su/`; segments are bare TS served as `image/png` from throw-away image hosts. `prime`, `pro`, `deluxe`, `platinum` carry video; `delta`/`hotel` are mostly off air. Verified 2026-10-04 through the real relay: 11 of 14 feeds TS (3 had died between listing and playing), ffmpeg 720p H.264 + AAC. |
| [Samsung TV Plus](https://www.samsung.com/us/televisions-home-theater/tvs/tv-plus/) | `scrapers/samsungtvplus.mts`, 24/7 channels (~2,600 across US, UK, CA, DE, AT, CH, FR, ES, IT, IN, KR). Channel list: matthuisman's `i.mjh.nz/SamsungTVPlus/.channels.json.gz` (a GitHub mirror, gzip JSON, Samsung's own ids). Stream: `jmp2.uk/stvp-<id>` 302s to a Google DAI HLS master; a resolver follows that redirect at play time. 2026-10-04: 7 of 14 spread samples decode with ffmpeg from Germany; the rest are region-locked or off air (the resolver returns null, the host drops them). |
| [The Roku Channel](https://therokuchannel.roku.com/) | `scrapers/rokuchannel.mts`, 24/7 channels (~240, US). List: `i.mjh.nz/Roku/.channels.json.gz`; stream: `jmp2.uk/rok-<id>.m3u8` 302 to `aka-live*.delivery.roku.com/.../live.m3u8` (User-Agent `rokuandroid`), resolved at play time. 2026-10-04: 14 of 14 spread samples decode. |
| [Free-TV/IPTV](https://github.com/Free-TV/IPTV) | `scrapers/freetv.mts`, 24/7 channels (~1,600, by country). One hand-curated `playlist.m3u8`; YouTube/Twitch/Pluto/VOD entries skipped, same-name duplicates merged into one channel with several streams, geo-blocked ones labelled. 2026-10-04: 17 of 30 spread samples decode (static community list; the host probes the rest). |
| [TimStreams](https://timst.cfd/) (also DamiTV's TimStreams half, BINTV) | `scrapers/timstreams.mts`, 184 24/7 channels plus live events. `timst.top/api/channels` and `/api/live-upcoming` are plain JSON (event times are US Eastern). Each stream is `grandemx.org/<id>` -> 302 `/play/<ts>.<sig>.<slug>`, a page that is IP-locked to the caller (the earlier rejection was a research machine versus another egress; a resolver runs on the host, so it matches) whose inline script holds the signed m3u8 in a number array decoded by two integers (`(a[i] ^ KEY) - SUB + 256) % 256`), no code is run. The playlist needs a browser User-Agent (Node's own gets 404); segments are WebP-wrapped TS on TikTok's CDN, handled by `decoders.webpexif` (as Streamed). 2026-10-05 through the real relay: 11 of 11 events and 20 of 30 channels decode. |
| [NZ & AU TV](https://i.mjh.nz/nzau/raw-tv.m3u8) | `scrapers/nzau.mts`, ~144 24/7 channels (Three/ThreeNow, TVNZ, Sky's free and pop-up channels, Trackside, Māori TV, regional and Australian networks). One community M3U (matthuisman's i.mjh.nz) whose entries are `i.mjh.nz/.r/<slug>.m3u8` redirects to each broadcaster's stream; a resolver follows it at play time (User-Agent `otg/1.5.1 ...`). Broadcaster geo-fences apply: 2026-10-05 from Germany 5 of 10 spread samples decode (Three itself is 403). |
| [kodinerds IPTV](https://github.com/jnk22/kodinerds-iptv) | `scrapers/kodinerds.mts`, ~45 German free-to-air channels straight from the broadcasters' masters (ARD, ZDF, arte, WELT, the third programmes ...). 2026-10-05: 12 of 14 spread samples decode. |
| [M3UPT](https://github.com/LITUATUI/M3UPT) | `scrapers/m3upt.mts`, ~155 Portuguese channels (the list's `TV` group; its VOD, webcam and radio groups are skipped). `#EXTVLCOPT` User-Agent/Origin/Referer lines are carried onto each stream (RTP needs them). 2026-10-05: 9 of 14 spread samples decode without the options; RTP's need them. |
| [TDTChannels](https://www.tdtchannels.com/) | `scrapers/tdtchannels.mts`, ~440 24/7 channels with an HLS address (Spanish national, regional and local TV by autonomous community, plus international, music and religious). One JSON (`/lists/tv.json`: countries > ambits > channels > `options[{format,url,geo2,res}]`); YouTube/`stream` options skipped, ad macros dropped from addresses, geo options labelled. 2026-10-05: 12 of 16 spread samples decode from Germany. |
| [Rakuten TV](https://rakuten.tv/) | `scrapers/rakuten.mts`, ~105 free linear channels over five markets (DE, ES, FR, IT, UK). `gizmo.rakuten.tv/v3/live_channels` is public; `POST /v3/avod/streamings` (audio language taken from the channel's own label, `subtitle_language: MIS`) answers an AWS MediaTailor master. The market must match the caller's country (`error.geo_market_not_allowed_for_user_market` otherwise), so each channel has one handle per market and the resolver returns null for the markets the host is not in. 2026-10-05 from Germany: the German market resolves and decodes (3 of 4 samples; France 24 is an ffmpeg format quirk, not retested through the relay). |

### Formerly backend-blocked

`dlhd` (PNG-wrapped segments) was listed here until the scraper contract
gained segment `decoders` (`ScrapedStream.decoder`) and live-tv
a relay that runs them -- see `dlhd.mts`. The decoder is a straight port of
`daddyliveplayer.st`'s own `unwrap()`.

## Possible (5)

| Site | What's missing |
|---|---|
| [xyzstreams](https://xyzstreams.st/) | 24/7 channels play from a fully static scheme in `/247.html?<n>`: `https://xyzstreams.blog/3/<n>.m3u8` or `https://fishing342.b-cdn.net/3/<n>.m3u8`, with the channel list inline in the homepage JS (`{ id, displayName, embedUrl: '/247.html?<n>', logo }`, 93 entries). 2026-10-04 (with DoH): `xyzstreams.blog` answers 502 and the bunny.net host says "Domain suspended or not configured" -- the backend is down; retry when it is back. |
| [AwardStreams](https://awardstreams.pages.dev/) | One hard-coded restream (`streamthe.awardshere.link/out/v2/<id>/index.m3u8`, in `/players/clappr`) that only answers during award shows (404 otherwise). Would need a short-interval task emitting one channel while it's up. Low value. |
| [NontonGP](https://esp32.nontonx.com/) | MotoGP/F1/WSBK. 2026-10-04: `/formulaplayer1`, `/mgpplayer2`, `/wsbkplayer1`, `/randomplayer` and `/clearkey` hold a hand-pasted pile of m3u8s (base64-wrapped `http://<ip>:<port>/hls/stream.m3u8` behind `edge*.s1stream.cfd`-style hosts, a Jerez 2026 master, an expired footprint.net token); nothing says which is live. Needs a rule for picking the live URL; low value. |
| [SportsOnline](https://sportsonline.st/) | `prog.txt` is a plain-text weekly schedule (`HH:MM  A x B | https://<host>/channels/<hd|pt|bra>/<name>.php`, times unlabelled) and `247.txt` lists 24/7 sports channels the same way. Each `.php` iframes `assetrage.net/e/<id>` (Clappr + a 150 KB page whose source is a layered `window._econfig` base64 blob decoded by an obfuscated 89 KB `/assets/stream.js`). The first base64 layer unwraps, the second is binary; the decode is in `stream.js`. 2026-10-05: a research job like WatchFooty's was (trace `stream.js`, probably a zero-import decode), not started. Worth it: events plus ~40 channels. |

## Untriaged (19)

Mostly live-sport event sites. Each needs its own event -> embed -> stream
trace; the 2026-09-30 headless pass got as far as the note says.

| Site | Note |
|---|---|
| [LiveTV](https://livetv.sx/enx/) | Unreachable to curl; blank page in headless Chromium. |
| [StreamCorner](https://streamcorner.st/) (+ mirrors) | Homepage is a blob-script loader that rendered `about:blank` headless. |
| [StreamEast](https://streameast.ga/) (+ mirrors) | `v2.streameast.ga`, behind an `auth.streamea.st` SSO hand-off and a "buy premium" wall; free streams not located. |
| [Sportsurge](https://v2.sportsurge.net/) | Cloudflare Turnstile ("Just a moment...") even in Chromium. |
| [TotalSportek](https://total-sportekk.st/) | No stream links reached from the homepage. |
| [Tap4Sport](https://tap4sport.st/) (+ mirrors) | Cloudflare Turnstile even in Chromium. |
| [FSL](https://freestreams-live1h.pk/) | Blob-script loader; no player reached. |
| [MainPortal66](https://mainportal66.com/) | Links portal; not traced. |
| [FCTV33](https://www.fctv33hd.co/) | Redirects to `fctv33hd.uno`; calls `apis-data10.tcllu137fien.ru/api/common/params`; not traced. |
| [VIP Box Sports](https://vipleague.me/home) (+ mirrors) | `/watch-now`; not traced. |
| [FawaNews](http://www.fawanews.sc/) | 403 from this sandbox. |
| [NBAMonster](https://nbamonster.com/) | Redirects to `/vp33/`; not traced. |
| [OnHockey](https://onhockey.tv/) | Homepage shows standings widgets; per-game embeds not traced. |
| [OvertakeFans](https://overtakefans.com/) | `/f1-live-stream/` has no player in its static HTML; needs a live session to trace. |
| [Tiz-Cycling](https://tiz-cycling.tv/) | Mostly replays (out of scope); live pages not traced. |
| [Rugby24](https://rugby24.net/) | Cloudflare Turnstile even in Chromium. |
| [Strims24](https://strims24.pl/) / [Strumyk](https://strumyk.pk/) | Same backend (`/api/v1/<sport>/<date>` -> Flashscore match ids). Match pages carried no stream links when checked -- likely link-aggregators that only fill in near kick-off. |
| [r/rugbystreams](https://www.reddit.com/r/rugbystreams/) | A subreddit -- per-post link scraping, a different shape of scraper. |
| [Sportarr](https://sportarr.net/) | Self-described *arr-style automation tool, likely a client rather than a source. |

## Rejected (38)

| Site | Reason |
|---|---|
| [Fantastic Soda](https://fantasticsoda.com/) | Front-end over `streamed.pk` (`/api/matches/...`, `streamed.mts`), the cdnlivetv API (`cdnlive.mts`) and StreamFree's API (`streamfree.mts`). Nothing of its own. |
| [StreamSports99](https://streamsports99.ru/) (+ `streamsports99.is`, `v4.streamsports99.tv`) | React front-end over `api.cdnlivetv.is` -- `cdnlive.mts`. |
| [SportsindX](https://sportsindx.st/) / [WatchSports](https://watchsports.st/) | Same page (41 KB, `/match/<slug>` with a `data-links` JSON): link lists to `strmfree.st` (StreamFree), `embed.st` (admin/delta/hotel/golf: Streamed), `rockystream.st` and `sportspatrika.com`. Nothing of its own that the covered backends don't already give. |
| [FalconStreams](https://falconstreams.app/) | `/live/<league>/match/<slug>/<id>` pages that are link lists to ~40 third-party sites per game (`embed.st`, `castppv.cfd`, `4kplayerx.cyou`, ...), each its own gate. An aggregator, not a source. |
| [Streami](https://streamic.st/) | `/api/J.php` is JSON but holds ~3 events whose embeds are `embedindia.st` (PPV, `ppv.mts`), `epiembeds.online`/`lovetier.bz` (unreachable here) and `videocdn-47xx.website` (403). |
| [CMVTV](https://cmvlinks.lovable.app/) | A static, hand-curated list of ~40 stream URLs baked into the bundle and wrapped by a lovable.app proxy (`<b64 url>?h=<b64 headers>`): fawanews/Dailymotion/rutube hot-links, no fixture feed. SofaScore is only for logos. |
| [Baked.live](https://baked.live/) | A CyTube (`calzoneman/sync`) instance: rooms (`/tv/NJPW`, `/tv/Wrestling`, ...) play queued Dailymotion/YouTube items over a socket, not HLS. |
| [Live24](https://livelive24.com/) | Its own "API" link points straight at `livelive24.com/test/ntv/ntv.json` -- a reskin serving ntv.st's own data, not an independent source. `ntvst.mts` already covers the underlying catalogue (and separately uses this same site as its `falcon`-mirror event-resolution backend for `dlhd`-family events, which is unrelated to its 24/7-channel reskin). |
| [90minutes](https://www.90minutes.pro/) | Serves DamiTV's public API (PPV-family data), embed URLs only by design. |
| [SportOnTV](https://sportontv.click/) | Front-end over `api.ppv.st` (PPV, above). |
| [SportsBite TV](https://sportsbite.org/channels) | Aggregates PPV's and Streamed's APIs; its own 24/7 embeds bounced headless Chromium back to the homepage. The Streamed half is now `streamed.mts`; the PPV half is under *Possible*. Nothing of its own. |
| [DamiTV](https://damitv.st/livetv) | `/data/ts-channels.json`: 165 TimStreams channels (via `messi.damitv.st/papi/ts2/...`, all 502 when tested) + 38 dlhd (covered by `dlhd.mts`). The TimStreams half is `timstreams.mts` now. |
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
| Plex Live TV (`i.mjh.nz/Plex/.channels.json.gz`, `jmp2.uk/plex-<id>.m3u8`) | 2026-10-04: ~2,900 channels, but the stream answers "Channel not available in current location" unless the request carries a spoofed `X-Forwarded-For` of a US/UK/... address (that is what the list's region `headers` are). Not adopted: it would work by defeating the service's geo-fence. |
| LG Channels (`lgchannels.com`) | 2026-10-05: `api.lgchannels.com/lineupapi/v1.0/channellist` (headers `X-Device-Country`, `X-Device-Language`, `X-Device-Type: WEB`; the body is base64 of zlib JSON) lists 221 channels for DE, 299 GB, 187 FR (names, ids, providers such as Pluto), but no stream addresses; `/api/v1.0/schedulelist` answers only for the US. Many ids are Pluto's own (`pluto.mts`). Retry only with a real TV session trace.
| StrikeOut / VIPLeague.vg / 720pStream / embedsports.me | 2026-10-05: one family. Listing pages are plain HTML (`/nfl`, `/nba`, `/live/<sport>/<slug>`), but every stream is an `embed-V2.min.js` iframe on `ninguno.cc/sd0embed/<cat>?...&csrf=...&sec_hash=...` (or `seckyes.cc` session calls) whose player is a window.top-checked, session-guarded obfuscated page with P2P and ad scripts; headless Chromium never reached a playlist. Same shape as the guarded players in the Rejected list; retry only with a manual network trace. |
