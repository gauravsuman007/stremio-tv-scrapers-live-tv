/**
 * CDN Live TV (cdnlivetv.is) -- live football, NFL, college football, MLB,
 * basketball, motorsport, UFC/WWE and more, as events with a list of TV
 * channels each, plus its 24/7 channel list (`/api/v1/channels/`: the ~165
 * the API marks online; about half of those answer when played, and the
 * resolver returns `null` for the rest, which the host drops). The `cdnlive`
 * backend `ntvst.mts` reads is the same channel list.
 *
 * THE CHAIN (verified 2026-10-04, plain HTTP, no browser)
 * -------------------------------------------------------
 *   1. `GET https://api.cdnlivetv.is/api/v1/events/sports/?user=cdnlivetv&
 *      plan=free` -- the documented public API (its own front-ends, Fantastic
 *      Soda and StreamSports99, call it with these same query values) ->
 *      `{ "cdn-live-tv": { "<Sport>": [ { event, homeTeam, awayTeam,
 *      tournament, status, start: "2026-10-04 20:25", end, channels: [ {
 *      channel_name, channel_code, url } ] } ] } }`. `start`/`end` are UTC
 *      (Raiders-Chiefs 20:25 matches the kick-off timestamp other sources
 *      give); `status` is NOT reliable (`NS` while a game is in progress), so
 *      the window is what decides: from 15 minutes before `start` to an hour
 *      after `end` (three hours after start).
 *   2. A channel's `url` is `https://cdnlivetv.tv/api/v1/channels/player/?
 *      name=<n>&code=<c>&user=cdnlivetv&plan=free`, a player page whose HTML
 *      is regenerated per request with random variable names around a fixed
 *      shape (`var <r>='<base64url>';` fragments and one assembly line chaining
 *      `<decoder>(<fragment>)+...`); the VALUE of that line is the live `.m3u8`
 *      (see `extractStreamUrl`, copied from ntvst.mts). It carries a token, and
 *      needs `Referer: https://cdnlivetv.tv/`.
 *
 * The token is short-lived, so each stream's `url` is a HANDLE
 * (`https://cdnlive.invalid/<base64url of the player url>`) resolved at play
 * time by `resolvers.cdnlive`, which also checks the playlist and its newest
 * segment answer. A channel an event lists is often off air (its player page
 * then carries no stream), so `buildEvents` keeps the first few whose page
 * does, trying at most 14 per event and giving up on the rest of the list after
 * two minutes. The player host allows about 100 requests a minute per
 * address, so resolves are paced and a 429 waits for `ratelimit-reset`. Needs
 * live-tv >= 1.6.0 (resolvers).
 *
 * What returns nothing: no event inside its window, an event with no channels,
 * a player page whose assembly shape has changed, a feed that is off air.
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
const SCRAPER_ID = "cdnlive";

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

const API = "https://api.cdnlivetv.is/api/v1";
const AUTH = "user=cdnlivetv&plan=free";
const RESOLVER = "cdnlive";
const HANDLE_HOST = "cdnlive.invalid";
const REFERRER = "https://cdnlivetv.tv/";
const BEFORE_MS = 15 * 60 * 1000;
const AFTER_END_MS = 60 * 60 * 1000;
/** Channels tried per event, and how many working ones are enough. */
const MAX_TRIED = 14;
const ENOUGH = 4;
/** Past this, the remaining events are skipped rather than letting one build run for minutes. */
const BUDGET_MS = 120_000;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SPORT_NAMES: Record<string, string> = {
    soccer: "football",
    nfl: "american football",
    ncaa: "american football",
    ncaaw: "basketball",
    nba: "basketball",
    nhl: "hockey",
    ufc: "mma",
    wwe: "wrestling"
};

interface CdnChannel { channel_name?: string; channel_code?: string; url?: string }

interface CdnEvent {
    gameID?: string;
    event?: string;
    homeTeam?: string;
    awayTeam?: string;
    homeTeamIMG?: string;
    tournament?: string;
    start?: string;
    end?: string;
    channels?: CdnChannel[];
}

function utc(stamp: string | undefined): number {
    return stamp ? Date.parse(`${stamp.replace(" ", "T")}${stamp.length === 16 ? ":00" : ""}Z`) : NaN;
}

function handleFor(playerUrl: string): string {
    return `https://${HANDLE_HOST}/${Buffer.from(playerUrl, "utf8").toString("base64url")}`;
}

/** A player page address this scraper will fetch: cdnlivetv.* only. */
function playerFrom(handle: string): string {
    try {
        const url = new URL(handle);
        if (url.hostname !== HANDLE_HOST) return "";
        const player = Buffer.from(url.pathname.slice(1), "base64url").toString("utf8");
        const parsed = new URL(player);
        return parsed.protocol === "https:" && /^(?:api\.)?cdnlivetv\.[a-z]+$/.test(parsed.hostname) && parsed.pathname.startsWith("/api/v1/channels/player/") ? parsed.href : "";
    } catch {
        return "";
    }
}

// --- the player page, copied from ntvst.mts ----------------------------------

const FRAGMENT_ASSIGN_RE = /var (\w+)='([^']*)';/g;
const ASSEMBLY_RE = /var \w+=((?:\w+\(\w+\)\+?)+);/;
const CALL_RE = /\w+\((\w+)\)/g;

function b64urlDecode(fragment: string): string {
    const padded = fragment.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    try {
        return Buffer.from(withPad, "base64").toString("utf-8");
    } catch {
        return "";
    }
}

/** The live `.m3u8` URL hidden in a player page: the shape of the assembly line, never a variable name. */
function extractStreamUrl(page: string): string | null {
    const assembly = ASSEMBLY_RE.exec(page);
    if (!assembly) return null;

    const names: string[] = [];
    for (const m of assembly[1]!.matchAll(CALL_RE)) names.push(m[1]!);
    if (!names.length) return null;

    const fragments = new Map<string, string>();
    for (const m of page.matchAll(FRAGMENT_ASSIGN_RE)) fragments.set(m[1]!, m[2]!);

    const parts: string[] = [];
    for (const name of names) {
        const fragment = fragments.get(name);
        if (fragment === undefined) return null;
        parts.push(b64urlDecode(fragment));
    }
    if (parts.some((p) => !p)) return null;

    const url = parts.join("");
    return url.startsWith("http") ? url : null;
}

// --- pacing: about 100 requests a minute per address --------------------------

const PER_MINUTE = 85;
let nextSlot = 0;

async function slot(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + 60_000 / PER_MINUTE;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

async function getText(url: string, referrer = "", ms = 15_000): Promise<string> {
    for (let attempt = 0; ; attempt++) {
        await slot();
        const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(referrer ? { Referer: referrer } : {}) } }), ms);
        if (response.ok) return await response.text();
        if (response.status === 429 && attempt < 3) {
            const reset = Number(response.headers.get("ratelimit-reset"));
            const wait = (Number.isFinite(reset) && reset > 0 ? Math.min(reset, 60) : 20) * 1000 + 500;
            nextSlot = Math.max(nextSlot, Date.now() + wait);
            continue;
        }
        throw new Error(`${url} -> ${response.status}`);
    }
}

/** Master (or a bare media playlist) -> first variant -> newest segment: all must answer. */
async function onAir(master: string): Promise<boolean> {
    try {
        const masterText = await getText(master, REFERRER, 10_000);
        if (!masterText.includes("#EXTM3U")) return false;
        const variant = masterText.includes("#EXT-X-STREAM-INF") ? masterText.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) : undefined;
        const variantUrl = variant ? new URL(variant, master).href : master;
        const variantText = variant ? await getText(variantUrl, REFERRER, 10_000) : masterText;
        const segment = variantText.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).pop();
        if (!segment) return false;
        const response = await withTimeout((signal) => fetch(new URL(segment, variantUrl), { signal, headers: { "User-Agent": BROWSER_UA, Referer: REFERRER } }), 10_000);
        await response.arrayBuffer().catch(() => undefined);
        return response.ok;
    } catch {
        return false;
    }
}

async function resolveStream(handle: string): Promise<ResolvedStream | null> {
    const player = playerFrom(handle);
    if (!player) return null;
    try {
        const url = extractStreamUrl(await getText(player));
        if (!url || !/^https:\/\//.test(url) || !(await onAir(url))) return null;
        return { url, referrer: REFERRER, userAgent: BROWSER_UA };
    } catch {
        return null;
    }
}

/** Whether a channel is on air: its player page names a playlist whose newest segment fetches. One check per channel per build. */
const playerChecks = new Map<string, Promise<boolean>>();
function hasPlayer(playerUrl: string): Promise<boolean> {
    let known = playerChecks.get(playerUrl);
    if (!known) {
        known = getText(playerUrl, "", 10_000).then((page) => { const url = extractStreamUrl(page); return url ? onAir(url) : false; }, () => false);
        playerChecks.set(playerUrl, known);
    }
    return known;
}

// --- the events --------------------------------------------------------------

interface CdnListed { name?: string; code?: string; url?: string; image?: string; status?: string }

const CATEGORY_HINTS: [RegExp, string][] = [
    [/\b(news|cnn|bbc news|sky news|cnbc|msnbc|bloomberg|cp24|euronews|al jazeera)\b/i, "news"],
    [/\b(sport|sports|espn|dazn|nhl|nba|nfl|mlb|golf|tennis|eurosport|golazo|fight|cricket|racing|f1|premier|laliga|bein|supersport|canal foot|network|tigers|braves|cubs|reds|sox|orioles|guardians|rockies|diamondbacks|altitude)\b/i, "sports"],
    [/\b(disney|nick|nickelodeon|cartoon|junior|kids|boomerang|baby)\b/i, "kids"],
    [/\b(movie|movies|cinema|cinemax|hbo|showtime|starz|film|cine)\b/i, "movies"],
    [/\b(discovery|history|nat geo|national geographic|animal planet|documentary)\b/i, "documentary"]
];

function flagOf(code: string): string {
    return /^[a-z]{2}$/i.test(code) ? String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : "";
}

/**
 * The 24/7 channel list. The API marks each channel online or offline; the
 * handle resolves at play time, so the player page is not fetched here (that
 * would be one paced request per channel) -- the host probes each handle.
 */
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
    const response = await withTimeout((signal) => fetch(`${API}/channels/?${AUTH}`, { signal, headers: { "User-Agent": BROWSER_UA } }));
    if (!response.ok) throw new Error(`cdnlive: /channels -> ${response.status}`);
    const body = (await response.json()) as { channels?: CdnListed[] };
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const channels: ScrapedChannel[] = [];
    const seen = new Set<string>();
    for (const listed of body.channels || []) {
        const name = (listed.name || "").replace(/^[:\s]+/, "").replace(/\s+/g, " ").trim();
        const code = (listed.code || "").toLowerCase();
        if (listed.status !== "online" || !name || !listed.url) continue;
        const id = idFor(`${code}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
        if (seen.has(id)) continue;
        seen.add(id);
        let countryName = "";
        try { countryName = code ? names.of(code.toUpperCase()) || "" : ""; } catch { /* unknown region */ }
        channels.push({
            id,
            name,
            country: code.toUpperCase(),
            countryName,
            countryFlag: flagOf(code),
            categories: [CATEGORY_HINTS.find(([re]) => re.test(name))?.[1] || "general"],
            languages: [],
            logo: listed.image || "",
            website: "https://cdnlivetv.is/",
            network: "",
            streams: [{ url: handleFor(listed.url), quality: "", labels: [], referrer: REFERRER, userAgent: BROWSER_UA, resolver: RESOLVER }]
        });
    }
    await fillLogos(channels, (logo) => /cdnlivetv\.tv\/api/.test(logo));

    return { channels };
}

async function buildEvents(): Promise<ScrapedCatalogue> {
    const response = await withTimeout((signal) => fetch(`${API}/events/sports/?${AUTH}`, { signal, headers: { "User-Agent": BROWSER_UA } }));
    if (!response.ok) throw new Error(`cdnlive: /events/sports -> ${response.status}`);
    const body = (await response.json()) as Record<string, Record<string, unknown>>;
    const root = body["cdn-live-tv"] || Object.values(body).find((value) => value && typeof value === "object") || {};

    const began = Date.now();
    const now = began;
    const channels: ScrapedChannel[] = [];
    const seen = new Set<string>();
    playerChecks.clear();

    for (const [section, list] of Object.entries(root)) {
        if (!Array.isArray(list)) continue;
        const sport = SPORT_NAMES[section.toLowerCase()] || section.toLowerCase();
        for (const event of list as CdnEvent[]) {
            const start = utc(event.start);
            const end = utc(event.end);
            if (!event.event || !event.gameID || !Number.isFinite(start) || !event.channels?.length) continue;
            if (now < start - BEFORE_MS || now > (Number.isFinite(end) ? end : start + 3 * 3600_000) + AFTER_END_MS) continue;

            if (Date.now() - began > BUDGET_MS) break;
            const streams: ScrapedStream[] = [];
            let tried = 0;
            for (const channel of event.channels) {
                if (!channel.url || !channel.channel_name || streams.length >= ENOUGH || tried >= MAX_TRIED) continue;
                const handle = handleFor(channel.url);
                if (streams.some((s) => s.url === handle)) continue;
                tried++;
                if (!(await hasPlayer(channel.url))) continue;
                streams.push({ url: handle, quality: "", labels: [channel.channel_name.trim()], referrer: REFERRER, userAgent: BROWSER_UA, resolver: RESOLVER });
            }
            const id = idFor(`event:${event.gameID}`);
            if (!streams.length || seen.has(id)) continue;
            seen.add(id);

            const sides = [event.homeTeam, event.awayTeam].map((side) => (side || "").trim()).filter(Boolean);
            const described = eventFor(event.event.trim(), {
                ...(sides.length === 2 ? { sides } : {}),
                competition: event.tournament || "",
                sport,
                start
            });
            channels.push({
                id,
                name: described.name,
                event: described.event,
                country: "",
                countryName: "",
                countryFlag: "",
                categories: ["sports", sport],
                languages: [],
                logo: "",
                website: "https://cdnlivetv.is/",
                network: described.event.competition || event.tournament || "",
                streams
            });
        }
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
        help: "How often the live events are re-read. Each channel is resolved when someone plays it."
    }
];

export const cdnliveScraper: Scraper = {
    id: SCRAPER_ID,
    name: "CDN Live TV",
    version: "1.2.0",
    configSchema,
    resolvers: { [RESOLVER]: resolveStream },
    build,
    buildEvents
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/cdnlive.mts` -- prints the events and resolves the first
// stream of the first one.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    buildEvents()
        .then(async (catalogue) => {
            console.log(`${catalogue.channels.length} events: ${catalogue.channels.map((c) => `${c.name} (${c.streams.length})`).join("; ")}`);
            const first = catalogue.channels[0];
            console.log(first || "(none)");
            if (first?.streams[0]) console.log(await resolveStream(first.streams[0].url));
        })
        .catch((cause) => {
            console.error("buildEvents() threw:", cause);
            process.exitCode = 1;
        });
}
