/**
 * TimStreams (timst.top; also behind DamiTV's TimStreams half and BINTV) --
 * about 185 24/7 TV channels (US, UK, sport, news, cartoons) and a live
 * events list (football, NFL, NHL, MLB, motorsport, fighting ...).
 *
 *   1. `GET https://timst.top/api/channels` -> `{ channels: [{ url, name,
 *      logo, genre, flag, vip, viewers, streams: [{ name, url, vip }] }], genres }`
 *      and `GET https://timst.top/api/live-upcoming` -> `{ events: [{ url,
 *      name, logo, genre, sub_genre, time ("2026-10-04T14:45", US Eastern),
 *      isevent, vip, streams }], genres: [{ id, name, sub_categories }] }`.
 *      Plain JSON. A stream's `url` is a short address on the player host
 *      (`https://grandemx.org/<id>`; it has been `exmxbxe.cfd` before).
 *   2. THE PLAYER PAGE. `GET <that url>` (Referer `https://timst.top/`)
 *      302s to `/play/<ts>.<sig>.<slug>`, a page for the caller's own
 *      address only (from another egress it says "Access Denied (IP Lock)"
 *      -- which is why it was filed as rejected from a research machine; a
 *      resolver runs on the host itself, so the address matches). The page's
 *      inline script hides the stream in `var _x = [<~1,200 numbers>]`, decoded
 *      with `String.fromCharCode(((a[i] ^ KEY) - SUB + 256) % 256)` where
 *      `KEY` and `SUB` are integers assigned elsewhere in the page (found by
 *      the variable names in the loop). The plain text is a jwplayer setup
 *      with `SIGNED_URL = "https://<host>/main/secure/<hash>/<expiry>/<slug>.m3u8"`.
 *      Nothing is evaluated: the decode is two integers and an array.
 *   3. The playlist needs a browser User-Agent (Node's own gets a 404) and no
 *      Referer. Its segments are `.../tos-...` URLs on
 *      TikTok's CDN that are WebP images with the MPEG-TS inside (the same
 *      disguise as Streamed's `admin`/`hotel`); `decoders.webpexif` unwraps
 *      them (the walk is `streamed.mts`'s `unwrapSegment`).
 *
 * Handles, not URLs: the page and the signed address are minted per request,
 * so each stream's `url` is a handle (`https://timstreams.invalid/<base64url
 * of the player url>`) resolved at play time by `resolvers.timstreams`. A
 * stream is checked for being on air (newest segment fetched, a WebP or TS)
 * before it is returned; whatever is not resolves to `null`.
 *
 * What returns nothing: the player host changed its page shape (no array or
 * loop found), the host not matching the one that built the catalogue, an
 * off-air channel (the segment fetch fails). `vip` streams are left out.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------

interface ScrapedStream {
    url: string;
    quality: string;
    labels: string[];
    referrer: string;
    userAgent: string;
    headers?: Record<string, string>;
    decoder?: string;
    resolver?: string;
}

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
    // A lowercase " x " is the Portuguese/Spanish "versus" ("Cyprus x Latvia"); a capital X is part of a name.
    let name = raw.replace(EVENT_DECORATION, "").replace(/\s+/g, " ").replace(/ x (?=\S)/g, " vs ").trim();
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
    logos?: string[];
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
    intervalConfigKey: string;
    run(context: ScraperTaskContext): Promise<void>;
}

interface ResolvedStream {
    url: string;
    referrer?: string;
    userAgent?: string;
    headers?: Record<string, string>;
}

type StreamResolver = (handle: string) => Promise<ResolvedStream | null>;
type SegmentDecoder = (segment: Uint8Array, url: string) => Uint8Array | Promise<Uint8Array>;

interface Scraper {
    id: string;
    name: string;
    version?: string;
    configSchema?: ScraperConfigField[];
    buildEvents?(): Promise<ScrapedCatalogue>;
    decoders?: Record<string, SegmentDecoder>;
    resolvers?: Record<string, StreamResolver>;
    build(): Promise<ScrapedCatalogue>;
}
const SCRAPER_ID = "timstreams";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
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
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}


const API = "https://timst.top/api";
const REFERRER = "https://timst.top/";
const RESOLVER = "timstreams";
const HANDLE_HOST = "timstreams.invalid";
const DECODER = "webpexif";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
/** Player hosts a handle may name: the one the API names now, plus the one it used before. */
const PLAYER_HOSTS = new Set(["grandemx.org", "exmxbxe.cfd"]);
const BEFORE_MS = 20 * 60 * 1000;
const AFTER_MS = 5 * 3600_000;
const CONCURRENCY = 6;
const BUDGET_MS = 120_000;

/** 0x47 every 188 bytes from `at`, three times over. */
function syncedAt(view: Buffer, at: number): boolean {
    return view[at] === 0x47 && view[at + 188] === 0x47 && view[at + 376] === 0x47;
}

/**
 * What a segment is, by source (all measured 2026-10-03):
 *   - `delta`: plain MPEG-TS, no disguise (`video/mp2t`).
 *   - `admin`: a WebP whose `EXIF` chunk holds the TS (sync byte at offset 42).
 *   - `hotel`: a WebP whose RIFF `size` field lies and whose one `VP8L` chunk
 *     is followed directly by the TS (sync byte at offset 36), no EXIF header.
 * So: TS already -> as is; otherwise walk the RIFF chunks and take the TS the
 * moment it starts, either at a sync byte or inside an `EXIF` chunk.
 */
export function unwrapSegment(segment: Uint8Array): Uint8Array {
    const view = Buffer.from(segment.buffer, segment.byteOffset, segment.length);

    if (syncedAt(view, 0)) return segment;

    if (view.length < 20 || view.toString("latin1", 0, 4) !== "RIFF" || view.toString("latin1", 8, 12) !== "WEBP") {
        throw new Error("neither MPEG-TS nor a WebP");
    }

    let at = 12;

    while (at + 8 <= view.length) {
        if (syncedAt(view, at)) return view.subarray(at);

        const type = view.toString("latin1", at, at + 4);
        const size = view.readUInt32LE(at + 4);

        if (type === "EXIF") {
            const body = view.subarray(at + 8, Math.min(view.length, at + 8 + size));
            if (body[0] !== 0x47) throw new Error("EXIF chunk is not MPEG-TS");
            return body;
        }

        at += 8 + size + (size & 1);
    }

    throw new Error("no MPEG-TS inside the WebP");
}


async function getJson<T>(path: string): Promise<T> {
    const response = await withTimeout((signal) => fetch(`${API}/${path}`, { signal, headers: { "User-Agent": BROWSER_UA } }), 30_000);
    if (!response.ok) throw new Error(`timstreams: /${path} -> ${response.status}`);
    return (await response.json()) as T;
}

// --- handles -----------------------------------------------------------------

function handleFor(playerUrl: string): string {
    return `https://${HANDLE_HOST}/${Buffer.from(playerUrl).toString("base64url")}`;
}

function playerFrom(handle: string): string | null {
    try {
        const url = new URL(handle);
        if (url.hostname !== HANDLE_HOST) return null;
        const player = new URL(Buffer.from(url.pathname.slice(1), "base64url").toString());
        return player.protocol === "https:" && PLAYER_HOSTS.has(player.hostname) ? player.href : null;
    } catch {
        return null;
    }
}

function usable(address: string | undefined): address is string {
    try {
        const url = new URL(address || "");
        if (url.protocol !== "https:") return false;
        PLAYER_HOSTS.add(url.hostname);
        return true;
    } catch {
        return false;
    }
}

// --- the player page -----------------------------------------------------------

/** The numbers array and the two integers of the page's decode loop, or null. */
function decodePage(html: string): string | null {
    const array = /var\s+(\w+)\s*=\s*\[([\d,\s]+)\]/.exec(html);
    const loop = /String\.fromCharCode\(\(\(\w+\[\w+\]\s*\^\s*(\w+)\)\s*-\s*(\w+)\s*\+\s*256\)\s*(?:%|&)\s*(?:256|255)\)/.exec(html);
    if (!array || !loop) return null;
    const key = new RegExp(`\\b${loop[1]}\\s*=\\s*(\\d+)`).exec(html);
    const sub = new RegExp(`\\b${loop[2]}\\s*=\\s*(\\d+)`).exec(html);
    if (!key || !sub) return null;
    const numbers = array[2]!.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value));
    let text = "";
    for (const value of numbers) text += String.fromCharCode((((value ^ Number(key[1])) - Number(sub[1]) + 256) % 256));
    return text;
}

async function get(url: string, referrer = "", ms = 15_000): Promise<Response> {
    return await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(referrer ? { Referer: referrer } : {}) } }), ms);
}

/** On air: the newest segment fetches and is a WebP or MPEG-TS. */
async function onAir(playlist: string): Promise<boolean> {
    try {
        const response = await get(playlist);
        const text = await response.text();
        if (!response.ok || !text.includes("#EXTM3U")) return false;
        const lines = (body: string): string[] => body.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
        const variant = text.includes("#EXT-X-STREAM-INF") ? lines(text)[0] : undefined;
        const variantUrl = variant ? new URL(variant, playlist).href : playlist;
        const media = variant ? await (await get(variantUrl)).text() : text;
        const segment = lines(media).pop();
        if (!segment) return false;
        const segmentResponse = await get(new URL(segment, variantUrl).href);
        const reader = segmentResponse.body?.getReader();
        const first = await reader?.read();
        await reader?.cancel().catch(() => undefined);
        const head = first?.value;
        return segmentResponse.ok && !!head && (head[0] === 0x47 || (head.length > 12 && Buffer.from(head.subarray(0, 4)).toString("latin1") === "RIFF"));
    } catch {
        return false;
    }
}

async function resolveStream(handle: string): Promise<ResolvedStream | null> {
    const player = playerFrom(handle);
    if (!player) return null;
    try {
        const response = await get(player, REFERRER);
        if (!response.ok) return null;
        const decoded = decodePage(await response.text());
        const address = decoded ? /https:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/.exec(decoded)?.[0] : undefined;
        if (!address || !(await onAir(address))) return null;
        return { url: address, referrer: "", userAgent: BROWSER_UA };
    } catch {
        return null;
    }
}

// --- times -------------------------------------------------------------------------

/** The offset (ms) of a zone from UTC at an instant. */
function zoneOffset(at: number, zone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric"
    }).formatToParts(new Date(at));
    const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - Math.floor(at / 60_000) * 60_000;
}

/** "2026-10-04T14:45" read as a wall-clock time in a zone -> epoch ms, or NaN. */
function zonedTime(text: string, zone: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text || "");
    if (!m) return NaN;
    const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    const first = wall - zoneOffset(wall, zone);
    return wall - zoneOffset(first, zone);
}

// --- the catalogue -------------------------------------------------------------------

interface Feed { name?: string; url?: string; vip?: boolean }
interface Genre { id?: number; name?: string; sub_categories?: { id?: number; name?: string }[] }
interface Listed {
    url?: string;
    name?: string;
    logo?: string;
    genre?: number;
    sub_genre?: number;
    flag?: string;
    time?: string;
    isevent?: boolean;
    vip?: boolean;
    streams?: Feed[];
}

function streamsOf(listed: Listed): ScrapedStream[] {
    return (listed.streams || []).filter((feed) => !feed.vip && usable(feed.url)).map((feed) => ({
        url: handleFor(feed.url!),
        quality: "",
        labels: feed.name ? [feed.name.trim()] : [],
        referrer: "",
        userAgent: BROWSER_UA,
        resolver: RESOLVER,
        decoder: DECODER
    }));
}

const SPORT_NAMES: Record<string, string> = {
    soccer: "football", "american football": "american football", "professional wrestling": "wrestling", motorsport: "motorsport", fighting: "fighting"
};
const CHANNEL_GENRES: Record<number, string> = { 1: "entertainment", 2: "sports", 3: "kids", 4: "news" };

function flagOf(code: string): string {
    return /^[a-z]{2}$/i.test(code) ? String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : "";
}

async function build(): Promise<ScrapedCatalogue> {
    const body = await getJson<{ channels?: Listed[] }>("channels");
    const regions = new Intl.DisplayNames(["en"], { type: "region" });
    const channels: ScrapedChannel[] = [];
    const seen = new Set<string>();
    for (const listed of body.channels || []) {
        const name = (listed.name || "").trim();
        const streams = streamsOf(listed);
        const id = idFor(`channel:${listed.url || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
        if (!name || vipOnly(listed) || !streams.length || seen.has(id)) continue;
        seen.add(id);
        const code = (listed.flag || "").toUpperCase();
        let countryName = "";
        try { countryName = code ? regions.of(code) || "" : ""; } catch { /* unknown region */ }
        channels.push({
            id,
            name,
            country: code,
            countryName,
            countryFlag: flagOf(code),
            categories: [CHANNEL_GENRES[listed.genre || 0] || "general"],
            languages: [],
            logo: listed.logo || "",
            website: "https://timst.top/",
            network: "TimStreams",
            streams
        });
    }
    if (!channels.length) throw new Error("timstreams: the channel list was empty");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "TimStreams") };
}

function vipOnly(listed: Listed): boolean {
    return !!listed.vip;
}

async function buildEvents(): Promise<ScrapedCatalogue> {
    const body = await getJson<{ events?: Listed[]; genres?: Genre[] }>("live-upcoming");
    const genres = new Map((body.genres || []).map((genre) => [genre.id, genre]));
    const now = Date.now();
    const candidates: { listed: Listed; streams: ScrapedStream[]; start: number }[] = [];
    for (const listed of body.events || []) {
        const start = zonedTime(listed.time || "", "America/New_York");
        if (!listed.name || !listed.url || listed.vip || !Number.isFinite(start) || now < start - BEFORE_MS || now > start + AFTER_MS) continue;
        const streams = streamsOf(listed);
        if (streams.length) candidates.push({ listed, streams, start });
    }

    // Keep only feeds that are on air: resolve each, a few at a time.
    const checked = new Map<string, boolean>();
    const jobs = candidates.flatMap((candidate) => candidate.streams.map((stream) => stream.url));
    let next = 0;
    const began = Date.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < jobs.length && Date.now() - began < BUDGET_MS) {
            const handle = jobs[next++]!;
            checked.set(handle, !!(await resolveStream(handle)));
        }
    }));

    const channels: ScrapedChannel[] = [];
    const seen = new Set<string>();
    for (const { listed, streams, start } of candidates) {
        const live = streams.filter((stream) => checked.get(stream.url));
        const id = idFor(`event:${listed.url}`);
        if (!live.length || seen.has(id)) continue;
        seen.add(id);
        const genre = genres.get(listed.genre);
        const genreName = (genre?.name || "").toLowerCase();
        const sport = SPORT_NAMES[genreName] || genreName;
        const competition = genre?.sub_categories?.find((sub) => sub.id === listed.sub_genre)?.name || "";
        const described = eventFor(listed.name!.trim(), { competition, ...(sport ? { sport } : {}), start });
        channels.push({
            id,
            name: described.name,
            event: described.event,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", ...(sport ? [sport] : [])],
            languages: [],
            logo: listed.logo || "",
            website: "https://timst.top/",
            network: described.event.competition || competition,
            streams: live
        });
    }
    return {
        channels,
        rails: channels.length ? [{ id: "live-events", heading: "Live Events", channelIds: channels.map((c) => c.id), group: "Live events" }] : []
    };
}

const configSchema: ScraperConfigField[] = [
    {
        key: "channelsIntervalMinutes",
        label: "Channels refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 60,
        help: "How often the 24/7 channel list is re-read. Each channel is resolved when someone plays it."
    },
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 15,
        min: 5,
        help: "How often the live events are re-read."
    }
];

export const timstreamsScraper: Scraper = {
    id: SCRAPER_ID,
    name: "TimStreams",
    version: "1.0.1",
    configSchema,
    resolvers: { [RESOLVER]: resolveStream },
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    build,
    buildEvents
};

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

// -------------------------------------------------------------------------
// `npx tsx scrapers/timstreams.mts` -- prints both counts and resolves the
// first stream of each.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    Promise.all([build(), buildEvents()])
        .then(async ([channels, events]) => {
            console.log(`${channels.channels.length} channels, ${events.channels.length} events: ${events.channels.map((c) => `${c.name} (${c.streams.length})`).join("; ")}`);
            for (const first of [channels.channels[0], events.channels[0]]) {
                if (first?.streams[0]) console.log(first.name, await resolveStream(first.streams[0].url));
            }
        })
        .catch((cause) => {
            console.error("threw:", cause);
            process.exitCode = 1;
        });
}
