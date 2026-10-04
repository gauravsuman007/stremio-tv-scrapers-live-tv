/**
 * ntv.st -- 24/7 live-TV channels plus a live sporting-events rail.
 *
 * Ported from the `DirectScraper`-style scraper (`scrapers/ntvst.py` in this
 * same repo / in riven-tpdb-scrapers) to the `Scraper.build()` contract
 * described in `docs/scraper-template.ts`. The reverse-engineering notes
 * below are unchanged from that scraper -- only the shape of the output
 * (one `build()` call returning every channel up front, rather than a
 * `search`/`resolve` pair called on demand) is new.
 *
 * **The site multiplexes three completely different backends behind one
 * channel list**, named in its own JSON as `cdnlive`, `hesgoales` and
 * `dlhd` (~4% / ~87% / ~9% of ~10.4k channels, sampled 2026-09). Three of
 * the four resulting backends are handled here:
 *
 * - `cdnlive` channels carry their own `channel_url` straight in the list
 *   response, pointing at cdnlivetv.tv's player page. That page's HTML is
 *   regenerated per-request with randomised variable names wrapping a
 *   fixed shape: several `var <random>='<base64url fragment>';`
 *   assignments and one assembly line `var <random>=<decoder>(<fragA>)+
 *   <decoder>(<fragB>)+...;` whose *value* -- not its name -- is the live
 *   `.m3u8` URL. `extractCdnliveStreamUrl` reads the assembly line's shape
 *   to learn which fragments to decode and in what order, since the
 *   identifiers themselves change every fetch.
 * - `hesgoales` channels (the largest backend) fan out through two
 *   unrelated sites:
 *   - `hesgoal.team` is a dead end on its own -- it just iframes
 *     `wideiptv.top/player/<slug>` after cleaning the id
 *     (`id.trim().replace(/[/\.?&=]/g, '')`, replicated in
 *     `cleanHesgoalSlug`). That page hands back the stream URL in the
 *     clear, a plain `streamUrl: "https:\/\/<cdn>/<slug>/index.m3u8?
 *     token=..."` JS literal -- no obfuscation, unlike `cdnlive`.
 *   - `epicsports-tv.com` (~75% of this bucket -- the majority of the
 *     *entire* catalogue) polls its own `/decode.php` for a
 *     `{token, code}` pair used to build a chunked `video/webm` URL.
 *     `decode.php` takes no query string of its own -- the channel id it
 *     needs travels only in the `Referer` header
 *     (`https://epicsports-tv.com/eu.html?id=<id>`) -- and is genuinely
 *     flaky, succeeding roughly half the time even with correct params
 *     (the site's own page just retries on exactly this failure, so
 *     `decodeEpicsports` does too).
 * - `dlhd` channels resolve to an iframe chain: `dlhd.st/stream/stream-
 *   <id>.php` (a plain domain alias of `dlive.sx`, same HTML) embeds
 *   `daddyliveplayer.st/premiumtv/daddy.php?id=<id>` -- a "DaddyLive"-family
 *   player, re-verified 2026-09-28 (re-checked after an earlier pass found
 *   this hop obfuscated and domain-locked to `assetrage.net`; the site has
 *   since swapped in a different, unobfuscated player at the same iframe
 *   slot). That page hands back a bare `const SRC = "https://edge.<random>
 *   .sbs/premium<id>/index.m3u8"` in the clear -- no token needed on either
 *   hop, no `Referer` required even. **Still not resolved here, for a
 *   different reason than before:** every segment listed in that `.m3u8` is
 *   a genuine, valid PNG (confirmed against real bytes -- PNG magic number,
 *   not a renamed/mislabeled `.ts` the way ShuttleTV's `.jpg` segments
 *   are), with the real MPEG-TS payload steganographically hidden in its
 *   reconstructed RGB pixel data behind a `TIKTIKPX`-tagged, gzip-compressed
 *   blob (see `daddyliveplayer.st`'s own `pngRGB`/`unwrap`/`LiveLoader`
 *   functions, which every fragment passes through before hls.js ever sees
 *   it). A plain HLS client -- ffmpeg, the relay, any conforming player --
 *   fetches a real image and finds no TS sync byte at all. Unwrapping it is
 *   a straightforward port of that site's own plain-JS algorithm (no WASM,
 *   no anti-tamper trap this time), but there is nowhere to run it: this
 *   scraper's contract is "hand back a URL, referrer and headers", not an
 *   ongoing per-segment transform, and a live channel's segments can't be
 *   pre-decoded once at `build()` time the way a VOD file could be. This
 *   backend needs a decoding relay in front of the CDN (fetch each
 *   `.ts.png`, unwrap, re-serve as real `video/MP2T`) -- a host-side
 *   capability this repository has no way to provide, not a research gap.
 *   Channels on this backend are skipped rather than handed back broken.
 *   (Since 2026-10-01 that relay exists -- the scraper contract's segment
 *   `decoders`, run by live-tv -- and `dlhd.mts` uses it for
 *   the whole DaddyLive catalogue, a superset of these ~200 channels. They
 *   stay skipped here so the two do not list the same feeds twice.)
 *
 * `buildEventsRail()` is a second, unrelated bulk-export for ntv.st's
 * *live events* (single sporting fixtures, e.g. "Liverpool FC v.
 * Manchester United"), sourced from `/api/get-matches`, not the channel
 * index. It targets the `falcon` mirror server, not `kobra` (the
 * homepage's own default): `kobra`'s events all dead-end at the same
 * unsolved `dlhd`-family backend above, while `falcon` resolves cleanly
 * through `livelive24.com` to bare, directly-playable `.m3u8` URLs, in
 * exchange for a different (mostly disjoint) event catalogue.
 *
 * Every resolved URL, from every backend, carries a short-lived token
 * (minutes, not hours). Nothing here should be cached -- `build()` fetches
 * everything fresh on every call, same as the nightly rebuild expects.
 */
// BEGIN event-key -- identical in every scraper that lists live events. scripts/sync-event-key.mjs keeps the copies in step.
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
    let name = raw.replace(EVENT_DECORATION, "").replace(/\s+/g, " ").trim();
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
            ...(extra.sport ? { sport: extra.sport } : {}),
            ...(extra.start && extra.start > 0 ? { start: extra.start } : {})
        }
    };
}
const SCRAPER_ID = "ntvst";
function idFor(rawId) {
    return `live:${SCRAPER_ID}:${rawId}`;
}
async function withTimeout(work, ms = 20_000) {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: `fetch` resolves on
    // headers, and the caller's body read (`.text()`/`.json()`) still needs
    // this signal armed, or a server that stalls mid-body hangs forever.
    // `unref` keeps the pending timer from holding the process open.
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
/** Runs `items` through `worker` with at most `limit` in flight at once --
 *  the channel/match catalogues are large enough (thousands of entries,
 *  each needing its own resolve round-trip) that running them fully in
 *  parallel would hammer ntv.st's upstreams; fully serial would be far too
 *  slow for a twelve-hourly rebuild. */
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
        while (next < items.length) {
            const i = next++;
            results[i] = await worker(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
//: ntv.st's own API rate-limits fairly aggressively under a burst of
//: back-to-back requests -- CHANNEL_PAGE_PACING_MS below avoids tripping
//: it in the first place for the common case, but a channel resolve
//: (resolveHesgoal, resolveEpicsports) can still legitimately burst
//: against a THIRD-PARTY host, so this stays as a safety net. Retrying
//: with backoff clears it in practice; it is not a sign the request
//: itself was wrong.
const RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_BACKOFF_MS = 2_000;
async function fetchText(url, init) {
    const retries = init?.retries ?? RATE_LIMIT_RETRIES;
    for (let attempt = 0;; attempt++) {
        const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(init?.headers || {}) } }));
        if (response.ok)
            return response.text();
        if (response.status === 429 && attempt < retries) {
            // The server says how long it wants; otherwise back off hard and
            // longer each time. A 429 on the channel index is a window, not a
            // verdict -- giving up at the 6th try (~40s) failed whole builds.
            const asked = Number(response.headers.get("retry-after"));
            const wait = Number.isFinite(asked) && asked > 0 ? asked * 1000 : RATE_LIMIT_BACKOFF_MS * (attempt + 1);
            await new Promise((r) => setTimeout(r, Math.min(wait, 120_000)));
            continue;
        }
        throw new Error(`${url} -> ${response.status}`);
    }
}
async function fetchJson(url, init) {
    return JSON.parse(await fetchText(url, init));
}
// --- live events (buildEventsRail) ---------------------------------------
const MATCH_INDEX_URL = "https://ntv.st/api/get-matches";
//: `falcon`, not `kobra` (the homepage tab's own default) -- see the module
//: docstring for why.
const DEFAULT_MATCH_SERVER = "falcon";
const EMBED_TOKEN_RE = /embed\?t=[^"'&]+/;
const STREAM_IFRAME_SRC_RE = /id="streamIframe"[\s\S]{0,80}?src="([^"]+)"/;
/** The bare `.m3u8` URL behind a `livelive24.com` embed link, or `null` if
 *  `embedUrl` isn't one of the two known livelive24.com shapes. */
function extractLivelive24StreamUrl(embedUrl) {
    let parsed;
    try {
        parsed = new URL(embedUrl);
    }
    catch {
        return null;
    }
    if (parsed.hostname !== "livelive24.com")
        return null;
    const raw = parsed.searchParams.get("url");
    if (!raw)
        return null;
    if (parsed.pathname === "/dlhd.html") {
        const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
        try {
            return Buffer.from(padded, "base64").toString("utf-8");
        }
        catch {
            return null;
        }
    }
    if (parsed.pathname === "/test.html") {
        // `URLSearchParams.get` already undoes ordinary query-string
        // escaping in one step -- no second decode needed or correct here.
        return raw;
    }
    return null;
}
// --- cdnlive ---------------------------------------------------------------
const FRAGMENT_ASSIGN_RE = /var (\w+)='([^']*)';/g;
//: The assembly line the player HTML uses to build its live URL: some
//: variable set to a chain of `<decoderName>(<fragmentName>)` calls. The
//: decoder's own name is random too, so only the shape is matched here.
const ASSEMBLY_RE = /var \w+=((?:\w+\(\w+\)\+?)+);/;
const CALL_RE = /\w+\((\w+)\)/g;
/** Undo cdnlivetv.tv's base64url-ish encoding of one URL fragment. */
function b64urlDecode(fragment) {
    const padded = fragment.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    try {
        return Buffer.from(withPad, "base64").toString("utf-8");
    }
    catch {
        return "";
    }
}
/** The live `.m3u8` URL hidden in a cdnlivetv.tv player page -- reads the
 *  shape of the assembly line rather than any fixed variable name, since
 *  every name in the page is randomised per request. */
function extractCdnliveStreamUrl(page) {
    const assembly = ASSEMBLY_RE.exec(page);
    if (!assembly)
        return null;
    const fragmentNames = [];
    for (const m of assembly[1].matchAll(CALL_RE))
        fragmentNames.push(m[1]);
    if (fragmentNames.length === 0)
        return null;
    const fragments = new Map();
    for (const m of page.matchAll(FRAGMENT_ASSIGN_RE))
        fragments.set(m[1], m[2]);
    const parts = [];
    for (const name of fragmentNames) {
        const fragment = fragments.get(name);
        if (fragment === undefined)
            return null;
        parts.push(b64urlDecode(fragment));
    }
    if (parts.some((p) => !p))
        return null;
    const url = parts.join("");
    return url.startsWith("http") ? url : null;
}
// --- hesgoales / hesgoal.team -----------------------------------------------
//: Both hesgoal.team and epicsports-tv.com carry their channel's id as
//: `?id=<...>` on the `channel_url` ntv.st's index hands back.
const ID_PARAM_RE = /[?&]id=([^&]+)/;
//: The exact character class hesgoal.team's own inline JS strips from the
//: `id` query parameter before handing it to wideiptv.top.
const HESGOAL_UNSAFE_SLUG_CHARS_RE = /[/\\.?&=]/g;
const HESGOAL_STREAM_URL_RE = /streamUrl["']?\s*:\s*"([^"]+)"/;
function cleanHesgoalSlug(rawId) {
    return rawId.trim().replace(HESGOAL_UNSAFE_SLUG_CHARS_RE, "") || "SPT1";
}
/** The live `.m3u8` URL out of a wideiptv.top player page -- a plain JS
 *  string literal, the only work is undoing its `\/` escape. */
function extractHesgoalStreamUrl(page) {
    const match = HESGOAL_STREAM_URL_RE.exec(page);
    if (!match)
        return null;
    const url = match[1].replace(/\\\//g, "/");
    return url.startsWith("http") ? url : null;
}
// --- hesgoales / epicsports-tv.com ------------------------------------------
const EPICSPORTS_DECODE_URL = "https://epicsports-tv.com/decode.php";
const EPICSPORTS_STREAM_BASE = "https://uv.dreamstream.cc";
//: `decode.php` genuinely fails to extract its own server-side number on
//: roughly half of all requests -- not avoidable, and not different from
//: what the site's own player does (it retries on exactly this error too).
const EPICSPORTS_DECODE_ATTEMPTS = 8;
/** The `{token, code}` pair `decode.php` hands out for one channel. Takes
 *  no query string of its own -- the channel id travels only in `Referer`. */
async function decodeEpicsports(channelId) {
    for (let i = 0; i < EPICSPORTS_DECODE_ATTEMPTS; i++) {
        let data;
        try {
            data = await fetchJson(EPICSPORTS_DECODE_URL, {
                headers: {
                    Accept: "application/json",
                    Referer: `https://epicsports-tv.com/eu.html?id=${channelId}`,
                },
            });
        }
        catch {
            continue;
        }
        const parsed = data?.parsed_data || {};
        if (parsed.status === "OK" && parsed.token && parsed.code) {
            return { token: parsed.token, code: parsed.code };
        }
    }
    return null;
}
// --- per-backend resolvers ---------------------------------------------------
//: cdnlivetv.tv allows 100 requests a minute per address and answers the
//: rest with a bare 429 (no Retry-After; the wait is in `ratelimit-reset`).
//: There are ~4,000 channels on it, so a crawl is bound by this and by
//: nothing else: unthrottled, twelve workers burned the minute's budget in
//: seconds and then spent the rest of the build sleeping in per-request
//: backoffs (hours). One shared pacer keeps the whole crawl just under the
//: limit, and a 429 pauses every worker until the window resets.
const CDNLIVE_PER_MINUTE = 85;
let cdnliveNext = 0;
async function cdnliveSlot() {
    const now = Date.now();
    const at = Math.max(now, cdnliveNext);
    cdnliveNext = at + 60_000 / CDNLIVE_PER_MINUTE;
    if (at > now)
        await new Promise((r) => setTimeout(r, at - now));
}
async function fetchCdnlive(channelUrl) {
    for (let attempt = 0;; attempt++) {
        await cdnliveSlot();
        const response = await withTimeout((signal) => fetch(channelUrl, { signal, headers: { "User-Agent": BROWSER_UA } }));
        if (response.ok)
            return response.text();
        if (response.status === 429 && attempt < 5) {
            const reset = Number(response.headers.get("ratelimit-reset"));
            const wait = (Number.isFinite(reset) && reset > 0 ? reset : 30) * 1000 + 500;
            cdnliveNext = Math.max(cdnliveNext, Date.now() + wait);
            continue;
        }
        throw new Error(`${channelUrl} -> ${response.status}`);
    }
}
async function resolveCdnlive(channelUrl) {
    const page = await fetchCdnlive(channelUrl);
    const streamUrl = extractCdnliveStreamUrl(page);
    if (!streamUrl)
        return null;
    return {
        url: streamUrl,
        quality: "",
        labels: [],
        // The token in `streamUrl` is short-lived and IP-bound in practice,
        // so it is fetched fresh on every `build()` call rather than cached.
        referrer: "https://cdnlivetv.tv/",
        userAgent: BROWSER_UA,
    };
}
async function resolveHesgoal(slug) {
    const page = await fetchText(`https://wideiptv.top/player/${slug}`, {
        headers: { Referer: "https://hesgoal.team/" },
    });
    const streamUrl = extractHesgoalStreamUrl(page);
    if (!streamUrl)
        return null;
    return {
        url: streamUrl,
        quality: "",
        labels: [],
        referrer: "https://wideiptv.top/",
        userAgent: BROWSER_UA,
    };
}
async function resolveEpicsports(channelId) {
    const pair = await decodeEpicsports(channelId);
    if (!pair)
        return null;
    // Whether this URL is actually live is not checked here -- a dead
    // channel surfaces as a 404 from uv.dreamstream.cc at play time, which
    // the nightly playability sweep catches, not something build() decides.
    const streamUrl = `${EPICSPORTS_STREAM_BASE}/${pair.token}/${pair.code}/${channelId}/webm`;
    return {
        url: streamUrl,
        quality: "",
        labels: [],
        referrer: "https://epicsports-tv.com/",
        userAgent: BROWSER_UA,
    };
}
/** Resolves one raw channel entry from `/api/get-channels` to its stream,
 *  routing to whichever backend actually serves it. Returns `null` for
 *  `dlhd` channels (unresolved -- see the module docstring) and for any
 *  channel whose resolve step fails, rather than throwing -- one dead
 *  channel should not take down the whole catalogue build. */
async function resolveChannelStream(channel) {
    const server = channel.server || "";
    const channelUrl = channel.channel_url || "";
    try {
        if (server === "cdnlive") {
            return channelUrl ? await resolveCdnlive(channelUrl) : null;
        }
        if (server === "hesgoales") {
            let host = "";
            try {
                host = new URL(channelUrl).hostname;
            }
            catch {
                return null;
            }
            if (host === "hesgoal.team") {
                const match = ID_PARAM_RE.exec(channelUrl);
                if (!match)
                    return null;
                return await resolveHesgoal(cleanHesgoalSlug(decodeURIComponent(match[1])));
            }
            if (host === "epicsports-tv.com") {
                const match = ID_PARAM_RE.exec(channelUrl);
                if (!match)
                    return null;
                return await resolveEpicsports(decodeURIComponent(match[1]).trim());
            }
            // The small remainder of `hesgoales` on other hosts (e.g.
            // hesgoaler.com) is left unresolved rather than guessed at.
            return null;
        }
        // `dlhd` -- unresolved, see the module docstring.
        return null;
    }
    catch {
        return null;
    }
}
const CHANNEL_INDEX_URL = "https://ntv.st/api/get-channels";
//: The API caps `limit` at 100 server-side regardless of what is
//: requested, so paging by 100 is the fastest this endpoint allows.
const CHANNEL_PAGE_SIZE = 100;
//: Bounds how many channel resolves (each its own HTTP round-trip against
//: cdnlivetv.tv/wideiptv.top/epicsports-tv.com) run at once.
const CHANNEL_RESOLVE_CONCURRENCY = 12;
//: Measured against the real API: firing pagination requests back-to-back
//: with no pacing trips its rate limiter after roughly 35-60 consecutive
//: requests (varies by run), and once tripped it can take longer to clear
//: than RATE_LIMIT_RETRIES' backoff allows, failing the whole build. A
//: flat 250ms between page requests -- confirmed empirically to clear the
//: entire ~12k-channel catalogue (120+ pages) with zero 429s -- avoids
//: tripping it in the first place, which is cheaper and more reliable than
//: recovering from it after the fact. Configurable (see `configSchema`
//: below) since a different deployment may sit behind a different network
//: path to ntv.st and need more, or could afford less.
const DEFAULT_CHANNEL_PAGE_PACING_MS = 600;
//: Pages already fetched by a crawl that then failed, so the next attempt
//: resumes where it stopped instead of starting at offset 0 and walking
//: back into the same rate limit.
let pagesHeld = [];
//: Patient retries for the channel index specifically: ~100 pages from one
//: address trips ntv.st's limiter, and it clears in a minute or two.
const CHANNEL_PAGE_RETRIES = 12;
async function fetchAllChannels(pacingMs) {
    let offset = pagesHeld.length;
    const pace = pacingMs;
    let first = offset === 0;
    while (true) {
        if (!first)
            await new Promise((r) => setTimeout(r, pace));
        first = false;
        const data = await fetchJson(`${CHANNEL_INDEX_URL}?limit=${CHANNEL_PAGE_SIZE}&offset=${offset}`, { retries: CHANNEL_PAGE_RETRIES });
        if (!data.success)
            break;
        const channels = data.channels || [];
        if (channels.length === 0)
            break;
        pagesHeld.push(...channels);
        if (!data.has_more)
            break;
        offset += CHANNEL_PAGE_SIZE;
    }
    const all = pagesHeld;
    pagesHeld = [];
    return all;
}
async function buildChannels(pacingMs) {
    const raw = await fetchAllChannels(pacingMs);
    console.log(`ntvst: ${raw.length} channels listed, resolving streams`);
    let resolved = 0;
    const streams = await mapWithConcurrency(raw, CHANNEL_RESOLVE_CONCURRENCY, async (channel) => {
        const stream = await resolveChannelStream(channel);
        if (++resolved % 1000 === 0)
            console.log(`ntvst: resolved ${resolved}/${raw.length}`);
        return stream;
    });
    console.log(`ntvst: channel crawl done, ${streams.filter(Boolean).length} playable`);
    const channels = [];
    for (let i = 0; i < raw.length; i++) {
        const stream = streams[i];
        if (!stream)
            continue; // dlhd, unrecognised host, or a failed resolve.
        const entry = raw[i];
        // Same value used for both id-namespacing input and display name --
        // ntv.st has no other stable per-channel identifier in this
        // response, so the (already-unique, per-backend) resolve key
        // doubles as the id's raw segment.
        const rawId = entry.channel_url || entry.channel_name || `${i}`;
        channels.push({
            id: idFor(rawId),
            name: entry.channel_name || "Untitled",
            country: "",
            countryName: "",
            countryFlag: "",
            categories: [],
            languages: [],
            logo: entry.channel_image || "",
            website: "",
            network: "",
            streams: [stream],
        });
    }
    return channels;
}
/** The bare stream URL(s) for one live event. In testing this was always a
 *  single URL regardless of how many entries the match's own `sources`
 *  list carried -- ntv.st's `/watch/` page already picks one before
 *  minting the embed token -- but this returns a list in case a future
 *  deployment exposes more than one. */
async function resolveMatchStreamUrls(server, match) {
    if (!match.id)
        return [];
    const watchPage = await fetchText(`https://ntv.st/watch/${server}/${match.id}`);
    const tokenMatch = EMBED_TOKEN_RE.exec(watchPage);
    if (!tokenMatch)
        return [];
    const embedPage = await fetchText(`https://ntv.st/${tokenMatch[0]}`);
    const srcMatch = STREAM_IFRAME_SRC_RE.exec(embedPage);
    if (!srcMatch)
        return [];
    const streamUrl = extractLivelive24StreamUrl(srcMatch[1]);
    if (streamUrl)
        return [streamUrl];
    // Not a livelive24.com destination this scraper knows how to unwrap
    // (most often `embed.st`, the same unsolved backend as `dlhd` -- see
    // the module docstring). Dropped rather than handed back as an
    // unplayable embed page: this surface expects a bare stream URL per
    // `ScrapedStream.url`, unlike the DirectScraper version of this file.
    return [];
}
//: Bounds how many event resolves (each a two-hop /watch -> /embed chain)
//: run at once.
const MATCH_RESOLVE_CONCURRENCY = 8;
async function buildEventsRail(server = DEFAULT_MATCH_SERVER) {
    const data = await fetchJson(`${MATCH_INDEX_URL}?server=${server}&type=both`);
    if (!data.success)
        return { channels: [], rails: [] };
    const matches = data.live || [];
    const urlsByMatch = await mapWithConcurrency(matches, MATCH_RESOLVE_CONCURRENCY, (match) => resolveMatchStreamUrls(server, match).catch(() => []));
    const eventChannels = [];
    for (let i = 0; i < matches.length; i++) {
        const urls = urlsByMatch[i];
        if (urls.length === 0)
            continue;
        const match = matches[i];
        const category = match.category || "uncategorized";
        const described = eventFor(match.title || "Untitled", { sport: category === "uncategorized" ? "" : category.toLowerCase() });
        eventChannels.push({
            category,
            channel: {
                id: idFor(`event:${server}:${match.id}`),
                name: described.name,
                event: described.event,
                country: "",
                countryName: "",
                countryFlag: "",
                categories: [category],
                languages: [],
                logo: "",
                website: "",
                network: "",
                streams: urls.map((url) => ({
                    url,
                    quality: "",
                    labels: ["Live event"],
                    referrer: "",
                    userAgent: BROWSER_UA,
                })),
            },
        });
    }
    /*
        ONE RAIL, NOT ONE PER CATEGORY -- and its heading is "Live Events"
        on purpose, not this scraper's own name or a category name. The
        host merges any two scrapers' rails whose headings match (see
        `ScrapedRail.heading` in the template), so a second live-events
        scraper that also calls its rail "Live Events" lands its fixtures
        in the SAME rail as this one's, each event deduplicated by name
        the same way an ordinary channel is -- a fixture both scrapers
        carry becomes one card with two sources, not two cards. Splitting
        by category here, as this used to, would give every category its
        own per-scraper rail instead and defeat that merge entirely; a
        viewer who wants to browse by sport still has `categories` on each
        event channel for that.
    */
    if (!eventChannels.length)
        return { channels: [], rails: [] };
    /*
        PLUS ONE RAIL PER SPORT. The combined rail above stays (it is the one
        other event scrapers merge into); the per-sport ones let a viewer
        who wants football open "Live Soccer" instead of scanning a rail
        mostly made of e-sports. The generic buckets ntv.st files unlabelled
        fixtures under are not sports, so they get no rail of their own.
    */
    const bySport = new Map();
    for (const e of eventChannels) {
        if (/^(sports event|uncategorized)$/i.test(e.category))
            continue;
        const ids = bySport.get(e.category) || [];
        ids.push(e.channel.id);
        bySport.set(e.category, ids);
    }
    const sportRails = [...bySport.entries()].map(([category, channelIds]) => ({
        id: `live-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        heading: `Live ${category}`,
        channelIds,
        group: "Live events"
    }));
    return {
        channels: eventChannels.map((e) => e.channel),
        rails: [{ id: "live-events", heading: "Live Events", channelIds: eventChannels.map((e) => e.channel.id), group: "Live events" }, ...sportRails]
    };
}
// --- entry point -----------------------------------------------------------
/**
 * User-settable knobs, shown in Settings > Live TV > Sources next to a gear
 * icon beside "NTVSTREAM" once this is imported. The two intervals are read
 * by the host for the two jobs (`build()` and `buildEvents()`): the full
 * channel list is large and slow to rebuild, so it defaults to twice a day,
 * while the live-events rail is cheap and time-sensitive (a fixture can
 * start mid-day), so it defaults to every 15 minutes.
 */
const configSchema = [
    {
        key: "channelsIntervalMinutes",
        label: "Channel list refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 30,
        help: "How often the full 24/7 channel catalogue is re-scraped. This is the slow, expensive fetch -- there is rarely a reason to run it more than a couple of times a day."
    },
    {
        key: "eventsIntervalMinutes",
        label: "Live events refresh interval (minutes)",
        type: "number",
        default: 15,
        min: 5,
        help: "How often the live sporting-events rail is refreshed. Kept separate from the channel list above since fixtures start and end throughout the day."
    },
    {
        key: "pagePacingMs",
        label: "Channel-list page pacing (ms)",
        type: "number",
        default: DEFAULT_CHANNEL_PAGE_PACING_MS,
        min: 0,
        max: 5000,
        help: "Delay between channel-list page requests. 250ms cleared the catalogue from a home connection but the server's address got 429s at that rate, so the default is 600ms -- lower this only if a specific deployment's network path can safely go faster."
    }
];
/*
    TWO JOBS, run and scheduled separately by the host: `build()` is the
    channel list (the slow one -- a cold crawl is 10k+ resolves and takes the
    better part of an hour) and `buildEvents()` the live events (five
    seconds). Neither waits for the other, which is the whole point: a fixture
    that starts mid-afternoon must not sit behind an hour-long crawl.

    SINGLE-FLIGHT, BECAUSE THE HOST'S WAIT CAN GIVE UP BEFORE THE CRAWL DOES.
    If the host's time limit ends a `build()` while the crawl is still going,
    the crawl is not abandoned (it would have to start over); the next
    `build()` joins it instead of starting a second one -- two paginated
    crawls at once is exactly what trips ntv.st's rate limiter, whatever
    `pagePacingMs` says.
*/
let crawl = null;
async function build(context) {
    const pacingMs = Number(context?.config.pagePacingMs ?? DEFAULT_CHANNEL_PAGE_PACING_MS);
    crawl ||= buildChannels(pacingMs).finally(() => {
        crawl = null;
    });
    const channels = await crawl;
    return { channels, rails: railsFor(channels, SCRAPER_ID, "NTVSTREAM") };
}
async function buildEvents() {
    const { channels, rails } = await buildEventsRail();
    return { channels, rails };
}
// -------------------------------------------------------------------------
// Rails from this source's own data: its countries, its languages, its
// category words, and "everything on this source".
//
// The host merges rails with the same name (or the same filter) from every
// source into ONE rail, and counts a rail's channels over the whole index,
// so declaring generously is right: a country this source has one channel
// in is still a rail once other sources add theirs, and a rail that stays
// too small is simply not offered.
// -------------------------------------------------------------------------
/** Which part of the world a country is in, for the "Countries" groups. */
const CONTINENTS = [
    ["Asia", "AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE AE"],
    ["Europe", "AD AL AT BA BE BG BY CH CZ DE DK EE ES FI FO FR GB UK GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK"],
    ["Africa", "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW RE"],
    ["North America", "US CA MX GL BM"],
    ["Latin America & Caribbean", "AG AI AR AW BB BO BQ BR BS BZ CL CO CR CU CW DM DO EC GD GT GY HN HT JM KN KY LC NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI MQ GP GF"],
    ["Oceania", "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS"]
];
function continentName(code) {
    return CONTINENTS.find(([, codes]) => codes.split(" ").includes(code.toUpperCase()))?.[0] || "Elsewhere";
}
function languageTitle(code) {
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
        return name && name !== code ? name : code.toUpperCase();
    }
    catch {
        return code.toUpperCase();
    }
}
/** Words the host's own genre rails (News, Sports, Movies ...) already carry under the same name. */
const GENRE_NAMES = new Set([
    "news", "sports", "movies", "kids", "music", "documentary", "lifestyle", "business", "entertainment", "general"
]);
/** Never offered as a rail: shopping and adult shelves. */
const UNLISTED = /\b(shop\w*|xxx|adult|erotic\w*|sinnlich\w*|telesales|18\+)\b/i;
function railsFor(channels, sourceId, sourceName, wanted = { countries: true, languages: true, categories: true }) {
    const rails = [];
    const perCountry = new Map();
    const perLanguage = new Map();
    const perWord = new Map();
    const perNetwork = new Map();
    for (const channel of channels) {
        if (channel.country) {
            const entry = perCountry.get(channel.country) || { n: 0, names: new Map() };
            entry.n += 1;
            if (channel.countryName)
                entry.names.set(channel.countryName, (entry.names.get(channel.countryName) || 0) + 1);
            perCountry.set(channel.country, entry);
        }
        for (const code of new Set(channel.languages))
            perLanguage.set(code, (perLanguage.get(code) || 0) + 1);
        for (const word of new Set(channel.categories))
            perWord.set(word, (perWord.get(word) || 0) + 1);
        const network = (channel.network || "").trim();
        if (network) {
            const key = network.toLowerCase();
            perNetwork.set(key, { n: (perNetwork.get(key)?.n || 0) + 1, name: perNetwork.get(key)?.name || network });
        }
    }
    function byCount(a, b, size) {
        return size(b[1]) - size(a[1]) || a[0].localeCompare(b[0]);
    }
    if (wanted.countries) {
        for (const [code, entry] of [...perCountry.entries()].sort((a, b) => byCount(a, b, (v) => v.n))) {
            const name = [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            if (!name || !/^[A-Za-z]{2,3}$/.test(code))
                continue;
            rails.push({
                id: `country-${code.toLowerCase()}`,
                heading: `Top channels in ${name}`,
                by: "Most widely carried",
                group: `Countries/${continentName(code)}`,
                channelIds: [],
                filter: { countries: [code] }
            });
        }
    }
    if (wanted.languages) {
        for (const [code] of [...perLanguage.entries()].sort((a, b) => byCount(a, b, (v) => v))) {
            if (!/^[a-z]{2,3}$/.test(code))
                continue;
            const name = languageTitle(code);
            rails.push({
                id: `language-${code}-home`,
                heading: `${name} channels`,
                by: "In your first country",
                group: "Languages/In your first country",
                channelIds: [],
                filter: { languages: [code], market: "first" }
            });
            rails.push({
                id: `language-${code}`,
                heading: `${name} channels worldwide`,
                by: "Your countries first",
                group: "Languages/Worldwide",
                channelIds: [],
                filter: { languages: [code], market: "home-first" }
            });
        }
    }
    if (wanted.categories) {
        const taken = new Set();
        let added = 0;
        for (const [word, count] of [...perWord.entries()].sort((a, b) => byCount(a, b, (v) => v))) {
            const slug = `cat-${word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");
            if (count < 3 || word.length > 40 || GENRE_NAMES.has(word) || UNLISTED.test(word) || slug === "cat" || taken.has(slug))
                continue;
            taken.add(slug);
            rails.push({
                id: slug,
                heading: word.replace(/(^|[\s(+&/-])(\p{L})/gu, (_all, lead, first) => lead + first.toUpperCase()).replace(/\bTv\b/g, "TV"),
                by: "Its own category",
                group: "Categories",
                channelIds: [],
                filter: { categories: [word] }
            });
            added += 1;
            if (added >= 60)
                break;
        }
    }
    if (wanted.networks !== false) {
        let added = 0;
        for (const [key, entry] of [...perNetwork.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
            const slug = `network-${key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");
            if (entry.n < 3 || key.length < 3 || key.length > 30 || slug === "network" || UNLISTED.test(key) || /[^\p{L}\p{N} &.+'-]/u.test(key) || sourceName.toLowerCase().includes(key) || key.includes(sourceName.toLowerCase()))
                continue;
            rails.push({
                id: slug,
                heading: entry.name,
                by: "One network",
                group: "Networks",
                channelIds: [],
                filter: { networks: [key] }
            });
            added += 1;
            if (added >= 60)
                break;
        }
    }
    if (channels.length >= 4) {
        rails.push({
            id: "source",
            heading: `All of ${sourceName}`,
            by: "Every channel it carries",
            group: "Sources",
            channelIds: [],
            filter: { sources: [sourceId] }
        });
    }
    return rails;
}
export const ntvStScraper = {
    id: SCRAPER_ID,
    name: "NTVSTREAM",
    version: "1.9.2",
    configSchema,
    build,
    buildEvents
};
// -------------------------------------------------------------------------
// Manual test: `npx tsx scrapers/ntvst.mts`
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
        console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
        console.log(catalogue.channels[0] || "(none)");
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
