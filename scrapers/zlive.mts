/**
 * zlive.st -- a ~200-channel 24/7 live-TV aggregator.
 *
 * The catalogue itself is a single plain, unauthenticated JSON document:
 * `GET https://iptv.zlive.st/channels.json` returns every channel with an
 * `id`, display fields (`name`, `region`, `flag`, `sport`, `quality`) and a
 * `sources: [{ key, label }]` array -- `key` is an opaque per-channel
 * identifier, never a playable URL by itself.
 *
 * Turning a `key` into a real stream URL needs a second call,
 * `POST https://iptv.zlive.st/resolve`, and THAT call is gated behind a
 * real (not merely obfuscated) crypto scheme -- confirmed by running the
 * site's own minified bundle in a Node `vm` sandbox with browser globals
 * stubbed (`crypto.webcrypto`, `TextEncoder`, a `fetch` stub that throws so
 * the exact request could be read out of the exception) and, separately,
 * instrumenting `crypto.subtle.digest`/`encrypt` to log their real
 * arguments -- the same "run it, don't hand-decode it" approach
 * AGENTS.md's WASM section describes, applied to obfuscated JS instead:
 *
 *   1. `key = SHA-256("<local YYYY-MM-DD>|<fixed salt>v3")`, where the salt
 *      is the constant `ZLIVE_SALT` below (an XOR-obfuscated byte array in
 *      the bundle, decoded once and inlined here -- it is not a secret
 *      derived from anything request-specific, just a fixed string glued
 *      into the digest input).
 *   2. That digest is imported directly as a raw 256-bit AES-GCM key (no
 *      HKDF, no PBKDF2 -- the digest bytes themselves are the key).
 *   3. A random 12-byte IV encrypts `JSON.stringify({ c: <source key>,
 *      t: <unix seconds> })`; AES-GCM's trailing 16-byte tag is split off
 *      the ciphertext and both are base64'd separately.
 *   4. The request body is `{ p: <ciphertext b64>, n: <iv b64>,
 *      g: <tag b64>, k: "<the same YYYY-MM-DD used for the key> }`.
 *
 * PROTOCOL v4 (Oct 2026), detected at runtime -- see `detectProtocol`: the
 * site stopped accepting the v3 handshake above WITHOUT refusing it.
 * `/resolve` still answered 200 with a well-formed `location`, which led to
 * a 60-second looping "scrapers go away" card served as a VOD playlist, for
 * every channel. v4 is the same envelope with `GET /nonce` first:
 * `key = SHA-256("<nonce>|<date>|<new salt>|v4")` and the nonce echoed back
 * as `x` in the body. Read off the live site by hooking `fetch` and
 * `crypto.subtle` in a browser while it opened a channel. Both protocols are
 * kept: whichever one gets a LIVE playlist (no `#EXT-X-ENDLIST`) for a few
 * probe channels from different upstreams wins, newest first on a tie.
 *
 * NOTHING IS RESOLVED AT SCRAPE TIME any more. The address `/resolve` hands
 * back is signed and good for two and a half hours, so resolved once per
 * rebuild it was stale most of the day. Each stream's `url` is a HANDLE
 * (`https://zlive.invalid/<key>`) and the host calls `resolvers.zlive` with
 * it whenever it checks or plays the channel. See `ScrapedStream.resolver`.
 *
 * `resolve()` answers `{ location: <url> }` -- sometimes a direct CDN
 * `.m3u8` (`epidd.hundxvision.co.uk/main/secure/<hash>/<ts>/<slug>.m3u8`),
 * sometimes a same-shape proxy (`route.transcode.cfd/m3u8-proxy.m3u8?
 * data=<opaque>`) whose own child playlists/segments are further
 * `route.transcode.cfd` URLs of the same kind. Both were confirmed to
 * fetch and play (real `#EXTM3U`/`#EXTINF` content, not a decoy) -- this is
 * a URL-obfuscation proxy, not the segment-level steganography ntv.st's
 * `dlhd` backend uses (see that scraper's docstring); a plain HLS client
 * follows it with no special handling. Every URL from either shape needs
 * `Referer: https://zlive.st/` and a browser-like `User-Agent` -- a bare
 * request without both 403s/404s.
 *
 * The site also exposes a `POST /streams` endpoint using the exact same
 * crypto envelope (body `{ t: <unix seconds> }` only, no channel key) --
 * zlive's live-SPORTING-EVENTS feed, a separate catalogue from the 24/7
 * channels above, merged into the shared "Live Events" rail (see
 * `buildEventsRail` below; matches ntvst.mts's own rail of the same name).
 * Confirmed genuine (not zlive's catch-all decoy -- any unrecognised GET
 * path 302s to a fixed dummy `.m3u8`, `POST /streams` instead answers
 * `200 []` with real CORS headers scoped to `https://zlive.st`) but every
 * request made against it during development returned an empty array --
 * apparently no sporting event was live at the time -- so each entry's own
 * field names are inferred from the channel feed's conventions (the only
 * ground truth available on this site) rather than confirmed against a
 * real populated response. `parseEvent` below reads every plausible alias
 * for each field so a shape that turns out slightly different still
 * degrades to a blander card instead of dropping the event, and `sources`
 * is resolved through the exact same `/resolve` call channels use, since
 * both hang off the same backend and neither the docstring nor the bundle
 * gave any sign events resolve differently.
 *
 * A `key` that already looks like `http(s)://...` is used as-is (the
 * site's own code checks this before ever calling `/resolve` -- some
 * sources may be configured as direct links with no resolve step).
 */

import { gunzipSync, inflateSync } from "node:zlib";

// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------

interface ScrapedStream {
    url: string;
    quality: string;
    labels: string[];
    referrer: string;
    userAgent: string;
    resolver?: string;
    decoder?: string;
}

interface ResolvedStream {
    url: string;
    referrer?: string;
    userAgent?: string;
}

type StreamResolver = (handle: string) => Promise<ResolvedStream | null>;

/** Who is in a live event and when, so the host can merge it with the same fixture from other sources. */
interface ScrapedEvent {
    sides?: string[];
    /** What the host merges on -- see `eventFor`. */
    key?: string;
    /** Further keys the same event goes by. */
    keys?: string[];
    title?: string;
    competition?: string;
    sport?: string;
    /** Epoch milliseconds; omitted when unknown. */
    start?: number;
}

// BEGIN event-key -- identical in every scraper that lists live events. scripts/sync-blocks.mjs keeps the copies in step.

/** Flags (regional indicators), tag characters, variation selectors, joiners. */
const EVENT_DECORATION = /[\u{1F1E6}-\u{1F1FF}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{1F3F4}]/gu;

/** Words some lists put on a club's name and others leave off. */
const EVENT_GENERIC = new Set(["fc", "cf", "afc", "sc", "fk", "sk", "cd", "ud", "club", "the", "de", "calcio"]);

/** Whole-name spellings that are one team. Keys are already folded. */
const EVENT_ALIASES: Record<string, string> = {
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
function teamKey(name: string): string {
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
function readFixture(raw: string): { sides: string[]; competition: string } | null {
    const versus = /\s+(?:vs\.?|v\.?|versus|@)\s+/i;
    let name = raw.replace(EVENT_DECORATION, "").replace(/\s+/g, " ").trim();
    const first = name.search(versus);
    if (first < 0) return null;

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
    if (sides.length < 2 || sides.length > 8) return null;
    if (sides.some((side) => side.length < 2 || side.length > 60 || /^(?:simulcast|tba|tbd|tbc|live|hd|fhd|uhd|sd|4k|tv|\d+)$/i.test(side))) return null;

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
function teamNames(name: string): string[] {
    const full = teamKey(name);
    const tokens = full.split(" ").filter(Boolean);

    if (tokens.some((token) => EVENT_MARKER.test(token))) return [full];

    const names = [full];
    let head = tokens;

    /* Drop trailing words one at a time, but never a word like "United" or "State": that is part of the name. */
    while (head.length > 1 && !EVENT_COMMON.has(head[head.length - 1] || "")) {
        head = head.slice(0, -1);

        if (head.length === 1 && ((head[0] || "").length < 4 || EVENT_COMMON.has(head[0] || ""))) break;
        names.push(head.join(" "));
    }

    return names;
}

/** Every combination of the sides' names, as sorted keys: the exact one first, at most 16. */
function eventKeys(sides: string[]): string[] {
    let keys: string[][] = [[]];

    for (const side of sides) {
        const names = teamNames(side);

        keys = keys.flatMap((held) => names.map((name) => [...held, name]));
        if (keys.length > 64) keys = keys.slice(0, 64);
    }

    return [...new Set(keys.map((parts) => `v:${[...parts].sort().join("|")}`))].slice(0, 16);
}


/**
 * A source that names an American side by its nickname alone ("Chiefs @ Raiders")
 * and one that writes the whole name ("Las Vegas Raiders") are one fixture.
 * Nicknames repeat across leagues (Giants, Panthers, Cardinals, Rangers, Kings,
 * Jets), so a nickname is only expanded when the source states the sport.
 */
const US_NICKNAMES: Record<string, Record<string, string>> = {};
for (const [sport, list] of Object.entries({
    "american football": "Cardinals=Arizona Cardinals;Falcons=Atlanta Falcons;Ravens=Baltimore Ravens;Bills=Buffalo Bills;Panthers=Carolina Panthers;Bears=Chicago Bears;Bengals=Cincinnati Bengals;Browns=Cleveland Browns;Cowboys=Dallas Cowboys;Broncos=Denver Broncos;Lions=Detroit Lions;Packers=Green Bay Packers;Texans=Houston Texans;Colts=Indianapolis Colts;Jaguars=Jacksonville Jaguars;Chiefs=Kansas City Chiefs;Raiders=Las Vegas Raiders;Chargers=Los Angeles Chargers;Rams=Los Angeles Rams;Dolphins=Miami Dolphins;Vikings=Minnesota Vikings;Patriots=New England Patriots;Saints=New Orleans Saints;Giants=New York Giants;Jets=New York Jets;Eagles=Philadelphia Eagles;Steelers=Pittsburgh Steelers;49ers=San Francisco 49ers;Seahawks=Seattle Seahawks;Buccaneers=Tampa Bay Buccaneers;Titans=Tennessee Titans;Commanders=Washington Commanders",
    "baseball": "Diamondbacks=Arizona Diamondbacks;Braves=Atlanta Braves;Orioles=Baltimore Orioles;Red Sox=Boston Red Sox;Cubs=Chicago Cubs;White Sox=Chicago White Sox;Reds=Cincinnati Reds;Guardians=Cleveland Guardians;Rockies=Colorado Rockies;Tigers=Detroit Tigers;Astros=Houston Astros;Royals=Kansas City Royals;Angels=Los Angeles Angels;Dodgers=Los Angeles Dodgers;Marlins=Miami Marlins;Brewers=Milwaukee Brewers;Twins=Minnesota Twins;Mets=New York Mets;Yankees=New York Yankees;Phillies=Philadelphia Phillies;Pirates=Pittsburgh Pirates;Padres=San Diego Padres;Giants=San Francisco Giants;Mariners=Seattle Mariners;Cardinals=St. Louis Cardinals;Rays=Tampa Bay Rays;Rangers=Texas Rangers;Blue Jays=Toronto Blue Jays;Nationals=Washington Nationals",
    "hockey": "Ducks=Anaheim Ducks;Bruins=Boston Bruins;Sabres=Buffalo Sabres;Flames=Calgary Flames;Hurricanes=Carolina Hurricanes;Blackhawks=Chicago Blackhawks;Avalanche=Colorado Avalanche;Blue Jackets=Columbus Blue Jackets;Stars=Dallas Stars;Red Wings=Detroit Red Wings;Oilers=Edmonton Oilers;Panthers=Florida Panthers;Kings=Los Angeles Kings;Wild=Minnesota Wild;Canadiens=Montreal Canadiens;Predators=Nashville Predators;Devils=New Jersey Devils;Islanders=New York Islanders;Rangers=New York Rangers;Senators=Ottawa Senators;Flyers=Philadelphia Flyers;Penguins=Pittsburgh Penguins;Sharks=San Jose Sharks;Kraken=Seattle Kraken;Blues=St. Louis Blues;Lightning=Tampa Bay Lightning;Maple Leafs=Toronto Maple Leafs;Canucks=Vancouver Canucks;Golden Knights=Vegas Golden Knights;Capitals=Washington Capitals;Jets=Winnipeg Jets;Mammoth=Utah Mammoth",
    "basketball": "Hawks=Atlanta Hawks;Celtics=Boston Celtics;Nets=Brooklyn Nets;Hornets=Charlotte Hornets;Bulls=Chicago Bulls;Cavaliers=Cleveland Cavaliers;Mavericks=Dallas Mavericks;Nuggets=Denver Nuggets;Pistons=Detroit Pistons;Warriors=Golden State Warriors;Rockets=Houston Rockets;Pacers=Indiana Pacers;Clippers=Los Angeles Clippers;Lakers=Los Angeles Lakers;Grizzlies=Memphis Grizzlies;Heat=Miami Heat;Bucks=Milwaukee Bucks;Timberwolves=Minnesota Timberwolves;Pelicans=New Orleans Pelicans;Knicks=New York Knicks;Thunder=Oklahoma City Thunder;Magic=Orlando Magic;76ers=Philadelphia 76ers;Suns=Phoenix Suns;Trail Blazers=Portland Trail Blazers;Kings=Sacramento Kings;Spurs=San Antonio Spurs;Raptors=Toronto Raptors;Jazz=Utah Jazz;Wizards=Washington Wizards"
})) {
    US_NICKNAMES[sport] = Object.fromEntries(list.split(";").map((pair) => pair.split("=") as [string, string]).map(([nick, full]) => [nick.toLowerCase(), full]));
}

/** The whole name for a nickname the source gave alone, when its sport says which league; else the name unchanged. */
function fullTeamName(name: string, sport: string | undefined): string {
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
function eventFor(
    title: string,
    extra: { sides?: string[]; sport?: string; competition?: string; start?: number } = {}
): { name: string; event: ScrapedEvent } {
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

// END event-key

interface ScrapedChannel {
    id: string;
    name: string;
    country: string;
    countryName: string;
    countryFlag: string;
    categories: string[];
    languages: string[];
    logo: string;
    event?: ScrapedEvent;
    website: string;
    network: string;
    streams: ScrapedStream[];
}

interface ScrapedRail {
    id: string;
    heading: string;
    channelIds: string[];
    by?: string;
    group?: string;
    filter?: { countries?: string[]; categories?: string[]; genres?: string[]; languages?: string[]; sources?: string[]; networks?: string[]; market?: "home-first" | "first" };
}

interface ScrapedCatalogue {
    channels: ScrapedChannel[];
    rails?: ScrapedRail[];
}

type ScraperConfigValue = string | number | boolean;

interface ScraperConfigField {
    key: string;
    label: string;
    type: "number" | "string" | "boolean";
    default: ScraperConfigValue;
    min?: number;
    max?: number;
    help?: string;
}

interface ScraperTaskContext {
    config: Record<string, ScraperConfigValue>;
    runTask(id: string): Promise<void>;
}

interface ScraperTask {
    id: string;
    label: string;
    dependsOn?: string[];
    intervalConfigKey?: string;
    run(ctx: ScraperTaskContext): Promise<void>;
}

interface Scraper {
    id: string;
    name: string;
    version?: string;
    configSchema?: ScraperConfigField[];
    tasks?: ScraperTask[];
    resolvers?: Record<string, StreamResolver>;
    decoders?: Record<string, (segment: Uint8Array, url: string) => Uint8Array | Promise<Uint8Array>>;
    build(): Promise<ScrapedCatalogue>;
    buildEvents?(): Promise<ScrapedCatalogue>;
}

const SCRAPER_ID = "zlive";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: `fetch` resolves on
    // headers, and the caller's body read (`.text()`/`.json()`) still needs
    // this signal armed, or a server that stalls mid-body hangs forever.
    // `unref` keeps the pending timer from holding the process open.
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();
    try {
        return await work(controller.signal);
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}

const BASE = "https://iptv.zlive.st";
const REFERRER = "https://zlive.st/";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** XOR-decoded once from the bundle's obfuscated `Ry`/`Py` byte arrays
 *  (`Ny(Ry, Py)` in the site's own minified code) -- see the module
 *  docstring for how this was recovered. Fixed, not request-specific.
 *  LEGACY (protocol "v3"): the site stopped accepting this around Oct 2026. */
const ZLIVE_SALT_V3 = "J7dRYVTWoySiukvBBY5hXvMvBdBZ_b08wBYlz_BrSXg";

/** The literal suffix the v3 `Rg()` appends after the salt before hashing. */
const ZLIVE_KEY_VERSION_V3 = "v3";

/** Protocol "v4", read off the live site by hooking `fetch` and
 *  `crypto.subtle` in a real browser while it opened a channel: the key is
 *  `SHA-256("<nonce>|<date>|<salt>|v4")`, `<nonce>` coming from
 *  `GET /nonce` and sent back in the body as `x`. */
const ZLIVE_SALT_V4 = "3Uk3tEhWN38sNt_F6lykbYiFdpaVRInfjaaZuTY__gQ";

interface ZliveChannel {
    id: string;
    name: string;
    tagline?: string;
    region?: string;
    flag?: string;
    quality?: string;
    live?: boolean;
    sport?: string;
    sources: Array<{ key: string; label?: string }>;
}

/** Reproduces zlive.st's own `Oy(new Date)` -- a LOCAL calendar date,
 *  `YYYY-MM-DD`. The server accepts requests keyed to "today" at day
 *  granularity; using UTC here (rather than the scraper host's local zone,
 *  which a browser would use instead) keeps this correct regardless of
 *  what timezone the container happens to run in, at the cost of a
 *  possible single failed request right at UTC midnight if zlive's own
 *  server clock disagrees -- an acceptable trade for a scraper with no
 *  fixed locale of its own. */
function todayKeyDate(): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

type Envelope = { p: string; n: string; g: string; k: string; x?: string };
type ProtocolId = "v4" | "v3";

/** AES-GCM-encrypts `payload` under the key `SHA-256(digestInput)` and
 *  returns the body fields both protocols share. */
async function seal(digestInput: string, dateKey: string, payload: unknown): Promise<Envelope> {
    const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(digestInput));
    const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));

    const tagStart = encrypted.length - 16;
    return {
        p: Buffer.from(encrypted.slice(0, tagStart)).toString("base64"),
        n: Buffer.from(iv).toString("base64"),
        g: Buffer.from(encrypted.slice(tagStart)).toString("base64"),
        k: dateKey
    };
}

/** LEGACY envelope: date + fixed salt, no nonce. */
async function envelopeV3(payload: unknown, _signal: AbortSignal): Promise<Envelope> {
    const dateKey = todayKeyDate();
    return seal(`${dateKey}|${ZLIVE_SALT_V3}${ZLIVE_KEY_VERSION_V3}`, dateKey, payload);
}

/** CURRENT envelope: a one-off nonce from the server is part of the key and
 *  is echoed back as `x`. */
async function envelopeV4(payload: unknown, signal: AbortSignal): Promise<Envelope> {
    const response = await fetch(`${BASE}/nonce`, { signal, headers: { "User-Agent": USER_AGENT, Referer: REFERRER } });
    if (!response.ok) throw new Error(`/nonce -> ${response.status}`);

    const nonce = ((await response.json()) as { n?: string }).n;
    if (!nonce) throw new Error("/nonce answered without a nonce");

    const dateKey = todayKeyDate();
    return { ...(await seal(`${nonce}|${dateKey}|${ZLIVE_SALT_V4}|v4`, dateKey, payload)), x: nonce };
}

const PROTOCOLS: Record<ProtocolId, (payload: unknown, signal: AbortSignal) => Promise<Envelope>> = {
    v4: envelopeV4,
    v3: envelopeV3
};

/** Newest first: when two both look fine, the newer one wins. */
const PROTOCOL_ORDER: ProtocolId[] = ["v4", "v3"];

/** The protocol the last detection settled on (only used to log a change). */
let activeProtocol: ProtocolId = "v4";

async function fetchChannelList(signal: AbortSignal): Promise<ZliveChannel[]> {
    const response = await fetch(`${BASE}/channels.json`, {
        signal,
        headers: { "User-Agent": USER_AGENT, Referer: REFERRER }
    });
    if (!response.ok) throw new Error(`channels.json -> ${response.status}`);
    return (await response.json()) as ZliveChannel[];
}

/** One `/resolve` round trip under an explicit protocol; throws on failure. */
async function resolveWith(protocol: ProtocolId, key: string, signal: AbortSignal): Promise<string | null> {
    const envelope = await PROTOCOLS[protocol]({ c: key, t: Math.floor(Date.now() / 1000) }, signal);
    const response = await fetch(`${BASE}/resolve`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, Referer: REFERRER },
        body: JSON.stringify(envelope)
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { location?: string };
    return body.location || null;
}

// --- which protocol does the site speak today? ------------------------------

/**
 * WHY THIS IS DETECTED AND NOT ASSUMED.
 *
 * zlive changed its handshake without notice (v3 -> v4, Oct 2026) and the
 * old one was NOT refused: `/resolve` still answered 200 with a perfectly
 * well-formed `location`, which led to a 60-second looping clip of a
 * "scrapers go away" card, served as a VOD playlist. Every layer above
 * this one -- the playlist check, the nightly deep check that follows a
 * source to real bytes -- calls that a working channel, because it is one.
 * Nothing errors. So the answer to "did my envelope work" has to come from
 * looking at what the location serves.
 *
 * A live channel never has `#EXT-X-ENDLIST`. The decoy is a short VOD with
 * one, which is the whole test.
 */
type Served = "live" | "decoy" | "dead";

async function classify(location: string, signal: AbortSignal, depth = 0): Promise<Served> {
    try {
        const response = await fetch(location, { signal, headers: { "User-Agent": USER_AGENT, Referer: REFERRER } });
        if (!response.ok) return "dead";

        const text = await response.text();
        if (!text.trimStart().startsWith("#EXTM3U")) return "dead";

        /* A master playlist says nothing itself: the decoy may sit behind its first rendition. */
        if (depth < 2 && /#EXT-X-STREAM-INF/.test(text)) {
            const variant = text
                .split("\n")
                .map((line) => line.trim())
                .find((line) => line && !line.startsWith("#"));

            if (variant) return classify(new URL(variant, location).toString(), signal, depth + 1);
        }

        if (/#EXT-X-ENDLIST/.test(text)) {
            const seconds = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, hit) => sum + Number(hit[1]), 0);
            if (seconds <= 300) return "decoy";
        }

        return "live";
    } catch {
        return "dead";
    }
}

/** Picks the protocol the site currently honours. Probes a few channels
 *  from DIFFERENT upstream sources (a whole upstream can be down, and that
 *  must not read as a wrong protocol). `live` outranks `dead`, and `dead`
 *  outranks `decoy`/failure: a 404 means the envelope was accepted. */
async function detectProtocol(channels: ZliveChannel[]): Promise<ProtocolId> {
    const bySource = new Map<string, string>();
    for (const entry of channels) {
        const source = entry.sources[0];
        if (source && !/^https?:\/\//i.test(source.key) && !bySource.has(source.label || "?")) bySource.set(source.label || "?", source.key);
    }

    const keys = [...bySource.values()].slice(0, 4);
    const score: Record<ProtocolId, number> = { v4: 0, v3: 0 };

    for (const protocol of PROTOCOL_ORDER) {
        for (const key of keys) {
            const served = await withTimeout(async (signal) => {
                const location = await resolveWith(protocol, key, signal);
                return location ? classify(location, signal) : ("dead" as Served);
            }, 20_000).catch(() => "decoy" as Served);

            // A resolve that failed outright is scored with the decoy: no evidence for.
            if (served === "live") score[protocol] += 2;
            else if (served === "dead") score[protocol] += 1;
        }
    }

    const best = PROTOCOL_ORDER.reduce((a, b) => (score[b] > score[a] ? b : a));
    if (score[best] === 0) {
        throw new Error("neither crypto protocol gets past the anti-scraper decoy (the site changed again?)");
    }

    if (best !== activeProtocol) console.log(`zlive: crypto protocol is now ${best} (was ${activeProtocol})`);
    return best;
}

/**
 * The protocol in force, detected lazily and remembered briefly. Ten minutes
 * when it worked (long enough that a nightly sweep resolving two hundred
 * channels probes once, short enough that a change of handshake is noticed
 * the same hour), one minute when it did not (so a site that is down is not
 * probed once per request).
 *
 * `force` is for a resolve that failed under the remembered answer -- the
 * handshake may just have changed -- and is honoured at most once a minute,
 * or one dead channel would re-probe the site every time it was pressed.
 */
const PROTOCOL_GOOD_MS = 10 * 60_000;
const PROTOCOL_BAD_MS = 60_000;

let detected: { at: number; protocol: ProtocolId | null } | null = null;
let detecting: Promise<ProtocolId | null> | null = null;

async function protocolNow(force = false): Promise<ProtocolId | null> {
    if (detected) {
        const age = Date.now() - detected.at;
        const limit = force ? PROTOCOL_BAD_MS : detected.protocol ? PROTOCOL_GOOD_MS : PROTOCOL_BAD_MS;
        if (age < limit) return detected.protocol;
    }

    if (!detecting) {
        detecting = (async () => {
            try {
                const list = await withTimeout((signal) => fetchChannelList(signal));
                const protocol = await detectProtocol(list);
                activeProtocol = protocol;
                detected = { at: Date.now(), protocol };
                return protocol;
            } catch (cause) {
                console.error(`zlive: ${cause instanceof Error ? cause.message : cause}`);
                detected = { at: Date.now(), protocol: null };
                return null;
            } finally {
                detecting = null;
            }
        })();
    }

    return detecting;
}

// --- handles, and the resolver the host calls with them ---------------------

/** A stream's `url` here is a HANDLE, never fetched: the host stores its
 *  evidence under it and calls `resolveHandle` for every check and play.
 *  `.invalid` can never resolve, so a handle that escaped fails cleanly. */
function handleFor(key: string): string {
    return `https://zlive.invalid/${encodeURIComponent(key)}`;
}

function keyOfHandle(handle: string): string | null {
    try {
        const url = new URL(handle);
        return url.hostname === "zlive.invalid" ? decodeURIComponent(url.pathname.slice(1)) : null;
    } catch {
        return null;
    }
}

/** What the host asks for at the moment a channel is checked or played:
 *  a signed address that is good for about two and a half hours from NOW. */
async function resolveHandle(handle: string): Promise<ResolvedStream | null> {
    const key = keyOfHandle(handle);
    if (!key) return null;

    const stream = (url: string): ResolvedStream => ({ url, referrer: REFERRER, userAgent: USER_AGENT });
    /** What this address serves, looked at every time: the site answers a handshake it no longer honours with a well-formed address to a looping clip. */
    const serves = (url: string): Promise<Served> => withTimeout((signal) => classify(url, signal), 8_000).catch(() => "dead" as Served);

    let tried: ProtocolId | null = null;

    for (const force of [false, true]) {
        const protocol = await protocolNow(force);
        if (!protocol) return null;

        tried = protocol;

        const url = await withTimeout((signal) => resolveWith(protocol, key, signal), 10_000).catch(() => null);
        if (!url) continue;

        /* "dead" is a channel that is down (or geo-fenced), not a wrong handshake: hand it over and let the host's checks say so. */
        if ((await serves(url)) !== "decoy") return stream(url);

        /* A decoy means the handshake changed under the remembered answer: forget it so the next look re-detects. */
        detected = null;
    }

    /* Both looks got the clip. Try the OTHER handshake outright -- detection samples a few channels and may have been wrong for this one. */
    for (const other of PROTOCOL_ORDER) {
        if (other === tried) continue;

        const url = await withTimeout((signal) => resolveWith(other, key, signal), 10_000).catch(() => null);

        if (url && (await serves(url)) === "live") {
            detected = { at: Date.now(), protocol: other };
            activeProtocol = other;
            console.log(`zlive: ${other} gets a live playlist for ${key} where ${tried} got the decoy`);

            return stream(url);
        }
    }

    /* Nothing the site gave was a channel: a dead mirror, which the host moves past. Never the clip. */
    console.error(`zlive: only the anti-scraper decoy came back for ${key}`);

    return null;
}

/** zlive's own `flag` field is already a lowercase ISO 3166-1 alpha-2 code
 *  (`"gb"`, `"us"`, ...) or `""` -- converting it to the flag emoji is just
 *  offsetting each letter into the Unicode regional-indicator block. */
function flagEmoji(countryCode: string): string {
    if (!/^[a-z]{2}$/i.test(countryCode)) return "";
    const codePoints = [...countryCode.toUpperCase()].map((letter) => 0x1f1e6 + (letter.charCodeAt(0) - 65));
    return String.fromCodePoint(...codePoints);
}

function categoriesFor(sport: string | undefined): string[] {
    if (!sport) return [];
    return [sport.toLowerCase()];
}

async function fetchChannels(): Promise<ScrapedChannel[]> {
    const rawChannels = await withTimeout((signal) => fetchChannelList(signal));
    await protocolNow();

    const resolved = rawChannels.map((entry) => {
        const source = entry.sources[0];
        if (!source) return null;

        const direct = /^https?:\/\//i.test(source.key);

        const country = (entry.flag || "").toUpperCase();
        const channel: ScrapedChannel = {
            id: idFor(entry.id),
            name: entry.name,
            country,
            countryName: entry.region || country,
            countryFlag: flagEmoji(entry.flag || ""),
            categories: categoriesFor(entry.sport),
            languages: [],
            logo: "",
            website: "",
            network: "",
            streams: [
                {
                    url: direct ? source.key : handleFor(source.key),
                    quality: entry.quality || "",
                    labels: entry.tagline ? [entry.tagline] : [],
                    referrer: REFERRER,
                    userAgent: USER_AGENT,
                    decoder: DECODER,
                    ...(direct ? {} : { resolver: "zlive" })
                }
            ]
        };
        return channel;
    });

    return resolved.filter((channel): channel is ScrapedChannel => channel !== null);
}

// --- live events rail -------------------------------------------------------

/** Every plausible field name for one `/streams` entry -- see the module
 *  docstring for why this is inferred rather than confirmed. Nothing here
 *  is required; `parseEvent` falls back sensibly on every field. */
interface ZliveEvent {
    id?: string | number;
    key?: string;
    slug?: string;
    title?: string;
    name?: string;
    match?: string;
    home?: string;
    away?: string;
    homeTeam?: string;
    awayTeam?: string;
    teams?: { home?: string | { name?: string }; away?: string | { name?: string } };
    category?: string;
    sport?: string;
    league?: string;
    quality?: string;
    tagline?: string;
    sources?: Array<{ key: string; label?: string }>;
}

function teamName(side: string | { name?: string } | undefined): string {
    if (!side) return "";
    return typeof side === "string" ? side : side.name || "";
}

function eventSides(entry: ZliveEvent): string[] {
    const home = entry.home || entry.homeTeam || teamName(entry.teams?.home);
    const away = entry.away || entry.awayTeam || teamName(entry.teams?.away);
    return home && away ? [home, away] : [];
}

function eventTitle(entry: ZliveEvent): string {
    if (entry.title || entry.name || entry.match) return entry.title || entry.name || entry.match || "";

    const home = entry.home || entry.homeTeam || teamName(entry.teams?.home);
    const away = entry.away || entry.awayTeam || teamName(entry.teams?.away);
    if (home && away) return `${home} vs ${away}`;

    return "Live event";
}

async function fetchLiveEvents(signal: AbortSignal): Promise<ZliveEvent[]> {
    const protocol = await protocolNow();
    if (!protocol) return [];

    const envelope = await PROTOCOLS[protocol]({ t: Math.floor(Date.now() / 1000) }, signal);
    const response = await fetch(`${BASE}/streams`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, Referer: REFERRER },
        body: JSON.stringify(envelope)
    });
    if (!response.ok) throw new Error(`/streams -> ${response.status}`);
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as ZliveEvent[]) : [];
}

async function buildEventsRail(): Promise<{ channels: ScrapedChannel[]; rails: ScrapedRail[] }> {
    const events = await withTimeout((signal) => fetchLiveEvents(signal));
    if (!events.length) return { channels: [], rails: [] };

    const resolved = events.map((entry) => {
        const source = entry.sources?.[0];
        if (!source) return null;

        const direct = /^https?:\/\//i.test(source.key);

        const category = entry.category || entry.sport || entry.league || "uncategorized";
        const rawId = entry.id ?? entry.key ?? entry.slug ?? eventTitle(entry);
        const described = eventFor(eventTitle(entry), { ...(eventSides(entry).length ? { sides: eventSides(entry) } : {}), sport: category === "uncategorized" ? "" : category.toLowerCase(), competition: entry.league || "" });
        const channel: ScrapedChannel = {
            id: idFor(`event:${rawId}`),
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
            streams: [
                {
                    url: direct ? source.key : handleFor(source.key),
                    quality: entry.quality || "",
                    labels: entry.tagline ? [entry.tagline] : ["Live event"],
                    referrer: REFERRER,
                    userAgent: USER_AGENT,
                    decoder: DECODER,
                    ...(direct ? {} : { resolver: "zlive" })
                }
            ]
        };
        return channel;
    });

    const channels = resolved.filter((channel): channel is ScrapedChannel => channel !== null);
    if (!channels.length) return { channels: [], rails: [] };

    // Same rail name ntvst.mts uses -- the host merges any two scrapers'
    // rails whose headings match, so this lands in the same "Live Events"
    // rail rather than a separate one.
    return { channels, rails: [{ id: "live-events", heading: "Live Events", channelIds: channels.map((c) => c.id), group: "Live events" }] };
}

const configSchema: ScraperConfigField[] = [
    {
        key: "channelsIntervalMinutes",
        label: "Channel list refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 30,
        help: "How often the 24/7 channel list is re-read."
    },
    {
        key: "eventsIntervalMinutes",
        label: "Live events refresh interval (minutes)",
        type: "number",
        default: 15,
        min: 5,
        help: "How often the list of live events is re-read."
    }
];

/** The channel list: its own job, run on `channelsIntervalMinutes`. */
// BEGIN logo-directory -- identical in every scraper that fills in missing logos. scripts/sync-blocks.mjs keeps the copies in step.

/*
    A SOURCE THAT HAS NO LOGO FOR A CHANNEL BORROWS ONE FROM IPTV-ORG'S
    DIRECTORY, by name. The directory is iptv-org's public `channels.json`
    (name, alternate names, country) joined to `logos.json`; it is held for the
    life of the process and fetched once. Two rules, both about not putting the
    wrong logo on a channel:
      1. the same folded name (or alternate name) in the SAME country;
      2. failing that, a name of five characters or more that every
         directory channel of that name gives ONE logo for, in any country.
    Nothing is borrowed for a name the directory does not know, and a logo the
    source already supplied is kept unless `dead` says its host is gone.
*/
interface LogoDirectory {
    byCountry: Map<string, string>;
    byName: Map<string, Set<string>>;
}

const LOGO_API = "https://iptv-org.github.io/api";
let logoDirectory: Promise<LogoDirectory | null> | null = null;

function foldLogoName(name: string): string {
    return name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/^\s*(?:\[[^\]]{1,6}\]\s*)+/, "")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/\b(hd\+?|fhd|uhd|sd|4k|hevc|raw|backup|feed|\d{3,4}p)\b/g, "")
        .replace(/[^a-z0-9]+/g, "");
}

async function loadLogoDirectory(): Promise<LogoDirectory | null> {
    try {
        const get = async (file: string): Promise<unknown[]> => {
            const response = await fetch(`${LOGO_API}/${file}.json`, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(`${file}.json -> ${response.status}`);
            return (await response.json()) as unknown[];
        };
        const [channels, logos] = (await Promise.all([get("channels"), get("logos")])) as [
            Array<{ id?: string; name?: string; alt_names?: string[]; country?: string }>,
            Array<{ channel?: string; url?: string; width?: number; format?: string }>
        ];
        /* The biggest raster logo per channel; a vector only when there is nothing else (a panel cannot sniff SVG). */
        const best = new Map<string, { url: string; width: number; vector: boolean }>();

        for (const logo of logos) {
            if (!logo.channel || !logo.url) continue;
            const candidate = { url: logo.url, width: logo.width || 0, vector: /svg/i.test(logo.format || "") };
            const held = best.get(logo.channel);
            if (!held || (held.vector && !candidate.vector) || (held.vector === candidate.vector && candidate.width > held.width)) best.set(logo.channel, candidate);
        }

        const directory: LogoDirectory = { byCountry: new Map(), byName: new Map() };

        for (const channel of channels) {
            const logo = channel.id ? best.get(channel.id) : undefined;
            if (!logo) continue;

            for (const name of [channel.name || "", ...(channel.alt_names || [])]) {
                const folded = foldLogoName(name);
                if (folded.length < 3) continue;
                directory.byCountry.set(`${folded}|${(channel.country || "").toUpperCase()}`, logo.url);
                (directory.byName.get(folded) || directory.byName.set(folded, new Set()).get(folded)!).add(logo.url);
            }
        }

        return directory;
    } catch (cause) {
        console.error("logo directory unavailable:", cause);
        logoDirectory = null;
        return null;
    }
}

/** Fills `logo` on channels that have none (or whose own is `dead`). Never throws; returns how many it filled. */
async function fillLogos(channels: Array<{ name: string; country: string; logo: string }>, dead?: (logo: string) => boolean): Promise<number> {
    const directory = await (logoDirectory ||= loadLogoDirectory());
    if (!directory) return 0;
    let filled = 0;

    for (const channel of channels) {
        if (channel.logo && !(dead && dead(channel.logo))) continue;

        const folded = foldLogoName(channel.name);
        if (folded.length < 3) continue;

        const country = (channel.country || "").toUpperCase().replace(/^UK$/, "GB");
        const own = country ? directory.byCountry.get(`${folded}|${country}`) || (country === "GB" ? directory.byCountry.get(`${folded}|UK`) : undefined) : undefined;
        const names = directory.byName.get(folded);
        const found = own || (names && names.size === 1 && folded.length >= 5 ? [...names][0] : undefined);

        if (found) {
            channel.logo = found;
            filled += 1;
        }
    }

    return filled;
}

// END logo-directory

async function build(): Promise<ScrapedCatalogue> {
    const channels = await fetchChannels();

    await fillLogos(channels);

    return { channels, rails: railsFor(channels, SCRAPER_ID, "zlive.st") };
}

/** The live events: their own job, run on `eventsIntervalMinutes`. */
async function buildEvents(): Promise<ScrapedCatalogue> {
    const events = await buildEventsRail();

    return { channels: events.channels, rails: events.rails };
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
const CONTINENTS: [string, string][] = [
    ["Asia", "AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE AE"],
    ["Europe", "AD AL AT BA BE BG BY CH CZ DE DK EE ES FI FO FR GB UK GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK"],
    ["Africa", "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW RE"],
    ["North America", "US CA MX GL BM"],
    ["Latin America & Caribbean", "AG AI AR AW BB BO BQ BR BS BZ CL CO CR CU CW DM DO EC GD GT GY HN HT JM KN KY LC NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI MQ GP GF"],
    ["Oceania", "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS"]
];

function continentName(code: string): string {
    return CONTINENTS.find(([, codes]) => codes.split(" ").includes(code.toUpperCase()))?.[0] || "Elsewhere";
}

function languageTitle(code: string): string {
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);

        return name && name !== code ? name : code.toUpperCase();
    } catch {
        return code.toUpperCase();
    }
}

/** Words the host's own genre rails (News, Sports, Movies ...) already carry under the same name. */
const GENRE_NAMES = new Set([
    "news", "sports", "movies", "kids", "music", "documentary", "lifestyle", "business", "entertainment", "general"
]);

/** Never offered as a rail: shopping and adult shelves. */
const UNLISTED = /\b(shop\w*|xxx|adult|erotic\w*|sinnlich\w*|telesales|18\+)\b/i;

function railsFor(channels: ScrapedChannel[], sourceId: string, sourceName: string, wanted: { countries: boolean; languages: boolean; categories: boolean; networks?: boolean } = { countries: true, languages: true, categories: true }): ScrapedRail[] {
    const rails: ScrapedRail[] = [];
    const perCountry = new Map<string, { n: number; names: Map<string, number> }>();
    const perLanguage = new Map<string, number>();
    const perWord = new Map<string, number>();
    const perNetwork = new Map<string, { n: number; name: string }>();

    for (const channel of channels) {
        if (channel.country) {
            const entry = perCountry.get(channel.country) || { n: 0, names: new Map<string, number>() };

            entry.n += 1;
            if (channel.countryName) entry.names.set(channel.countryName, (entry.names.get(channel.countryName) || 0) + 1);
            perCountry.set(channel.country, entry);
        }

        for (const code of new Set(channel.languages)) perLanguage.set(code, (perLanguage.get(code) || 0) + 1);
        for (const word of new Set(channel.categories)) perWord.set(word, (perWord.get(word) || 0) + 1);

        const network = (channel.network || "").trim();

        if (network) {
            const key = network.toLowerCase();

            perNetwork.set(key, { n: (perNetwork.get(key)?.n || 0) + 1, name: perNetwork.get(key)?.name || network });
        }
    }

    function byCount<T>(a: [string, T], b: [string, T], size: (value: T) => number): number {
        return size(b[1]) - size(a[1]) || a[0].localeCompare(b[0]);
    }

    if (wanted.countries) {
        for (const [code, entry] of [...perCountry.entries()].sort((a, b) => byCount(a, b, (v) => v.n))) {
            const name = [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

            if (!name || !/^[A-Za-z]{2,3}$/.test(code)) continue;

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
            if (!/^[a-z]{2,3}$/.test(code)) continue;

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
        const taken = new Set<string>();
        let added = 0;

        for (const [word, count] of [...perWord.entries()].sort((a, b) => byCount(a, b, (v) => v))) {
            const slug = `cat-${word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");

            if (count < 3 || word.length > 40 || GENRE_NAMES.has(word) || UNLISTED.test(word) || slug === "cat" || taken.has(slug)) continue;

            taken.add(slug);
            rails.push({
                id: slug,
                heading: word.replace(/(^|[\s(+&/-])(\p{L})/gu, (_all, lead: string, first: string) => lead + first.toUpperCase()).replace(/\bTv\b/g, "TV"),
                by: "Its own category",
                group: "Categories",
                channelIds: [],
                filter: { categories: [word] }
            });

            added += 1;
            if (added >= 60) break;
        }
    }

    if (wanted.networks !== false) {
        let added = 0;

        for (const [key, entry] of [...perNetwork.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
            const slug = `network-${key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");

            if (entry.n < 3 || key.length < 3 || key.length > 30 || slug === "network" || UNLISTED.test(key) || /[^\p{L}\p{N} &.+'-]/u.test(key) || sourceName.toLowerCase().includes(key) || key.includes(sourceName.toLowerCase())) continue;

            rails.push({
                id: slug,
                heading: entry.name,
                by: "One network",
                group: "Networks",
                channelIds: [],
                filter: { networks: [key] }
            });

            added += 1;
            if (added >= 60) break;
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

// --- the segment decoder -----------------------------------------------------------

const TPIX = [84, 73, 75, 84, 73, 75, 80, 88]; // "TIKTIKPX"
const TRAW = [84, 73, 75, 84, 73, 75, 82, 65, 87]; // "TIKTIKRAW"
const TSGZ = [84, 73, 75, 84, 73, 75, 84, 83, 71, 90]; // "TIKTIKTSGZ"

function isTs(bytes: Uint8Array, at = 0): boolean {
    return bytes[at] === 0x47 && (at + 188 >= bytes.length || bytes[at + 188] === 0x47);
}

function find(bytes: Uint8Array, tag: number[]): number {
    outer: for (let i = 0; i + tag.length < bytes.length; i++) {
        for (let j = 0; j < tag.length; j++) if (bytes[i + j] !== tag[j]) continue outer;
        return i;
    }
    return -1;
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/** PNG -> its pixels as packed RGB, or null for any PNG this cannot be
 *  (not 8-bit, interlaced, not RGB/RGBA). */
function pngRgb(bytes: Uint8Array): Uint8Array | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let interlace = 0;
    const idat: Uint8Array[] = [];

    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12) return null;
        const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
        const data = bytes.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") {
            width = view.getUint32(off + 8);
            height = view.getUint32(off + 12);
            depth = data[8]!;
            colour = data[9]!;
            interlace = data[12]!;
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        off += 12 + len;
    }

    if (!width || !height || depth !== 8 || interlace || (colour !== 2 && colour !== 6)) return null;

    const raw = inflateSync(Buffer.concat(idat));
    const bpp = colour === 6 ? 4 : 3;
    const stride = width * bpp;
    const rgb = new Uint8Array(width * height * 3);
    let src = 0;
    let dst = 0;
    let prev = new Uint8Array(stride);

    for (let y = 0; y < height; y++) {
        if (src + 1 + stride > raw.length) return null;
        const filter = raw[src++]!;
        const row = raw.subarray(src, src + stride);
        src += stride;
        const out = new Uint8Array(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[i - bpp]! : 0;
            const b = prev[i]!;
            const c = i >= bpp ? prev[i - bpp]! : 0;
            let v = row[i]!;
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) v += paeth(a, b, c);
            else if (filter !== 0) return null;
            out[i] = v & 255;
        }
        if (colour === 2) {
            rgb.set(out, dst);
            dst += stride;
        } else {
            for (let i = 0; i < stride; i += 4) {
                rgb[dst++] = out[i]!;
                rgb[dst++] = out[i + 1]!;
                rgb[dst++] = out[i + 2]!;
            }
        }
        prev = out;
    }

    return rgb;
}

/** The newest layout: TS gzipped into the pixels, behind "TIKTIKPX". */
function fromPixels(bytes: Uint8Array): Uint8Array | null {
    const rgb = pngRgb(bytes);
    if (!rgb || rgb.length < 12) return null;
    for (let k = 0; k < TPIX.length; k++) if (rgb[k] !== TPIX[k]) return null;
    const size = new DataView(rgb.buffer, rgb.byteOffset + 8, 4).getUint32(0);
    if (size <= 0 || 12 + size > rgb.length) return null;
    const ts = gunzipSync(rgb.subarray(12, 12 + size));
    return isTs(ts) ? new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength) : null;
}

/** An older layout: TS appended after the PNG's IEND chunk. */
function afterIend(bytes: Uint8Array): Uint8Array | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12) return null;
        const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
        off += 12 + len;
        if (type === "IEND") return off < bytes.length && isTs(bytes, off) ? bytes.subarray(off) : null;
    }
    return null;
}

/** An older layout still: TS in a WebP's EXIF chunk. */
function webpExif(bytes: Uint8Array): Uint8Array | null {
    const ascii = (at: number, n: number): string => String.fromCharCode(...bytes.subarray(at, at + n));
    if (bytes.length < 16 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 12;
    while (off + 8 <= bytes.length) {
        const tag = ascii(off, 4);
        const n = view.getUint32(off + 4, true);
        off += 8;
        if (off + n > bytes.length) return null;
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
function unwrapSegment(bytes: Uint8Array): Uint8Array {
    if (isTs(bytes)) return bytes;

    const webp = webpExif(bytes);
    if (webp) return webp;

    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
        const tail = afterIend(bytes);
        if (tail) return tail;
        const pixels = fromPixels(bytes);
        if (pixels) return pixels;
        throw new Error("zlive: PNG segment with no TS payload");
    }

    const raw = find(bytes, TRAW);
    if (raw >= 0 && isTs(bytes, raw + TRAW.length)) return bytes.subarray(raw + TRAW.length);

    const gz = find(bytes, TSGZ);
    if (gz >= 0) {
        const ts = gunzipSync(bytes.subarray(gz + TSGZ.length));
        return new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength);
    }

    for (let i = 0; i + 188 < bytes.length; i++) if (isTs(bytes, i)) return bytes.subarray(i);

    throw new Error("zlive: segment with no TS payload");
}


/**
 * zlive's "Primary" and "IPTV" upstreams are the dlhd backend: each segment
 * is a PNG with the MPEG-TS packed into its pixels (measured Oct 2026: CNN
 * USA's segments begin `89 50 4E 47`, and dlhd's `unwrapSegment`, copied
 * above, turns them into sync-byte-clean TS). Other upstreams serve plain
 * TS, which passes straight through. Anything under a kilobyte is a key or a
 * tiny init map and is never wrapped, so it is returned as it came.
 */
const DECODER = "tiktikpx";

export const zliveScraper: Scraper = {
    id: SCRAPER_ID,
    name: "zlive.st",
    version: "1.8.0",
    resolvers: { zlive: resolveHandle },
    decoders: {
        [DECODER]: (segment) => {
            if (segment.length < 1024) return segment;

            // A segment in none of the disguises (fragmented MP4, say) is
            // handed on as it is rather than turned into an error.
            try {
                return unwrapSegment(segment);
            } catch {
                return segment;
            }
        }
    },
    configSchema,
    build,
    buildEvents
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/zlive.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    Promise.all([build(), buildEvents()])
        .then(([base, live]) => ({ channels: [...live.channels, ...base.channels], rails: [...(live.rails || []), ...(base.rails || [])] }))
        .then((catalogue) => {
            console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
            console.log(catalogue.channels[0] || "(none)");
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
