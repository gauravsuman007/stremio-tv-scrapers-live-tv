/**
 * CricHD (crichd.at) -- live cricket matches, each with the TV channels
 * carrying it. The site is a thin, server-rendered front over other
 * people's embeds, so most of the work here is following those embeds to a
 * playlist.
 *
 * THE EVENTS
 *   The home page lists every match/series as `<a href="/events/<slug>">`
 *   under a league heading, each with a `data-start` / `data-end` pair (UTC,
 *   ISO). Only the status TEXT is rewritten client-side; the timestamps are
 *   in the HTML, so "live" is decided here: from ten minutes before the
 *   start to the end. Every live event becomes ONE card, named as the event
 *   page's own title ("India vs West Indies", "Asian Games T20"), on TWO
 *   rails with identical content:
 *
 *     - "Live Events"  -- the heading ntvst/zlive/dlhd/futbolx also use, so
 *       the host merges them into one rail and one card per fixture;
 *     - "Live Cricket" -- the same heading ntvst gives its cricket rail, so
 *       it merges with theirs too.
 *
 *   The event page (`/events/<slug>`) is a table: Streamer ("Link 1"),
 *   Channel ("Willow Cricket HD"), Mobile, Quality, Ads, Language, and a
 *   "Watch" link of the form `hitsportshdd.xyz/fr.php?src=<embed url>`. Each
 *   row becomes one source on the event card. The channel's own name,
 *   language and quality are kept on the stream (`labels`, `quality`);
 *   language also goes on the card as an ISO 639-3 code.
 *
 *   The "Quality" column read 1500 on every row seen (10 rows, 2 events,
 *   2026-10-03), next to "Ads: 3" on every row -- constants, not
 *   resolutions. It is treated as a bitrate in kbps and shown only when the
 *   channel's name says nothing better ("HD", "720p", "1080p", "4K").
 *
 *   THE GRAPHIC: the event page draws both sides (`<img alt="India Logo">`
 *   over the name, then the status, then the other side), so a match card
 *   gives `logos = [side 1, side 2]` for the host to draw side by side
 *   (`ScrapedChannel.logos`), `logo` being side 1 for a host that predates it.
 *   A tournament page ("Asian Games T20") has the tournament as side 1 and the
 *   placeholder "Live" as side 2: no pair, the league's picture is `logo`.
 *
 * THE EMBEDS (what the "Watch" link points at, and which are supported)
 *   Verified 2026-10-03, all with plain HTTP, no browser:
 *
 *   dlhd     `daddylive1.cx/my/stream-<N>.php` -> `dembed.top/premiumtv/
 *            player.php?id=<N>`, whose page holds `const SRC = "https://
 *            edge.<host>/premium<N>/index.m3u8"`. The DaddyLive backend of
 *            dlhd.mts: every segment is a PNG with the TS hidden in its
 *            pixels, so these streams carry the `tiktikpx` decoder (copied
 *            from dlhd.mts; needs live-tv 1.6.0; older hosts drop them
 *            rather than offer them).
 *   trendy   `trendy48.online/live-tv?ch=<slug>` (mirror: `trend48.st`) ->
 *            iframe `trendy48.site/embed/<slug>` -> script-built iframe
 *            `exmxbxe.cfd/trefoxy/<slug>` (redirects to a signed path),
 *            whose JW Player setup is hidden in an XOR-and-shift number
 *            array (`(v ^ key) - offset`, the key and offset sit beside the
 *            array in the page; decoded here, no eval). It yields a signed
 *            `...junksonus.party/main/secure/<sig>/<expiry>/<slug>.m3u8`
 *            that plays with no headers, valid ~2.5h. The same PNG-wrapped
 *            segments as dlhd (`tiktokcdn` `.image` URLs), same decoder.
 *   streame  `streame.center/embed/ch<N>.php` -> iframe `hls2.php?stream=
 *            <id>` (needs a Referer, 403 without) -> `const streamUrl =
 *            "https://edgestream<k>.pro/hls/<id>.m3u8?st=<sig>&e=<expiry>"`
 *            (a few hours). The playlist needs `Referer: https://
 *            streame.center/`. Its feed for Willow answered 404 even in a
 *            real browser on 2026-10-03, so the segment format is UNVERIFIED
 *            -- it is offered as plain HLS, without the decoder.
 *   streamed `embed.st/embed/<source>/<id>/<n>` (e.g. `admin/admin-willow-
 *            cricket/1`) -- the Streamed player. `POST embed.st/fetch` with the
 *            three strings, ChaCha20 under the `goat` header, gives a
 *            `lbN.strmd.st/secure/<token>/.../playlist.m3u8` that needs
 *            `Referer: https://embed.st/`. Segments are WebP images with the
 *            TS inside (`tiktikpx` handles them). The full recipe is in
 *            streamed.mts; this file repeats the handshake because a scraper
 *            cannot import another one. Needs live-tv 1.10.0 (the CDN
 *            wants TLS 1.2). Verified 2026-10-03: `admin-willow-cricket`.
 *   ppv      `embedindia.st/embed/<path>` (PPV.ST's twin of the above, see
 *            ppv.mts): the same handshake with one string and the key in
 *            `island`. No crichd row linked one on 2026-10-03; supported
 *            because it costs nothing once the handshake exists.
 *
 *   NOT supported, and why (recorded so nobody retries them blindly):
 *   - `s1.vertex.st/ch?id=N` -> `api/player.php?id=N` -> `lineagest.click/
 *     e/<id>`: the stream config is an encrypted blob decoded by an
 *     obfuscated, devtools-hostile bundle, and the player never requested a
 *     stream in headless Chromium (25s, ads blocked or not).
 *   Rows pointing at `s1.vertex.st`, or at any host not listed above, are skipped.
 *
 * HANDLES AND THE RESOLVER
 *   Every address above is signed, expires within hours, or needs a
 *   multi-page handshake, so nothing is resolved in `build()`. A stream's
 *   `url` is a HANDLE (`https://crichd.invalid/<kind>/<key>`) and the host
 *   calls `resolvers.crichd` whenever it checks or plays it; see
 *   `ScrapedStream.resolver`. The resolver also fetches the playlist it
 *   found and answers `null` unless it is a real `#EXTM3U` -- a signed
 *   address is issued whether or not the channel is on air.
 *
 * NAMING, SO THE CHANNELS MERGE WITH iptv-org's
 *   Besides the event cards, every supported source is ALSO emitted as a
 *   plain channel ("TNT Sports 2", UK), so the host's name+country merge can
 *   add it as a mirror of the channel iptv-org (or any other source) already
 *   has. For that the name must be written the way the OTHER source writes
 *   it: quality words stripped ("Willow Cricket HD" -> "Willow Cricket"),
 *   then looked up in iptv-org's `channels.json` (names AND alt names, sports
 *   channels only) to adopt its spelling and country ("Sony Ten 1" ->
 *   "Sony Sports Ten 1", IN; "Willow Cricket" -> "Willow", US). A country the
 *   embed's own slug states (`tntsports2-uk`) disambiguates a name iptv-org
 *   has in several countries. No match is not an error: the cleaned name
 *   and whatever country is known are used as they are. The lookup file is
 *   ~8MB, fetched at most once a day, and its failure only costs the
 *   spelling.
 *
 *   The site's labels are not always right: on "Asian Games T20" a row named
 *   "Willow Cricket HD" links to `ch=sonysportsnetwork-in`. A trendy row
 *   whose slug disagrees with its label (first four letters) stays on the
 *   event card, as the site lists it, but is NOT emitted as a channel.
 */
import { createDecipheriv } from "node:crypto";
import { request } from "node:https";
import { gunzipSync, inflateSync } from "node:zlib";
// BEGIN event-key -- identical in every scraper that lists live events. scripts/sync-blocks.mjs keeps the copies in step.
/** Flags (regional indicators), tag characters, variation selectors, joiners. */
const EVENT_DECORATION = /[\u{1F1E6}-\u{1F1FF}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{1F3F4}]/gu;
/** Words some lists put on a club's name and others leave off. */
const EVENT_GENERIC = new Set(["fc", "cf", "afc", "sc", "fk", "sk", "cd", "ud", "club", "the", "de", "calcio"]);
/** Whole-name spellings that are one team. Keys are already folded. */
const EVENT_ALIASES = {
    "czech republic": "czechia",
    czech: "czechia",
    "united states": "usa",
    "united states of america": "usa",
    us: "usa",
    "korea republic": "south korea",
    "republic of korea": "south korea",
    "cote d ivoire": "ivory coast",
    turkiye: "turkey",
    holland: "netherlands",
    "bosnia and herzegovina": "bosnia",
    "bosnia herzegovina": "bosnia",
    uae: "united arab emirates",
    macedonia: "north macedonia",
    "republic of ireland": "ireland",
    "man utd": "manchester united",
    "man united": "manchester united",
    "man city": "manchester city",
    spurs: "tottenham",
    "tottenham hotspur": "tottenham",
    "wolverhampton wanderers": "wolves",
    "paris saint germain": "psg",
    "paris sg": "psg",
    "inter milan": "inter",
    internazionale: "inter",
    "bayern munich": "bayern",
    "bayern munchen": "bayern",
    "dr congo": "congo dr",
    "china pr": "china",
    "ir iran": "iran",
    "russian federation": "russia",
    "cabo verde": "cape verde",
    swaziland: "eswatini",
    denamrk: "denmark"
};
/** A team's identity: folded, with the noise words and spellings that differ between sources taken out. */
function teamKey(name) {
    const folded = name
        .replace(EVENT_DECORATION, " ")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\bwomen'?s?\b|[[(]\s*w\s*[\])]|\bfem(?:inino|enino|inine)?\b/g, " women ")
        .replace(/\bunder[\s-]?(\d{2})\b/g, " u$1 ")
        .replace(/\bno\.?\s*\d{1,2}\b(?=\s+[a-z])/g, " ")
        .replace(/\bst\b\.?/g, "saint")
        .replace(/['`’]/g, "")
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
    const alias = EVENT_ALIASES[folded] || folded;
    const tokens = alias.split(" ").filter((token) => token && !EVENT_GENERIC.has(token));
    return (tokens.length ? tokens : alias.split(" ").filter(Boolean)).join(" ");
}
/**
 * "UEFA Nations League : Scotland vs North Macedonia", "UFC 332: Silva vs
 * Wang", "Croatia vs England - UEFA Nations League" -> the sides and the
 * competition, or null when the text is not a fixture.
 */
function readFixture(raw) {
    const versus = /\s+(?:vs\.?|v\.?|versus|@)\s+/i;
    // A lowercase " x " is the Portuguese/Spanish "versus" ("Cyprus x Latvia"); a capital X is part of a name.
    let name = raw.replace(EVENT_DECORATION, "").replace(/\s+/g, " ").replace(/ x (?=\S)/g, " vs ").trim();
    const first = name.search(versus);
    if (first < 0)
        return null;
    let competition = "";
    const head = name.slice(0, first);
    const cut = Math.max(head.lastIndexOf(" : "), head.lastIndexOf(": "), head.lastIndexOf(" | "));
    if (cut > 0) {
        competition = head.slice(0, cut).trim();
        name = name.slice(cut).replace(/^\s*[:|]\s*/, "").trim();
    }
    const tail = /^(.*?)(?:\s+[-–|]\s+|\s+\()([^)]{3,60})\)?$/.exec(name);
    if (tail && versus.test(tail[1] || "")) {
        competition = competition || (tail[2] || "").trim();
        name = (tail[1] || "").trim();
    }
    const sides = name.split(versus).map((side) => side.trim()).filter(Boolean);
    if (sides.length < 2 || sides.length > 8)
        return null;
    if (sides.some((side) => side.length < 2 || side.length > 60 || /^(?:simulcast|tba|tbd|tbc|live|hd|fhd|uhd|sd|4k|tv|\d+)$/i.test(side)))
        return null;
    return { sides, competition };
}
/** A name that is one of these words is a different team when it is the extra one -- never trimmed away. */
const EVENT_MARKER = /^(?:u\d\d|women|ii|iii|b|reserves?|youth|jr|junior|academy|castilla|amateur)$/;
/** Too common on their own to stand for a team ("State", "New"). */
const EVENT_COMMON = new Set(["city", "united", "town", "county", "athletic", "sporting", "real", "club", "national", "state", "college", "university", "new", "north", "south", "east", "west", "saint", "los", "san", "las", "fort", "sint"]);
/**
 * The other names one team goes by: its identity with trailing words dropped
 * ("Ohio State Buckeyes" is also "Ohio State", "UNLV Rebels" is also "UNLV"),
 * longest first, starting with the full identity. A team carrying a women's,
 * youth or reserve word has none -- dropping it would turn one team into another.
 */
function teamNames(name) {
    const full = teamKey(name);
    const tokens = full.split(" ").filter(Boolean);
    if (tokens.some((token) => EVENT_MARKER.test(token)))
        return [full];
    const names = [full];
    let head = tokens;
    /* Drop trailing words one at a time, but never a word like "United" or "State": that is part of the name. */
    while (head.length > 1 && !EVENT_COMMON.has(head[head.length - 1] || "")) {
        head = head.slice(0, -1);
        if (head.length === 1 && ((head[0] || "").length < 4 || EVENT_COMMON.has(head[0] || "")))
            break;
        names.push(head.join(" "));
    }
    return names;
}
/** Every combination of the sides' names, as sorted keys: the exact one first, at most 16. */
function eventKeys(sides) {
    let keys = [[]];
    for (const side of sides) {
        const names = teamNames(side);
        keys = keys.flatMap((held) => names.map((name) => [...held, name]));
        if (keys.length > 64)
            keys = keys.slice(0, 64);
    }
    return [...new Set(keys.map((parts) => `v:${[...parts].sort().join("|")}`))].slice(0, 16);
}
/**
 * A source that names an American side by its nickname alone ("Chiefs @ Raiders")
 * and one that writes the whole name ("Las Vegas Raiders") are one fixture.
 * Nicknames repeat across leagues (Giants, Panthers, Cardinals, Rangers, Kings,
 * Jets), so a nickname is only expanded when the source states the sport.
 */
const US_NICKNAMES = {};
for (const [sport, list] of Object.entries({
    "american football": "Cardinals=Arizona Cardinals;Falcons=Atlanta Falcons;Ravens=Baltimore Ravens;Bills=Buffalo Bills;Panthers=Carolina Panthers;Bears=Chicago Bears;Bengals=Cincinnati Bengals;Browns=Cleveland Browns;Cowboys=Dallas Cowboys;Broncos=Denver Broncos;Lions=Detroit Lions;Packers=Green Bay Packers;Texans=Houston Texans;Colts=Indianapolis Colts;Jaguars=Jacksonville Jaguars;Chiefs=Kansas City Chiefs;Raiders=Las Vegas Raiders;Chargers=Los Angeles Chargers;Rams=Los Angeles Rams;Dolphins=Miami Dolphins;Vikings=Minnesota Vikings;Patriots=New England Patriots;Saints=New Orleans Saints;Giants=New York Giants;Jets=New York Jets;Eagles=Philadelphia Eagles;Steelers=Pittsburgh Steelers;49ers=San Francisco 49ers;Seahawks=Seattle Seahawks;Buccaneers=Tampa Bay Buccaneers;Titans=Tennessee Titans;Commanders=Washington Commanders",
    "baseball": "Diamondbacks=Arizona Diamondbacks;Braves=Atlanta Braves;Orioles=Baltimore Orioles;Red Sox=Boston Red Sox;Cubs=Chicago Cubs;White Sox=Chicago White Sox;Reds=Cincinnati Reds;Guardians=Cleveland Guardians;Rockies=Colorado Rockies;Tigers=Detroit Tigers;Astros=Houston Astros;Royals=Kansas City Royals;Angels=Los Angeles Angels;Dodgers=Los Angeles Dodgers;Marlins=Miami Marlins;Brewers=Milwaukee Brewers;Twins=Minnesota Twins;Mets=New York Mets;Yankees=New York Yankees;Phillies=Philadelphia Phillies;Pirates=Pittsburgh Pirates;Padres=San Diego Padres;Giants=San Francisco Giants;Mariners=Seattle Mariners;Cardinals=St. Louis Cardinals;Rays=Tampa Bay Rays;Rangers=Texas Rangers;Blue Jays=Toronto Blue Jays;Nationals=Washington Nationals",
    "hockey": "Ducks=Anaheim Ducks;Bruins=Boston Bruins;Sabres=Buffalo Sabres;Flames=Calgary Flames;Hurricanes=Carolina Hurricanes;Blackhawks=Chicago Blackhawks;Avalanche=Colorado Avalanche;Blue Jackets=Columbus Blue Jackets;Stars=Dallas Stars;Red Wings=Detroit Red Wings;Oilers=Edmonton Oilers;Panthers=Florida Panthers;Kings=Los Angeles Kings;Wild=Minnesota Wild;Canadiens=Montreal Canadiens;Predators=Nashville Predators;Devils=New Jersey Devils;Islanders=New York Islanders;Rangers=New York Rangers;Senators=Ottawa Senators;Flyers=Philadelphia Flyers;Penguins=Pittsburgh Penguins;Sharks=San Jose Sharks;Kraken=Seattle Kraken;Blues=St. Louis Blues;Lightning=Tampa Bay Lightning;Maple Leafs=Toronto Maple Leafs;Canucks=Vancouver Canucks;Golden Knights=Vegas Golden Knights;Capitals=Washington Capitals;Jets=Winnipeg Jets;Mammoth=Utah Mammoth",
    "basketball": "Hawks=Atlanta Hawks;Celtics=Boston Celtics;Nets=Brooklyn Nets;Hornets=Charlotte Hornets;Bulls=Chicago Bulls;Cavaliers=Cleveland Cavaliers;Mavericks=Dallas Mavericks;Nuggets=Denver Nuggets;Pistons=Detroit Pistons;Warriors=Golden State Warriors;Rockets=Houston Rockets;Pacers=Indiana Pacers;Clippers=Los Angeles Clippers;Lakers=Los Angeles Lakers;Grizzlies=Memphis Grizzlies;Heat=Miami Heat;Bucks=Milwaukee Bucks;Timberwolves=Minnesota Timberwolves;Pelicans=New Orleans Pelicans;Knicks=New York Knicks;Thunder=Oklahoma City Thunder;Magic=Orlando Magic;76ers=Philadelphia 76ers;Suns=Phoenix Suns;Trail Blazers=Portland Trail Blazers;Kings=Sacramento Kings;Spurs=San Antonio Spurs;Raptors=Toronto Raptors;Jazz=Utah Jazz;Wizards=Washington Wizards"
})) {
    US_NICKNAMES[sport] = Object.fromEntries(list.split(";").map((pair) => pair.split("=")).map(([nick, full]) => [nick.toLowerCase(), full]));
}
/** The whole name for a nickname the source gave alone, when its sport says which league; else the name unchanged. */
function fullTeamName(name, sport) {
    const table = US_NICKNAMES[(sport || "").toLowerCase()];
    return table?.[name.trim().toLowerCase()] || name;
}
/**
 * The card's `event` and display name. `key` is what the host merges on: the
 * sides' identities, sorted (so order does not matter), or for an event with
 * no opponents its folded title without the year. Two sources that compute
 * the same key for an event are the same event -- the host compares nothing else
 * but the start time. `keys` are further keys the same event goes by (a
 * name with its trailing words dropped), for a source that spells a team
 * shorter: two cards are one event when ANY of their keys is shared.
 */
function eventFor(title, extra = {}) {
    const found = extra.sides && extra.sides.length >= 2 ? { sides: extra.sides, competition: "" } : readFixture(title);
    const fixture = found && extra.sport ? { ...found, sides: found.sides.map((side) => fullTeamName(side, extra.sport)) } : found;
    const competition = fixture?.competition || extra.competition || "";
    const titleKey = title
        .replace(EVENT_DECORATION, " ")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\b20\d\d(?:\/\d\d)?\b/g, " ")
        .replace(/\b(?:live|stream|hd|fhd|full\s+event)\b/g, " ")
        .replace(/[^a-z0-9]+/g, "");
    const keys = fixture ? eventKeys(fixture.sides) : [];
    const key = fixture ? `v:${fixture.sides.map(teamKey).sort().join("|")}` : titleKey.length >= 6 ? `t:${titleKey}` : "";
    return {
        name: fixture ? fixture.sides.join(" vs ") : title,
        event: {
            ...(fixture ? { sides: fixture.sides } : { title }),
            ...(key ? { key } : {}),
            ...(keys.length > 1 ? { keys: keys.filter((other) => other !== key) } : {}),
            ...(competition ? { competition } : {}),
            ...(extra.competitionLogo && /^https?:\/\//i.test(extra.competitionLogo) ? { competitionLogo: extra.competitionLogo } : {}),
            ...(extra.sport ? { sport: extra.sport } : {}),
            ...(extra.start && extra.start > 0 ? { start: extra.start } : {})
        }
    };
}
const SCRAPER_ID = "crichd";
const SITE = "https://crichd.at";
const SCRAPER_NAME = "CricHD";
const DECODER = "tiktikpx";
const RESOLVER = "crichd";
const HANDLE_HOST = "crichd.invalid";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
function idFor(rawId) {
    return `live:${SCRAPER_ID}:${rawId}`;
}
async function withTimeout(work, ms = 20_000) {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: fetch() resolves on
    // headers and the body read that follows is still tied to this signal.
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();
    try {
        return await work(controller.signal);
    }
    catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}
async function getText(url, referrer = "", ms = 20_000) {
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(referrer ? { Referer: referrer } : {}) } }), ms);
    if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
    return { text: await response.text(), url: response.url };
}
async function mapWithConcurrency(items, limit, work) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const at = next++;
            results[at] = await work(items[at]);
        }
    });
    await Promise.all(workers);
    return results;
}
function decodeEntities(text) {
    return text
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}
/** From ten minutes before the start (the links are up by then) to the end. */
const LEAD_MS = 10 * 60 * 1000;
async function fetchListing(now) {
    const { text } = await getText(`${SITE}/`);
    // A 200 that is not this page at all (a parked domain, a changed
    // layout) must throw, not read as "nothing is on".
    if (!text.includes('id="content"') || !text.includes("countdown-status"))
        throw new Error("crichd: home page not recognised");
    const tokens = text.matchAll(/<img src="([^"]+)" alt="[^"]*"\s+width="28"[^>]*>\s*<div class="text-white font-semibold text-sm">([^<]+)<\/div>|href="\/events\/([^"?#]+)"|data-start="([^"]+)"\s+data-end="([^"]+)"/g);
    const events = [];
    let league = "";
    let leagueLogo = "";
    let slug = "";
    for (const token of tokens) {
        if (token[2] !== undefined) {
            leagueLogo = token[1] || "";
            league = decodeEntities(token[2]);
        }
        else if (token[3] !== undefined) {
            slug = token[3];
        }
        else if (token[4] !== undefined && token[5] !== undefined && slug) {
            const start = Date.parse(token[4]);
            const end = Date.parse(token[5]);
            if (!Number.isNaN(start) && !Number.isNaN(end) && now >= start - LEAD_MS && now <= end && !events.some((e) => e.slug === slug)) {
                events.push({ slug, league, leagueLogo, start, end });
            }
            slug = "";
        }
    }
    return events;
}
async function fetchEventPage(slug) {
    const { text } = await getText(`${SITE}/events/${encodeURIComponent(slug)}`);
    const title = decodeEntities(/<title>([^<]*)<\/title>/.exec(text)?.[1] || "")
        .replace(/\s*[-|]\s*CricHD\.at\s*$/i, "")
        .replace(/\s+Live\s+Stream(?:ing)?(?:\s+Online)?\s*$/i, "")
        .trim();
    const rows = [];
    /*
        THE TWO SIDES' PICTURES: the page draws team 1, the status, team 2,
        each as an `<img ... alt="<name> Logo">` over the name. A tournament
        page ("Asian Games T20") has the tournament as team 1 and the
        placeholder "Live" as team 2 -- not two flags, so no pair.
    */
    const sides = [...text.matchAll(/<img src="([^"]+)" alt="[^"]*" class="rounded shadow-lg[^"]*"\s*\/>\s*<div class="text-white text-sm font-semibold[^"]*">([^<]*)<\/div>/g)].map((m) => ({
        logo: decodeEntities(m[1]),
        name: decodeEntities(m[2])
    }));
    const flags = sides.length === 2 && sides.every((side) => side.logo && !/^live$/i.test(side.name)) ? sides.map((side) => side.logo) : [];
    for (const tr of text.matchAll(/<tr class="hover[\s\S]*?<\/tr>/g)) {
        const cells = [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decodeEntities(m[1].replace(/<[^>]*>/g, "")));
        const href = /href="([^"]+)"/.exec(tr[0])?.[1];
        if (!href || cells.length < 6)
            continue;
        // `fr.php?src=<embed>`: the embed's own `?query` is not encoded, so
        // everything after `src=` is the embed.
        const wrapped = decodeEntities(href);
        const at = wrapped.indexOf("src=");
        const embed = at >= 0 ? wrapped.slice(at + 4) : wrapped;
        if (!/^https?:\/\//.test(embed))
            continue;
        rows.push({ link: cells[0], channel: cells[1], quality: cells[3], language: cells[5], embed });
    }
    return { title, rows, flags, names: flags.length === 2 ? sides.map((side) => side.name.trim()) : [] };
}
function classify(embed) {
    let url;
    try {
        url = new URL(embed);
    }
    catch {
        return null;
    }
    const dlhd = /\/stream-(\d+)\.php$/.exec(url.pathname) || (/\/premiumtv\/\w+\.php$/.test(url.pathname) ? /^(\d+)$/.exec(url.searchParams.get("id") || "") : null);
    if (dlhd?.[1])
        return { kind: "dlhd", key: dlhd[1] };
    const slug = url.pathname === "/live-tv" ? url.searchParams.get("ch") : null;
    if (slug && /^[a-z0-9][a-z0-9-]*$/i.test(slug))
        return { kind: "trendy", key: slug };
    const streame = url.hostname.endsWith("streame.center") ? /^\/embed\/(ch\d+)\.php$/.exec(url.pathname) : null;
    if (streame?.[1])
        return { kind: "streame", key: streame[1] };
    // The Streamed player: `embed.st/embed/<source>/<id>/<n>` (and PPV.ST's twin on embedindia.st).
    const streamed = url.hostname === "embed.st" ? /^\/embed\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/(\d+)\/?$/.exec(url.pathname) : null;
    if (streamed?.[1] && streamed[2] && streamed[3])
        return { kind: "streamed", key: `${streamed[1]}/${streamed[2]}/${streamed[3]}` };
    const ppv = url.hostname === "embedindia.st" ? /^\/embed\/([A-Za-z0-9][A-Za-z0-9/_.-]*)$/.exec(url.pathname) : null;
    if (ppv?.[1])
        return { kind: "ppv", key: ppv[1].replace(/\/$/, "") };
    return null;
}
function handleFor(source) {
    return `https://${HANDLE_HOST}/${source.kind}/${encodeURIComponent(source.key)}`;
}
function sourceOfHandle(handle) {
    try {
        const url = new URL(handle);
        const match = url.hostname === HANDLE_HOST ? /^\/(dlhd|trendy|streame|streamed|ppv)\/([^/]+)$/.exec(url.pathname) : null;
        return match ? { kind: match[1], key: decodeURIComponent(match[2]) } : null;
    }
    catch {
        return null;
    }
}
/** The pages to start from, best first; a mirror gone dark costs one request. */
function startPages(source) {
    const key = encodeURIComponent(source.key);
    if (source.kind === "dlhd") {
        return [
            { url: `https://dembed.top/premiumtv/player.php?id=${key}`, referrer: "https://daddylive1.cx/" },
            { url: `https://daddyliveplayer.st/premiumtv/daddy.php?id=${key}`, referrer: "https://dlhd.st/" }
        ];
    }
    if (source.kind === "trendy") {
        return [
            { url: `https://trendy48.online/live-tv?ch=${key}`, referrer: `${SITE}/` },
            { url: `https://trend48.st/live-tv?ch=${key}`, referrer: `${SITE}/` }
        ];
    }
    return [{ url: `https://streame.center/embed/${key}.php`, referrer: "https://hitsportshdd.xyz/" }];
}
/** What the playlist and its segments need on every request. Only streame
 *  checks; dlhd's and trendy's CDNs answer with no Referer at all. */
function referrerFor(kind) {
    return kind === "streame" ? "https://streame.center/" : "";
}
// --- following an embed to its playlist ------------------------------------------
const AD_FRAME = /histats|google|amung|jsdelivr|cloudflare|jquery|doubleclick|\/ad\.html|aclib|plausible/i;
const NOT_A_PAGE = /\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|json|mp4)(?:[?#]|$)/i;
/** `&` and `\/` as a JS string literal in HTML spells them. */
function unescapeJs(text) {
    return text.replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&");
}
/**
 * trendy's player is a number array decoded and eval'd by the page itself:
 * `var a=[..],b=<xor>,c=<offset>,...; ... (a[i] ^ b) - c + 256) % 256`.
 * The same arithmetic here, to text -- never executed.
 */
function decodePacked(html) {
    let out = "";
    for (const match of html.matchAll(/var\s+\w+=\[([\d,\s]{40,})\],\s*\w+=(\d+),\s*\w+=(\d+),/g)) {
        const xor = Number(match[2]);
        const shift = Number(match[3]);
        const chars = match[1].split(",").map((n) => String.fromCharCode((((Number(n) ^ xor) - shift) % 256 + 256) % 256));
        out += `\n${chars.join("")}`;
    }
    return out;
}
function findPlaylist(html) {
    const text = unescapeJs(html + decodePacked(html));
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g)) {
        if (!/example\.|\.invalid\//.test(match[0]))
            return match[0];
    }
    return null;
}
function findFrame(html, base) {
    const text = unescapeJs(html + decodePacked(html));
    const candidates = [
        ...text.matchAll(/<iframe[^>]*?\ssrc=["']([^"']+)["']/gi),
        ...text.matchAll(/\.src\s*=\s*["']([^"']+)["']/g)
    ].map((m) => m[1]);
    for (const raw of candidates) {
        try {
            const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, base);
            if (url.protocol === "https:" && !AD_FRAME.test(url.href) && !NOT_A_PAGE.test(url.pathname))
                return url.href;
        }
        catch {
            // not a URL
        }
    }
    return null;
}
async function scan(url, referrer, deadline, depth = 0) {
    const left = deadline - Date.now();
    if (left < 500)
        return null;
    const page = await getText(url, referrer, Math.min(6_000, left));
    const playlist = findPlaylist(page.text);
    if (playlist)
        return playlist;
    const frame = depth < 4 ? findFrame(page.text, page.url) : null;
    return frame ? scan(frame, page.url, deadline, depth + 1) : null;
}
/** dlhd's edge host is the same for every channel and changes rarely, so
 *  the 650KB player page is read once per ten minutes, not per channel. */
let edgeCache = null;
const EDGE_TTL_MS = 10 * 60 * 1000;
async function playlistFor(source, deadline) {
    if (source.kind === "dlhd" && edgeCache && Date.now() - edgeCache.at < EDGE_TTL_MS) {
        return `${edgeCache.base}/premium${source.key}/index.m3u8`;
    }
    for (const start of startPages(source)) {
        const found = await scan(start.url, start.referrer, deadline).catch(() => null);
        if (!found)
            continue;
        const edge = source.kind === "dlhd" ? /^(https:\/\/[^/]+)\/premium\d+\/index\.m3u8/.exec(found)?.[1] : undefined;
        if (edge)
            edgeCache = { base: edge, at: Date.now() };
        return found;
    }
    return null;
}
/** What the host asks for when a channel is checked or played. About twelve
 *  seconds are available, so the whole chain shares ten. */
async function resolveHandle(handle) {
    const source = sourceOfHandle(handle);
    if (!source)
        return null;
    if (source.kind === "streamed" || source.kind === "ppv")
        return resolveEmbed(source);
    const deadline = Date.now() + 10_000;
    const url = await playlistFor(source, deadline);
    if (!url)
        return null;
    // A signed address is issued whether or not the channel is on air.
    const referrer = referrerFor(source.kind);
    const alive = await getText(url, referrer, Math.max(1_000, deadline - Date.now()))
        .then((playlist) => playlist.text.trimStart().startsWith("#EXTM3U"))
        .catch(() => false);
    if (!alive) {
        if (source.kind === "dlhd")
            edgeCache = null;
        return null;
    }
    return { url, referrer: referrer || undefined, userAgent: BROWSER_UA };
}
// --- the Streamed player's own handshake (embed.st, embedindia.st) ------------
//
// Copied from streamed.mts / ppv.mts, which have the full account: a POST to
// the embed's `/fetch` answers text in a fixed alphabet that ChaCha20 turns
// into a signed `.../secure/<token>/.../index.m3u8` (key = a 32-letter
// response header, `goat` on embed.st, `island` on embedindia.st). The
// segments are WebP images with the TS inside; `unwrapSegment` below already
// copes with that (its `webpExif` branch and its sync-byte scan), so these
// streams use the `tiktikpx` decoder too.
/** The 64 symbols, in value order, of the text the embed answers with. Pad is `T`. */
const ALPHABET = "XYZ[\\]^_`abcdefghijklmnopqxyz{|}~!\"#$%&'()*+,-./0123GHIJKLMNOPBF";
const SYMBOL = new Map([...ALPHABET].map((char, index) => [char, index]));
function unalphabet(text) {
    const out = [];
    let acc = 0;
    let bits = 0;
    for (const char of text) {
        if (char === "T")
            break;
        const value = SYMBOL.get(char);
        if (value === undefined)
            throw new Error(`symbol ${JSON.stringify(char)} outside the alphabet`);
        acc = (acc << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
            acc &= (1 << bits) - 1;
        }
    }
    return Buffer.from(out);
}
function varint(value) {
    const out = [];
    let rest = value;
    while (rest >= 0x80) {
        out.push((rest & 0x7f) | 0x80);
        rest >>>= 7;
    }
    out.push(rest);
    return out;
}
/** protobuf: field N = the Nth string. */
function requestBody(...values) {
    const parts = [];
    values.forEach((value, index) => {
        const bytes = Buffer.from(value, "utf8");
        parts.push(((index + 1) << 3) | 2, ...varint(bytes.length), ...bytes);
    });
    return Buffer.from(parts);
}
/** `{1: bytes}` -> the bytes, or null. */
function field1(body) {
    if (body[0] !== 0x0a)
        return null;
    let at = 1;
    let length = 0;
    let shift = 0;
    for (;;) {
        const byte = body[at++];
        if (byte === undefined)
            return null;
        length |= (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80))
            break;
    }
    return body.subarray(at, at + length);
}
/** The `/fetch` answer -> the playlist URL, or null. */
export function decodeAnswer(body, key) {
    const text = field1(body);
    if (!text || key.length !== 32)
        return null;
    const raw = unalphabet(text.toString("latin1"));
    if (raw.length < 12 + 16 + 8)
        return null;
    const nonce = raw.subarray(0, 12);
    const sealed = raw.subarray(12, raw.length - 16); // the last 16 bytes are a Poly1305 tag, not checked
    const iv = Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]); // RFC 8439: block counter starts at 1
    const cipher = createDecipheriv("chacha20", Buffer.from(key, "latin1"), iv);
    const plain = Buffer.concat([cipher.update(sealed), cipher.final()]).toString("latin1");
    return /^https:\/\/[a-z0-9.-]+\/secure\/[A-Za-z0-9/_.=~-]+\.m3u8$/.test(plain) ? plain : null;
}
/**
 * The key's header is not always called `goat`: embedindia.st (PPV.ST) sends
 * it as `island`, and the name is the embed's own. What never changes is its
 * shape, 32 letters/digits, so every header of that shape is tried.
 */
export function decodeResponse(body, headers) {
    for (const [, value] of headers) {
        if (!/^[A-Za-z0-9]{32}$/.test(value))
            continue;
        const playlist = decodeAnswer(body, value);
        if (playlist)
            return playlist;
    }
    return null;
}
/**
 * `/fetch` answers 429 beyond roughly 40 calls in a burst or ~10 a second
 * sustained (measured: 60 sequential calls 0.7 s apart, no 429), and a sweep
 * of every stream's health asks for all of them at once. A token bucket
 * (15 burst, 4 a second) keeps a viewer's press of Play from queueing behind
 * more than a moment of that, and a 429 is waited out once.
 */
const BUCKET = 15;
const REFILL_PER_SECOND = 4;
let tokens = BUCKET;
let refilledAt = Date.now();
let turn = Promise.resolve();
function takeToken() {
    const mine = turn.then(async () => {
        for (;;) {
            const now = Date.now();
            tokens = Math.min(BUCKET, tokens + ((now - refilledAt) / 1000) * REFILL_PER_SECOND);
            refilledAt = now;
            if (tokens >= 1) {
                tokens -= 1;
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.ceil(((1 - tokens) / REFILL_PER_SECOND) * 1000)));
        }
    });
    turn = mine;
    return mine;
}
const EMBED_HOSTS = { streamed: "https://embed.st", ppv: "https://embedindia.st" };
async function postEmbed(kind, path, fields) {
    const host = EMBED_HOSTS[kind];
    const once = async () => {
        await takeToken();
        return withTimeout((signal) => fetch(`${host}/fetch`, {
            method: "POST",
            signal,
            headers: {
                "content-type": "application/octet-stream",
                "user-agent": BROWSER_UA,
                origin: host,
                referer: `${host}/embed/${path.split("/").map(encodeURIComponent).join("/")}`
            },
            body: new Uint8Array(requestBody(...fields))
        }), 15_000);
    };
    const first = await once();
    if (first.status !== 429)
        return first;
    await first.arrayBuffer().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return once();
}
/** The playlist's CDN 403s Node's default TLS 1.3 handshake, so `onAir` looks
 *  at it over TLS 1.2 and a feed whose newest segment is gone gives null. */
async function resolveEmbed(source) {
    const kind = source.kind;
    const fields = kind === "streamed" ? source.key.split("/") : [source.key];
    if (fields.length !== (kind === "streamed" ? 3 : 1) || fields.some((field) => !field))
        return null;
    const response = await postEmbed(kind, source.key, fields);
    if (!response.ok)
        return null;
    const playlist = decodeResponse(Buffer.from(await response.arrayBuffer()), response.headers);
    if (!playlist)
        return null;
    if (!(await onAir(playlist, `${EMBED_HOSTS[kind]}/`)))
        return null;
    return { url: playlist, referrer: `${EMBED_HOSTS[kind]}/`, userAgent: "" };
}
function probe(url, referrer, wantBody, hops = 0) {
    return new Promise((resolve, reject) => {
        const attempt = request(url, { method: "GET", headers: { "user-agent": BROWSER_UA, referer: referrer }, maxVersion: "TLSv1.2", timeout: 6_000 }, (incoming) => {
            const status = incoming.statusCode || 0;
            const location = incoming.headers.location;
            if (status >= 300 && status < 400 && location && hops < 3) {
                incoming.resume();
                probe(new URL(location, url).href, referrer, wantBody, hops + 1).then(resolve, reject);
                return;
            }
            if (!wantBody) {
                incoming.destroy();
                resolve({ status, text: "", host: new URL(url).host });
                return;
            }
            const chunks = [];
            let size = 0;
            incoming.on("data", (chunk) => {
                size += chunk.length;
                if (size <= 512 * 1024)
                    chunks.push(chunk);
            });
            incoming.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8"), host: new URL(url).host }));
            incoming.on("error", reject);
        });
        attempt.on("timeout", () => attempt.destroy(new Error("probe timed out")));
        attempt.on("error", reject);
        attempt.end();
    });
}
function uris(playlist) {
    return playlist
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
}
/** False only when the playlist or its newest segment is positively gone. */
export async function onAir(playlist, referrer) {
    try {
        let base = playlist;
        let page = await probe(base, referrer, true);
        if (page.status === 404 || page.status === 410)
            return false;
        if (page.status !== 200)
            return true;
        if (page.text.includes("#EXT-X-STREAM-INF")) {
            const first = uris(page.text)[0];
            if (!first)
                return true;
            base = new URL(first, base).href;
            page = await probe(base, referrer, true);
            if (page.status === 404 || page.status === 410)
                return false;
            if (page.status !== 200)
                return true;
        }
        const newest = uris(page.text).pop();
        if (!newest)
            return true;
        const segment = await probe(new URL(newest, base).href, referrer, false);
        if (segment.status === 404 || segment.status === 410)
            return false;
        // Refused by a DIFFERENT host than the playlist's: the broadcaster's CDN
        // (Akamai's "Access Denied" for NFL feeds, by the caller's address)
        // is turning this machine away -- the lb node's own 403s are rate limits.
        return !(segment.status === 403 && segment.host !== new URL(base).host);
    }
    catch {
        return true;
    }
}
// --- names, countries, languages -------------------------------------------------
function fold(text) {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}
/** "Willow Cricket HD" -> "Willow Cricket". */
function cleanChannelName(raw) {
    return raw
        .replace(/[([][^)\]]*[)\]]/g, " ")
        .replace(/\b(?:4k|uhd|fhd|hd|sd|hq|(?:360|480|576|720|1080|1440|2160)p?)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/** The resolution the channel's name states, or "". */
function resolutionOf(raw) {
    const explicit = /\b(4k|uhd|fhd|(?:360|480|576|720|1080|1440|2160)p?)\b/i.exec(raw)?.[1]?.toLowerCase();
    if (explicit)
        return /^\d+$/.test(explicit) ? `${explicit}p` : explicit === "fhd" ? "1080p" : explicit.toUpperCase().replace("UHD", "4K");
    if (/\bhd\b/i.test(raw))
        return "HD";
    if (/\bsd\b/i.test(raw))
        return "SD";
    return "";
}
function qualityOf(row) {
    const named = resolutionOf(row.channel);
    if (named)
        return named;
    // The column: constant 1500 on every row seen, so a bitrate, not a size.
    const number = Number(row.quality);
    return Number.isFinite(number) && number > 0 ? `${number} kbps` : "";
}
/** English name -> ISO 639-3, for the languages the site lists. */
const LANGUAGES = {
    english: "eng", hindi: "hin", urdu: "urd", bengali: "ben", bangla: "ben", tamil: "tam", telugu: "tel", kannada: "kan",
    malayalam: "mal", marathi: "mar", gujarati: "guj", punjabi: "pan", nepali: "nep", sinhala: "sin", sinhalese: "sin",
    arabic: "ara", persian: "fas", farsi: "fas", pashto: "pus", dari: "prs", spanish: "spa", portuguese: "por", french: "fra",
    german: "deu", italian: "ita", russian: "rus", turkish: "tur", afrikaans: "afr", swahili: "swa", dutch: "nld", pidgin: "pcm"
};
function languageCode(name) {
    return LANGUAGES[name.trim().toLowerCase()] || "";
}
/** A country as an embed's slug states it (`willow-usa`, `tntsports2-uk`), in iptv-org's codes. */
const SLUG_COUNTRIES = {
    usa: "US", us: "US", uk: "UK", gb: "UK", in: "IN", ind: "IN", pk: "PK", pak: "PK", au: "AU", aus: "AU", ca: "CA",
    nz: "NZ", za: "ZA", bd: "BD", lk: "LK", ae: "AE", sa: "SA", ie: "IE", np: "NP", af: "AF", ng: "NG", ke: "KE"
};
function slugParts(slug) {
    const match = /^(.*?)-([a-z]{2,3})$/i.exec(slug);
    const country = match ? SLUG_COUNTRIES[match[2].toLowerCase()] || "" : "";
    return { base: country && match ? match[1] : slug, country };
}
/** Does an embed's slug plausibly name the channel its row claims? */
function slugAgrees(label, slugBase) {
    const a = fold(cleanChannelName(label)).slice(0, 4);
    const b = fold(slugBase).slice(0, 4);
    return a.length > 0 && a === b;
}
function flagOf(code) {
    const iso = code === "UK" ? "GB" : code;
    if (!/^[A-Z]{2}$/.test(iso))
        return "";
    return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
function countryNameOf(code) {
    try {
        return new Intl.DisplayNames(["en"], { type: "region" }).of(code === "UK" ? "GB" : code) || code;
    }
    catch {
        return code;
    }
}
/** A name this site spells differently from the rest of the world, where
 *  iptv-org's own alt names do not already say so. */
const ALIASES = {
    willowcricket: "Willow"
};
let knownCache = null;
let knownInFlight = null;
const KNOWN_TTL_MS = 24 * 60 * 60 * 1000;
/** iptv-org's sports channels by every name they go by. Never throws: the
 *  worst a failure costs is a spelling. */
function knownChannels() {
    if (knownCache && Date.now() - knownCache.at < KNOWN_TTL_MS)
        return Promise.resolve(knownCache.byName);
    knownInFlight ||= (async () => {
        try {
            const response = await withTimeout((signal) => fetch("https://iptv-org.github.io/api/channels.json", { signal }), 60_000);
            if (!response.ok)
                throw new Error(`channels.json -> ${response.status}`);
            const raw = (await response.json());
            const byName = new Map();
            const add = (key, entry) => {
                if (!key)
                    return;
                const list = byName.get(key) || [];
                if (!list.some((e) => e.name === entry.name && e.country === entry.country))
                    list.push(entry);
                byName.set(key, list);
            };
            for (const channel of raw) {
                if (!channel.name || !channel.country || channel.closed || !channel.categories?.includes("sports"))
                    continue;
                add(fold(channel.name), { name: channel.name, country: channel.country, primary: true });
                for (const alt of channel.alt_names || [])
                    add(fold(alt), { name: channel.name, country: channel.country, primary: false });
            }
            knownCache = { at: Date.now(), byName };
            /* Let go ten minutes after a run rather than holding it for the
               day: the events job runs hourly, and the map is megabytes of
               heap between runs for a refetch of one file. */
            setTimeout(() => {
                knownCache = null;
            }, 10 * 60 * 1000).unref?.();
        }
        catch (cause) {
            console.error("crichd: iptv-org names unavailable, using the site's own", cause);
            knownCache ||= { at: Date.now() - KNOWN_TTL_MS + 10 * 60 * 1000, byName: new Map() };
        }
        finally {
            knownInFlight = null;
        }
        return knownCache.byName;
    })();
    return knownInFlight;
}
/** The name and country the rest of the index would know this channel by. */
function canonical(cleaned, hint, known) {
    const alias = ALIASES[fold(cleaned)];
    const candidates = known.get(fold(alias || cleaned)) || [];
    const sameCountry = hint ? candidates.filter((c) => c.country === hint) : [];
    const pool = sameCountry.length ? sameCountry : candidates;
    const countries = new Set(pool.map((c) => c.country));
    // Several countries and nothing to choose by: guessing would put the
    // stream on another country's channel.
    if (pool.length && countries.size === 1) {
        const best = pool.find((c) => c.primary) || pool[0];
        return { name: best.name, country: best.country };
    }
    return { name: alias || cleaned, country: hint };
}
// --- the decoder (copied from dlhd.mts: the same disguise) --------------------
const TPIX = [84, 73, 75, 84, 73, 75, 80, 88]; // "TIKTIKPX"
const TRAW = [84, 73, 75, 84, 73, 75, 82, 65, 87]; // "TIKTIKRAW"
const TSGZ = [84, 73, 75, 84, 73, 75, 84, 83, 71, 90]; // "TIKTIKTSGZ"
function isTs(bytes, at = 0) {
    return bytes[at] === 0x47 && (at + 188 >= bytes.length || bytes[at + 188] === 0x47);
}
function find(bytes, tag) {
    outer: for (let i = 0; i + tag.length < bytes.length; i++) {
        for (let j = 0; j < tag.length; j++)
            if (bytes[i + j] !== tag[j])
                continue outer;
        return i;
    }
    return -1;
}
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc)
        return a;
    return pb <= pc ? b : c;
}
/** PNG -> its pixels as packed RGB, or null for any PNG this cannot be
 *  (not 8-bit, interlaced, not RGB/RGBA). */
function pngRgb(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let interlace = 0;
    const idat = [];
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12)
            return null;
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        const data = bytes.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") {
            width = view.getUint32(off + 8);
            height = view.getUint32(off + 12);
            depth = data[8];
            colour = data[9];
            interlace = data[12];
        }
        else if (type === "IDAT") {
            idat.push(data);
        }
        else if (type === "IEND") {
            break;
        }
        off += 12 + len;
    }
    if (!width || !height || depth !== 8 || interlace || (colour !== 2 && colour !== 6))
        return null;
    const raw = inflateSync(Buffer.concat(idat));
    const bpp = colour === 6 ? 4 : 3;
    const stride = width * bpp;
    const rgb = new Uint8Array(width * height * 3);
    let src = 0;
    let dst = 0;
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        if (src + 1 + stride > raw.length)
            return null;
        const filter = raw[src++];
        const row = raw.subarray(src, src + stride);
        src += stride;
        const out = new Uint8Array(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            let v = row[i];
            if (filter === 1)
                v += a;
            else if (filter === 2)
                v += b;
            else if (filter === 3)
                v += (a + b) >> 1;
            else if (filter === 4)
                v += paeth(a, b, c);
            else if (filter !== 0)
                return null;
            out[i] = v & 255;
        }
        if (colour === 2) {
            rgb.set(out, dst);
            dst += stride;
        }
        else {
            for (let i = 0; i < stride; i += 4) {
                rgb[dst++] = out[i];
                rgb[dst++] = out[i + 1];
                rgb[dst++] = out[i + 2];
            }
        }
        prev = out;
    }
    return rgb;
}
/** The newest layout: TS gzipped into the pixels, behind "TIKTIKPX". */
function fromPixels(bytes) {
    const rgb = pngRgb(bytes);
    if (!rgb || rgb.length < 12)
        return null;
    for (let k = 0; k < TPIX.length; k++)
        if (rgb[k] !== TPIX[k])
            return null;
    const size = new DataView(rgb.buffer, rgb.byteOffset + 8, 4).getUint32(0);
    if (size <= 0 || 12 + size > rgb.length)
        return null;
    const ts = gunzipSync(rgb.subarray(12, 12 + size));
    return isTs(ts) ? new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength) : null;
}
/** An older layout: TS appended after the PNG's IEND chunk. */
function afterIend(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12)
            return null;
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        off += 12 + len;
        if (type === "IEND")
            return off < bytes.length && isTs(bytes, off) ? bytes.subarray(off) : null;
    }
    return null;
}
/** An older layout still: TS in a WebP's EXIF chunk. */
function webpExif(bytes) {
    const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    if (bytes.length < 16 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP")
        return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 12;
    while (off + 8 <= bytes.length) {
        const tag = ascii(off, 4);
        const n = view.getUint32(off + 4, true);
        off += 8;
        if (off + n > bytes.length)
            return null;
        if (tag === "EXIF") {
            const data = bytes.subarray(off, off + n);
            return data.length > 188 && isTs(data) ? data : null;
        }
        off += n + (n & 1);
    }
    return null;
}
/** Exported for the standalone check below; the host calls it through
 *  `decoders.tiktikpx`. */
export function unwrapSegment(bytes) {
    if (isTs(bytes))
        return bytes;
    const webp = webpExif(bytes);
    if (webp)
        return webp;
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
        const tail = afterIend(bytes);
        if (tail)
            return tail;
        const pixels = fromPixels(bytes);
        if (pixels)
            return pixels;
        throw new Error("crichd: PNG segment with no TS payload");
    }
    const raw = find(bytes, TRAW);
    if (raw >= 0 && isTs(bytes, raw + TRAW.length))
        return bytes.subarray(raw + TRAW.length);
    const gz = find(bytes, TSGZ);
    if (gz >= 0) {
        const ts = gunzipSync(bytes.subarray(gz + TSGZ.length));
        return new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength);
    }
    for (let i = 0; i + 188 < bytes.length; i++)
        if (isTs(bytes, i))
            return bytes.subarray(i);
    throw new Error("crichd: segment with no TS payload");
}
function streamFor(source, row) {
    const mislabelled = source.kind === "trendy" && !slugAgrees(row.channel, slugParts(source.key).base);
    return {
        url: handleFor(source),
        quality: qualityOf(row),
        labels: [row.channel, row.language, ...(mislabelled ? ["Name unverified"] : [])].filter(Boolean),
        referrer: "",
        userAgent: "",
        resolver: RESOLVER,
        // streame's segment format is unverified (its feed was down); the
        // other two are PNG-wrapped.
        ...(source.kind === "streame" ? {} : { decoder: DECODER })
    };
}
async function fetchLive() {
    const listed = await fetchListing(Date.now());
    if (!listed.length)
        return { events: [], channels: [] };
    const pages = await mapWithConcurrency(listed, 4, async (event) => ({
        event,
        page: await fetchEventPage(event.slug).catch((cause) => {
            console.error(`crichd: ${event.slug} skipped`, cause);
            return null;
        })
    }));
    // Every page failing is the site being down, not nothing being on.
    if (pages.every((p) => !p.page))
        throw new Error("crichd: no event page could be read");
    const known = await knownChannels();
    const events = [];
    const channels = new Map();
    for (const { event, page } of pages) {
        if (!page)
            continue;
        const rows = page.rows.flatMap((row) => {
            const source = classify(row.embed);
            return source ? [{ row, source }] : [];
        });
        if (!rows.length) {
            console.error(`crichd: ${event.slug}: none of ${page.rows.length} sources is a supported embed`);
            continue;
        }
        // A country the slug states for one row serves every row of that name.
        const hints = new Map();
        for (const { row, source } of rows) {
            if (source.kind !== "trendy")
                continue;
            const { base, country } = slugParts(source.key);
            if (country && slugAgrees(row.channel, base))
                hints.set(fold(cleanChannelName(row.channel)), country);
        }
        const streams = [];
        const languages = new Set();
        for (const { row, source } of rows) {
            const stream = streamFor(source, row);
            const code = languageCode(row.language);
            if (code)
                languages.add(code);
            if (!streams.some((s) => s.url === stream.url))
                streams.push(stream);
            if (stream.labels.includes("Name unverified"))
                continue;
            const cleaned = cleanChannelName(row.channel);
            if (!cleaned)
                continue;
            const own = source.kind === "trendy" ? slugParts(source.key).country : "";
            const { name, country } = canonical(cleaned, own || hints.get(fold(cleaned)) || "", known);
            const id = idFor(`channel:${fold(name)}:${country.toLowerCase() || "xx"}`);
            const channel = channels.get(id) || {
                id,
                name,
                country,
                countryName: country ? countryNameOf(country) : "",
                countryFlag: country ? flagOf(country) : "",
                categories: ["sports"],
                languages: [],
                logo: "",
                website: SITE,
                network: "",
                streams: []
            };
            if (!channel.streams.some((s) => s.url === stream.url))
                channel.streams.push(stream);
            if (code && !channel.languages.includes(code))
                channel.languages.push(code);
            channels.set(id, channel);
        }
        const league = event.league.toLowerCase();
        const described = eventFor(page.title || event.slug.replace(/-/g, " "), {
            ...(page.names.length === 2 ? { sides: page.names } : {}),
            competition: event.league,
            sport: "cricket",
            start: event.start
        });
        events.push({
            id: idFor(`event:${event.slug}`),
            name: described.name,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", "cricket", ...(league && league !== "cricket" ? [league] : [])],
            languages: [...languages],
            // Both flags drawn together where the page has two sides; the league's own picture otherwise.
            logo: page.flags[0] || event.leagueLogo,
            ...(page.flags.length === 2 ? { logos: page.flags } : {}),
            event: described.event,
            website: `${SITE}/events/${event.slug}`,
            network: SCRAPER_NAME,
            streams
        });
    }
    return { events, channels: [...channels.values()] };
}
// --- tasks, caches and build() -----------------------------------------------------
const configSchema = [
    {
        key: "eventsIntervalMinutes",
        label: "Live matches refresh interval (minutes)",
        type: "number",
        default: 30,
        min: 10,
        help: "How often the home page is re-read for matches that are on now, and each match's channel list."
    }
];
/*
    EVERYTHING HERE COMES FROM THE LIVE MATCHES: the channels are the ones a
    match's source list names. So `build()` has nothing of its own and
    `buildEvents()` carries both.
*/
async function build() {
    return { channels: [] };
}
async function buildEvents() {
    const { events, channels } = await fetchLive();
    const ids = events.map((e) => e.id);
    return {
        channels: [...events, ...channels],
        /*
            TWO RAILS, ONE CONTENT. "Live Events" is the heading every
            live-events scraper here shares, so the host merges them into
            one rail with one card per fixture; "Live Cricket" is the one
            ntvst gives its cricket fixtures. Both are exact on purpose.
        */
        rails: ids.length
            ? [
                { id: "live-events", heading: "Live Events", channelIds: ids, group: "Live events" },
                { id: "live-cricket", heading: "Live Cricket", channelIds: ids, group: "Live events" }
            ]
            : []
    };
}
export const crichdScraper = {
    id: SCRAPER_ID,
    name: SCRAPER_NAME,
    version: "1.5.4",
    configSchema,
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    resolvers: { [RESOLVER]: resolveHandle },
    build,
    buildEvents
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/crichd.mts` -- prints what is live, then resolves every
// distinct source and checks its playlist and first segment decode, so a
// change in any embed shows up here, not on a sofa.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const catalogue = await buildEvents();
        const events = catalogue.channels.filter((c) => c.id.includes(":event:"));
        console.log(`${events.length} live events, ${catalogue.channels.length - events.length} channels, ${(catalogue.rails || []).length} rails`);
        for (const event of events) {
            console.log(`\n${event.name}  [${event.categories.join(", ")}]  languages=${event.languages.join(",") || "-"}`);
            for (const stream of event.streams)
                console.log(`  ${stream.url}  ${stream.quality}  ${stream.labels.join(" | ")}${stream.decoder ? "  (decoder)" : ""}`);
        }
        for (const channel of catalogue.channels.filter((c) => !c.id.includes(":event:"))) {
            console.log(`channel: ${channel.name} [${channel.country || "-"}] x${channel.streams.length}`);
        }
        const handles = new Map();
        for (const channel of catalogue.channels)
            for (const stream of channel.streams)
                handles.set(stream.url, stream);
        for (const [handle, stream] of handles) {
            const resolved = await resolveHandle(handle);
            if (!resolved) {
                console.log(`\n${handle}: not resolvable / not on air right now`);
                continue;
            }
            const headers = { "User-Agent": BROWSER_UA, ...(resolved.referrer ? { Referer: resolved.referrer } : {}) };
            const playlist = await (await fetch(resolved.url, { headers })).text();
            const segmentUrl = playlist.split("\n").find((line) => /^https?:/.test(line.trim()));
            if (!segmentUrl) {
                console.log(`\n${handle} -> ${resolved.url}: playlist without segments`);
                continue;
            }
            const segment = new Uint8Array(await (await fetch(segmentUrl.trim(), { headers })).arrayBuffer());
            const ts = stream.decoder ? unwrapSegment(segment) : segment;
            console.log(`\n${handle} -> ${resolved.url}\n  segment: ${segment.length} bytes in, ${ts.length} out, TS sync ${ts[0] === 0x47 && ts[188] === 0x47}`);
        }
    })().catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
