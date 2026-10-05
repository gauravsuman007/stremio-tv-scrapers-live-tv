/**
 * WatchFooty (watchfooty.st) -- live football, American football, baseball,
 * basketball, cricket, golf and motorsport as events, each with several feeds.
 * Events only (the site has no 24/7 channels: its API has `/matches/*`
 * and `/sports` and nothing else).
 *
 * THE CHAIN (verified 2026-10-04, no browser)
 * -------------------------------------------
 *   1. `GET https://api.watchfooty.st/api/v1/matches/live` -> `[{ matchId,
 *      title, teams: {home, away: {name, logoUrl}}, league, sport, status
 *      ("in"), timestamp (epoch ms), streams: [{ source, url, quality,
 *      language }] }]`. Only a handful of live matches carry feeds.
 *      A stream's `url` is `https://sportsembed.su/embed/<id>/<slug>/<source>/<n>`
 *      (sources seen: `prime`, `pro`, `deluxe`, `platinum`, `hd`, `delta`,
 *      `hotel`).
 *   2. THE EMBED'S OWN HANDSHAKE -- the part that used to be filed as "WASM
 *      locked". The player (`assets.sportsembed.su/js/stream.js`) loads
 *      `/js/wasm/stream-lock.wasm`, a 44 KB Rust module with **zero imports**
 *      and four exports (`memory` and, in this order, a process function, a
 *      stack-pointer adjuster, an allocator and a deallocator -- their names
 *      carry a build hash, so they are taken by position). It is a black box
 *      that only computes, and it is called exactly as wasm-bindgen would:
 *      `ret = stack(-16); p = alloc(len, 1); write input at p;
 *      process(ret, p, len); (ptr, len) = two i32 at ret; read; dealloc(ptr,
 *      len, 1); stack(16)`. The input is `[op u8][u32 LE n][n bytes]` followed
 *      by length-prefixed fields (`u32 LE length` + bytes):
 *        op 23: [protobuf body][nonce 32]                    -> factor (16 bytes)
 *        op 41: [protobuf body][nonce 32][factor 16]         -> proof (64 ASCII hex)
 *        op 59: [response][live16 || edge16][nonce][factor][tag 8] -> the playlist URL
 *      where the protobuf body is `1:<source> 2:<slug> 3:"<n>" 4:<id>` (strings),
 *      `nonce` is 32 random bytes, `live` is the response header `x-live`
 *      without its `WFTY_EDGE_V3_` prefix (hex), `edge` is `x-edge`, `factor`
 *      the response's `x-client-factor`, and `tag` is `x-body-tag` (base64).
 *      Found by wrapping `WebAssembly.instantiateStreaming` in Playwright with
 *      a substitute instance that logs every call's arguments and memory; the
 *      first byte of an input is checked by the module (a wrong one makes it
 *      return nothing).
 *        POST https://sportsembed.su/api/get
 *          x-client-nonce: base64(nonce)  x-client-factor: base64(factor)
 *          x-client-proof: <proof>        Referer: <the embed url>
 *          body: the protobuf
 *      Any fresh random nonce is accepted. The answer is opaque bytes plus the
 *      three headers above; op 59 turns it into
 *      `https://lbN.wfty.st/secure/<token>/<source>/<slug>/<n>/<id>/<ts>/playlist.m3u8`.
 *   3. The playlist wants `Referer: https://sportsembed.su/`. Its segments are
 *      bare MPEG-TS served as `image/png` from throw-away image hosts
 *      (`upload.glowvideo.ai`, `*.r2.dev`, `*.aliyuncs.com`), 3-6 MB each, so
 *      no decoder is needed. The `delta`/`hotel` feeds are the Streamed
 *      family and are mostly off air (their playlist answers 500); `hd` is
 *      PPV's `embedindia`. Whatever is not on air resolves to `null`.
 *
 * The module is fetched from the site at resolve time (cached for three
 * hours), so a rotation of the module follows. It is run only if it has no
 * imports (it can then compute, nothing else) and its four exports are where
 * they were; a changed op code or layout makes the decrypted text not an
 * address, and the resolver returns `null` -- never throws, never guesses.
 *
 * Handles, not URLs: the playlist's token is minted per request, so each
 * stream's `url` is a handle (`https://watchfooty.invalid/<base64url of the
 * embed url>`) resolved at play time by `resolvers.watchfooty`.
 */
import { randomBytes } from "node:crypto";
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
const SCRAPER_ID = "watchfooty";
function idFor(rawId) {
    return `live:${SCRAPER_ID}:${rawId}`;
}
async function withTimeout(work, ms = 20_000) {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: `fetch()` resolves on
    // headers, and the body read (`.json()`/`.text()`) that follows is
    // still tied to this signal -- clearing the timer here would leave a
    // stalled body able to hang build() forever. Aborting after the body
    // is already read is a no-op; `unref()` keeps the timer from holding
    // the process open.
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
const API = "https://api.watchfooty.st/api/v1";
const EMBED_HOST = "sportsembed.su";
const WASM_URL = "https://assets.sportsembed.su/js/wasm/stream-lock.wasm";
const REFERRER = "https://sportsembed.su/";
const RESOLVER = "watchfooty";
const HANDLE_HOST = "watchfooty.invalid";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_WASM_BYTES = 1_000_000;
const WASM_TTL_MS = 3 * 3600_000;
const MAX_STREAMS = 8;
const CONCURRENCY = 6;
const BUDGET_MS = 150_000;
const SPORT_NAMES = { racing: "motorsport", soccer: "football" };
let lockCache = null;
async function loadLock() {
    try {
        const response = await withTimeout((signal) => fetch(WASM_URL, { signal, headers: { "User-Agent": BROWSER_UA, Referer: REFERRER } }));
        if (!response.ok)
            return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_WASM_BYTES)
            return null;
        const module = await WebAssembly.compile(bytes);
        if (WebAssembly.Module.imports(module).length !== 0)
            return null; // only ever run a module that can compute and nothing else
        const exported = WebAssembly.Module.exports(module);
        const functions = exported.filter((entry) => entry.kind === "function").map((entry) => entry.name);
        const memoryName = exported.find((entry) => entry.kind === "memory")?.name;
        if (functions.length !== 4 || !memoryName)
            return null;
        const { exports } = await WebAssembly.instantiate(module, {});
        const [process, stack, alloc, free] = functions.map((name) => exports[name]);
        if (!process || !stack || !alloc || !free)
            return null;
        return {
            memory: exports[memoryName],
            stack: (delta) => stack(delta),
            alloc: (length, align) => alloc(length, align),
            process: (ret, pointer, length) => void process(ret, pointer, length),
            free: (pointer, length, align) => void free(pointer, length, align)
        };
    }
    catch {
        return null;
    }
}
function getLock() {
    if (!lockCache || Date.now() - lockCache.at > WASM_TTL_MS) {
        const lock = loadLock();
        lockCache = { at: Date.now(), lock };
        void lock.then((value) => { if (!value && lockCache?.lock === lock)
            lockCache = null; });
    }
    return lockCache.lock;
}
/** One call into the module, the way wasm-bindgen makes it. Synchronous, so calls never interleave. */
function run(lock, input) {
    const ret = lock.stack(-16);
    try {
        const pointer = lock.alloc(input.length, 1);
        new Uint8Array(lock.memory.buffer).set(input, pointer);
        lock.process(ret, pointer, input.length);
        const view = new DataView(lock.memory.buffer);
        const outPointer = view.getInt32(ret, true);
        const outLength = view.getInt32(ret + 4, true);
        if (outLength <= 0 || outLength > 65_536)
            return new Uint8Array(0);
        const out = new Uint8Array(lock.memory.buffer).slice(outPointer, outPointer + outLength);
        lock.free(outPointer, outLength, 1);
        return out;
    }
    finally {
        lock.stack(16);
    }
}
function u32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}
function join(...parts) {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
/** `[op][u32 length][first field]` then each further field as `[u32 length][bytes]`. */
function message(op, ...fields) {
    return join(Uint8Array.of(op), ...fields.map((field) => join(u32(field.length), field)));
}
function protobuf(...strings) {
    const encoder = new TextEncoder();
    return join(...strings.map((text, index) => {
        const bytes = encoder.encode(text);
        return join(Uint8Array.of(((index + 1) << 3) | 2, bytes.length), bytes);
    }));
}
const fromHex = (text) => Uint8Array.from(Buffer.from(text, "hex"));
const fromBase64 = (text) => Uint8Array.from(Buffer.from(text, "base64"));
// --- handles ------------------------------------------------------------------
function handleFor(embed) {
    return `https://${HANDLE_HOST}/${Buffer.from(embed).toString("base64url")}`;
}
/** The embed address a handle names, only if it is a sportsembed.su embed page. */
function embedFrom(handle) {
    try {
        const url = new URL(handle);
        if (url.hostname !== HANDLE_HOST)
            return null;
        const embed = Buffer.from(url.pathname.slice(1), "base64url").toString();
        const parsed = new URL(embed);
        const parts = parsed.pathname.split("/");
        if (parsed.protocol !== "https:" || parsed.hostname !== EMBED_HOST || parts.length !== 6 || parts[1] !== "embed")
            return null;
        const [, , id, slug, source, number] = parts;
        return { embed, id, slug, source, number };
    }
    catch {
        return null;
    }
}
// --- resolving ------------------------------------------------------------------
async function playlistFor(handle) {
    const target = embedFrom(handle);
    const lock = await getLock();
    if (!target || !lock)
        return null;
    const body = protobuf(target.source, target.slug, target.number, target.id);
    const nonce = Uint8Array.from(randomBytes(32));
    const factor = run(lock, message(23, body, nonce));
    if (factor.length !== 16)
        return null;
    const proof = run(lock, message(41, body, nonce, factor));
    if (proof.length !== 64)
        return null;
    const response = await withTimeout((signal) => fetch(`https://${EMBED_HOST}/api/get`, {
        method: "POST",
        signal,
        body,
        headers: {
            "User-Agent": BROWSER_UA,
            "Content-Type": "application/octet-stream",
            Origin: `https://${EMBED_HOST}`,
            Referer: target.embed,
            "x-client-nonce": Buffer.from(nonce).toString("base64"),
            "x-client-factor": Buffer.from(factor).toString("base64"),
            "x-client-proof": Buffer.from(proof).toString()
        }
    }));
    if (!response.ok)
        return null;
    const live = response.headers.get("x-live")?.replace(/^WFTY_EDGE_V3_/, "");
    const edge = response.headers.get("x-edge");
    const factorBack = response.headers.get("x-client-factor");
    const tag = response.headers.get("x-body-tag");
    if (!live || !edge || !factorBack || !tag)
        return null;
    const answer = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(run(lock, message(59, answer, join(fromHex(live), fromBase64(edge)), nonce, fromBase64(factorBack), fromBase64(tag))));
    return /^https:\/\/[^\s]+\.m3u8/.test(text) ? text : null;
}
async function get(url, ms = 12_000) {
    return await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, Referer: REFERRER } }), ms);
}
/** On air: the playlist lists a newest segment whose first byte is the MPEG-TS sync byte (not an error page, not a wrapped image). */
async function onAir(master) {
    try {
        const masterResponse = await get(master);
        const masterText = await masterResponse.text();
        if (!masterResponse.ok || !masterText.includes("#EXTM3U"))
            return false;
        const lines = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
        const variant = masterText.includes("#EXT-X-STREAM-INF") ? lines(masterText)[0] : undefined;
        const variantUrl = variant ? new URL(variant, master).href : master;
        const variantText = variant ? await (await get(variantUrl)).text() : masterText;
        const segment = lines(variantText).pop();
        if (!segment)
            return false;
        const response = await get(new URL(segment, variantUrl).href);
        const reader = response.body?.getReader();
        const first = await reader?.read();
        await reader?.cancel().catch(() => undefined);
        return response.ok && !!first?.value && first.value[0] === 0x47;
    }
    catch {
        return false;
    }
}
async function resolveStream(handle) {
    try {
        const url = await playlistFor(handle);
        if (!url || !(await onAir(url)))
            return null;
        return { url, referrer: REFERRER, userAgent: BROWSER_UA };
    }
    catch {
        return null;
    }
}
async function build() {
    return { channels: [] };
}
function logoUrl(path) {
    return path ? new URL(path, "https://api.watchfooty.st/").href : "";
}
async function buildEvents() {
    const response = await withTimeout((signal) => fetch(`${API}/matches/live`, { signal, headers: { "User-Agent": BROWSER_UA } }));
    if (!response.ok)
        throw new Error(`watchfooty: /matches/live -> ${response.status}`);
    const matches = (await response.json());
    // Every feed of every match, checked a few at a time: a feed is kept only if it resolves and its newest segment is video.
    const jobs = [];
    for (const match of matches) {
        if (!match.matchId || !match.title || match.status !== "in")
            continue;
        for (const feed of (match.streams || []).slice(0, MAX_STREAMS)) {
            if (feed.url && feed.url.startsWith(`https://${EMBED_HOST}/embed/`) && embedFrom(handleFor(feed.url)))
                jobs.push({ match, feed });
        }
    }
    const began = Date.now();
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < jobs.length && Date.now() - began < BUDGET_MS) {
            const job = jobs[next++];
            job.ok = !!(await resolveStream(handleFor(job.feed.url)));
        }
    }));
    const channels = [];
    const seen = new Set();
    for (const match of matches) {
        const live = jobs.filter((job) => job.match === match && job.ok);
        const id = idFor(`event:${match.matchId}`);
        if (!live.length || seen.has(id))
            continue;
        seen.add(id);
        const sport = SPORT_NAMES[(match.sport || "").toLowerCase()] || (match.sport || "").toLowerCase().replace(/-/g, " ");
        const home = match.teams?.home, away = match.teams?.away;
        const sides = [home?.name, away?.name].map((side) => (side || "").trim()).filter(Boolean);
        const described = eventFor(match.title.trim(), {
            ...(sides.length === 2 ? { sides } : {}),
            competition: match.league || "",
            sport,
            ...(Number.isFinite(match.timestamp) && (match.timestamp || 0) > 0 ? { start: match.timestamp } : {})
        });
        const logos = [logoUrl(home?.logoUrl), logoUrl(away?.logoUrl)];
        const streams = live.map((job, index) => ({
            url: handleFor(job.feed.url),
            quality: "",
            labels: [[job.feed.source, job.feed.language].filter(Boolean).join(" ") || `Feed ${index + 1}`],
            referrer: REFERRER,
            userAgent: BROWSER_UA,
            resolver: RESOLVER
        }));
        channels.push({
            id,
            name: described.name,
            event: described.event,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", sport],
            languages: [],
            logo: logos[0] || "",
            ...(logos[0] && logos[1] ? { logos } : {}),
            website: "https://watchfooty.st/",
            network: described.event.competition || match.league || "",
            streams
        });
    }
    return {
        channels,
        rails: channels.length ? [{ id: "live-events", heading: "Live Events", channelIds: channels.map((c) => c.id), group: "Live events" }] : []
    };
}
const configSchema = [
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 15,
        min: 5,
        help: "How often the live events are re-read. Each feed is resolved when someone plays it."
    }
];
export const watchfootyScraper = {
    id: SCRAPER_ID,
    name: "WatchFooty",
    version: "1.0.1",
    configSchema,
    resolvers: { [RESOLVER]: resolveStream },
    build,
    buildEvents
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/watchfooty.mts` -- prints the events and resolves the
// first stream of the first one.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    buildEvents()
        .then(async (catalogue) => {
        console.log(`${catalogue.channels.length} events: ${catalogue.channels.map((c) => `${c.name} (${c.streams.length})`).join("; ")}`);
        const first = catalogue.channels[0];
        console.log(first || "(none)");
        if (first?.streams[0])
            console.log(await resolveStream(first.streams[0].url));
    })
        .catch((cause) => {
        console.error("buildEvents() threw:", cause);
        process.exitCode = 1;
    });
}
