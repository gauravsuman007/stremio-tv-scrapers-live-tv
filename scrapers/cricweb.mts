/**
 * CricWeb (cricweb.vip) -- today's cricket and football fixtures, live and
 * upcoming, plus its small "TV Channels" grid. cricweb.vip is a front page;
 * every fixture and channel links to `live.mhdtv.online/watch/<slug>`, a
 * Laravel/Livewire page that lists the sources, so both are read here.
 *
 * THE FIXTURES
 *   The home page's `<article class="card event-card">` blocks carry the
 *   league (`title`), two teams with their flag/crest images, a UTC
 *   timestamp in ms (`data-event-ms`, verified against the printed local
 *   time) and the watch link. What they do NOT carry reliably:
 *
 *   - STATUS. `data-status="live"` was still set on fixtures from Sep 30 and
 *     Oct 1 when read on Oct 3, so it is ignored. "Live" is decided from the
 *     timestamp: from start until a per-sport window has passed (cricket 9h,
 *     5 days for a Test; football 3h). "Upcoming" is a start within the next
 *     12h. Either is kept only if it has at least one playable source.
 *   - SPORT. `data-sport="cricket"` was set on football friendlies and a
 *     CAF qualifier. The sport is decided from the league title (cricket
 *     words first, then football words) and only then from the site's tag.
 *
 *   Each fixture is one card ("India vs West Indies") on THREE rails, same
 *   cards where they overlap: "Live Events" (the heading every events
 *   scraper here shares, so they merge), "Live Cricket" (also crichd's and
 *   ntvst's) and "Live Football". ntvst calls its football rail "Live
 *   Soccer"; this one follows the site's and the requester's word.
 *
 *   THE GRAPHIC: the site has no single picture with both flags -- the two
 *   sides are separate files (`live.mhdtv.online/storage/images/events/...`)
 *   -- and a scraper cannot compose one (the contract carries URLs). So the
 *   card gives BOTH: `logos = [home, away]`, which the host draws side by side
 *   on one tile (`ScrapedChannel.logos`, live-tv 1.8.0), and
 *   `logo` = the home side for a host that predates the field.
 *
 * THE SOURCES (watch page)
 *   One source is rendered straight into the player (an `<iframe>` or a
 *   `<video data-stream-type>`); two or more become `data-stream-button`
 *   buttons, each with a name ("Bein Sports 3 AQ", "HD Server") and the same
 *   URL/type attributes. What the URLs are, verified 2026-10-03 over the
 *   whole listing (45 sources on 12 fixtures, 26 on 25 channels):
 *
 *   - `api.sportzfy24.com/m3u8.php?id=<m3u8 url>` (17): a page that hands
 *     the id to hls.js with no headers. The id IS the stream (one carried
 *     the typo `ttps://`, which the site's page tolerates by atob-ing it
 *     as-is -- repaired here). Offered directly.
 *   - `playyyz1.cc/e?hls=<m3u8 url>&...` (3): same, the stream is the
 *     `hls` parameter. Offered directly.
 *   - `data-stream-type="hls"` (13, channels): a plain m3u8. Offered directly.
 *   - `data-stream-type="dash"` / `drm/player.php`: encrypted, see below.
 *
 *   - `api.sportzf.com/drm/player.php?id=N` and `api.sportzfy24.com/drm/...`
 *     (20 of 45 fixture sources, the biggest family) and every
 *     `data-stream-type="dash"` button that carries `data-stream-kid` /
 *     `data-stream-key` (most of the TV Channels): DASH `cenc` with a ClearKey.
 *     The player page spells it as JSON constants (`MANIFEST_URL`,
 *     `STREAM_TYPE`, `STREAM_HEADERS`, `DRM_KID`, `DRM_KEY`, `HAS_DRM`),
 *     parsed here, never evaluated; a button's URL may end in a Kodi-style
 *     `|user-agent=...&referer=...`. Offered as `ScrapedStream.clearKey`: the
 *     host decrypts with ffmpeg and serves HLS (see AGENTS.md, "ClearKey
 *     streams"). Verified 2026-10-03 through the host's relay: 8 of the 18
 *     distinct encrypted streams on the site that day decoded to video; the
 *     rest were off the air or gated (403 for any User-Agent from here; a
 *     Russian CDN for the Mat4 set). A `player.php` page with `HAS_DRM =
 *     false` and an HLS manifest is offered as plain HLS.
 *   - `Origin` in a player's `STREAM_HEADERS` is dropped: the contract carries
 *     `referrer` and `userAgent` only.
 *
 *   NOT offered (recorded so nobody retries them):
 *   - a `dash` source with no key (HAS_DRM false), and every other type the
 *     host cannot play as HLS or decrypt.
 *   - `1freecdn.xyz/hembedplayer/...` (flowplayer on a P2P `vidictPeer`
 *     loader), `tmaxapp.site/welive/player.php` (a packed script),
 *     `backend.plusbox.tv`, YouTube embeds: not traced, not plain HLS.
 *
 *   MOST of the direct hosts answered 403 to every Referer/Origin tried
 *   (livetl00x, gpcdn, tapmad's akamaized/cloudfront) from the research
 *   machine, and 200 for a few (`domaincdn.cc`, `gpcdn.net/live/ten_2_hd_720`,
 *   `aynascope.net`, ottplus, sananda, a cloudfront scheduler). That pattern
 *   reads as geo/IP gating, which this machine cannot tell apart from a
 *   dead feed -- so everything direct is offered and the host's own checks
 *   decide. Tokens with a past `auth_key=<epoch>` are dropped.
 *
 * NAMING FOR iptv-org
 *   As crichd.mts: a source whose button names a real channel is also
 *   emitted as a plain channel under iptv-org's spelling and country, so the
 *   host's name+country merge can add it as a mirror. Only a CONFIDENT match
 *   (iptv-org knows the name) is emitted; "HD Server", "Fast server" and
 *   "Download Now" are server names, not channels, and stay on the card. A
 *   flag emoji in the name ("TapMad🇧🇩🇵🇰") picks the country when iptv-org
 *   has the name in several. The TV Channels grid is emitted as channels in
 *   its own right, named by the site.
 */

// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see template/scraper-template.mts.
// -------------------------------------------------------------------------

interface ClearKey {
    kid: string;
    key: string;
}

interface ScrapedStream {
    url: string;
    quality: string;
    labels: string[];
    referrer: string;
    userAgent: string;
    clearKey?: ClearKey;
}

/** Who is in a live event and when, so the host can merge it with the same fixture from other sources. */
interface ScrapedEvent {
    sides?: string[];
    /** What the host merges on -- see `eventFor`. */
    key?: string;
    /** Further keys the same event goes by. */
    keys?: string[];
    title?: string;
    competition?: string;
    /** The competition's own logo as the source publishes it (live-tv 1.22.0): a badge under the sides' crests, never the card's `logo`. */
    competitionLogo?: string;
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
    extra: { sides?: string[]; sport?: string; competition?: string; competitionLogo?: string; start?: number } = {}
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
            ...(extra.competitionLogo && /^https?:\/\//i.test(extra.competitionLogo) ? { competitionLogo: extra.competitionLogo } : {}),
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
    /** A fixture's two flags, drawn side by side by the host (`ScrapedChannel.logos`). */
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
    dependsOn?: string[];
    intervalConfigKey?: string;
    run(ctx: ScraperTaskContext): Promise<void>;
}

interface ScraperBuildContext {
    config: Record<string, ScraperConfigValue>;
}

interface Scraper {
    id: string;
    name: string;
    version?: string;
    configSchema?: ScraperConfigField[];
    tasks?: ScraperTask[];
    build(context?: ScraperBuildContext): Promise<ScrapedCatalogue>;
    buildEvents?(context?: ScraperBuildContext): Promise<ScrapedCatalogue>;
}

const SCRAPER_ID = "cricweb";
const SCRAPER_NAME = "CricWeb";
const SITE = "https://cricweb.vip";
const WATCH = "https://live.mhdtv.online";

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

// --- shared helpers (copied from crichd.mts) ------------------------------------

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: fetch() resolves on
    // headers and the body read that follows is still tied to this signal.
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();

    try {
        return await work(controller.signal);
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}

async function getText(url: string, referrer = "", ms = 20_000): Promise<{ text: string; url: string }> {
    const response = await withTimeout(
        (signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(referrer ? { Referer: referrer } : {}) } }),
        ms
    );
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return { text: await response.text(), url: response.url };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const at = next++;
            results[at] = await work(items[at]!);
        }
    });
    await Promise.all(workers);
    return results;
}

function decodeEntities(text: string): string {
    return text
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}


// --- names ----------------------------------------------------------------------

function fold(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

/** "Willow Cricket HD" -> "Willow Cricket". */
function cleanChannelName(raw: string): string {
    return raw
        .replace(/[([][^)\]]*[)\]]/g, " ")
        .replace(/\b(?:4k|uhd|fhd|hd|sd|hq|(?:360|480|576|720|1080|1440|2160)p?)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** The resolution the channel's name states, or "". */
function resolutionOf(raw: string): string {
    const explicit = /\b(4k|uhd|fhd|(?:360|480|576|720|1080|1440|2160)p?)\b/i.exec(raw)?.[1]?.toLowerCase();
    if (explicit) return /^\d+$/.test(explicit) ? `${explicit}p` : explicit === "fhd" ? "1080p" : explicit.toUpperCase().replace("UHD", "4K");
    if (/\bhd\b/i.test(raw)) return "HD";
    if (/\bsd\b/i.test(raw)) return "SD";
    return "";
}


function flagOf(code: string): string {
    const iso = code === "UK" ? "GB" : code;
    if (!/^[A-Z]{2}$/.test(iso)) return "";
    return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function countryNameOf(code: string): string {
    try {
        return new Intl.DisplayNames(["en"], { type: "region" }).of(code === "UK" ? "GB" : code) || code;
    } catch {
        return code;
    }
}

/** A name this site spells differently from the rest of the world, where
 *  iptv-org's own alt names do not already say so. */
const ALIASES: Record<string, string> = {
    willowcricket: "Willow"
};

interface KnownChannel {
    name: string;
    country: string;
    /** Matched by its own name, not an alternative. */
    primary: boolean;
    sports: boolean;
}

let knownCache: { at: number; byName: Map<string, KnownChannel[]> } | null = null;
let knownInFlight: Promise<Map<string, KnownChannel[]>> | null = null;
const KNOWN_TTL_MS = 24 * 60 * 60 * 1000;

/** iptv-org's channels by every name they go by. Never throws: the
 *  worst a failure costs is a spelling. */
function knownChannels(): Promise<Map<string, KnownChannel[]>> {
    if (knownCache && Date.now() - knownCache.at < KNOWN_TTL_MS) return Promise.resolve(knownCache.byName);

    knownInFlight ||= (async () => {
        try {
            const response = await withTimeout((signal) => fetch("https://iptv-org.github.io/api/channels.json", { signal }), 60_000);
            if (!response.ok) throw new Error(`channels.json -> ${response.status}`);

            const raw = (await response.json()) as { name?: string; alt_names?: string[]; country?: string; categories?: string[]; closed?: string | null }[];
            const byName = new Map<string, KnownChannel[]>();
            const add = (key: string, entry: KnownChannel): void => {
                if (!key) return;
                const list = byName.get(key) || [];
                if (!list.some((e) => e.name === entry.name && e.country === entry.country)) list.push(entry);
                byName.set(key, list);
            };

            for (const channel of raw) {
                if (!channel.name || !channel.country || channel.closed) continue;

                const sports = channel.categories?.includes("sports") === true;

                add(fold(channel.name), { name: channel.name, country: channel.country, primary: true, sports });
                /* Every reader keeps `primary || sports`, so a non-sports channel's
                   alternate names are never read: not storing them is most of the
                   map (11.7 MB held for a day, measured). */
                if (sports) for (const alt of channel.alt_names || []) add(fold(alt), { name: channel.name, country: channel.country, primary: false, sports });
            }

            knownCache = { at: Date.now(), byName };
            /* Let go ten minutes after a run rather than holding it for the
               day: the events job runs hourly, and the map is megabytes of
               heap between runs for a refetch of one file. */
            setTimeout(() => {
                knownCache = null;
            }, 10 * 60 * 1000).unref?.();
        } catch (cause) {
            console.error("crichd: iptv-org names unavailable, using the site's own", cause);
            knownCache ||= { at: Date.now() - KNOWN_TTL_MS + 10 * 60 * 1000, byName: new Map() };
        } finally {
            knownInFlight = null;
        }

        return knownCache!.byName;
    })();

    return knownInFlight;
}

/** The name and country the rest of the index would know this channel by. */
function canonical(cleaned: string, hint: string, known: Map<string, KnownChannel[]>): { name: string; country: string } {
    const alias = ALIASES[fold(cleaned)];
    // An alternative name is trusted only on a sports channel ("Sony Ten 1");
    // elsewhere it is how "Independent" ends up as a Californian TV station.
    const candidates = (known.get(fold(alias || cleaned)) || []).filter((c) => c.primary || c.sports);
    const sameCountry = hint ? candidates.filter((c) => c.country === hint) : [];
    const pool = sameCountry.length ? sameCountry : candidates;
    const countries = new Set(pool.map((c) => c.country));

    // Several countries and nothing to choose by: guessing would put the
    // stream on another country's channel.
    if (pool.length && countries.size === 1) {
        const best = pool.find((c) => c.primary) || pool[0]!;
        return { name: best.name, country: best.country };
    }

    return { name: alias || cleaned, country: hint };
}


// --- the home page -----------------------------------------------------------------

type Sport = "cricket" | "football";

interface Team {
    name: string;
    logo: string;
}

interface ListedEvent {
    slug: string;
    league: string;
    tag: string;
    start: number;
    teams: Team[];
}

interface ListedChannel {
    slug: string;
    name: string;
    logo: string;
}

const CRICKET_WORDS = /cricket|\b(?:icc|odi|t20i?|t10|ipl|psl|bbl|cpl|lpl|bpl|mlc|sa20|ilt20|hundred|ashes|test|ranji|asia cup|big bash|smash)\b/i;
const FOOTBALL_WORDS =
    /friendl|qualif|nations league|fifa|uefa|world cup|premier league|la ?liga|serie a|bundesliga|ligue|champions league|europa|conference league|copa|cup of nations|afcon|asean|mls|soccer|football|\bafc\b|concacaf|conmebol/i;

function sportOf(league: string, tag: string): Sport | null {
    if (CRICKET_WORDS.test(league)) return "cricket";
    if (FOOTBALL_WORDS.test(league)) return "football";
    return tag === "cricket" || tag === "football" ? tag : null;
}

/** How long after the start a fixture can still be on. */
function windowOf(sport: Sport, league: string): number {
    if (sport === "football") return 3 * 60 * 60 * 1000;
    return /\btest\b/i.test(league) ? 5 * 24 * 60 * 60 * 1000 : 9 * 60 * 60 * 1000;
}

/** Sources are usually up a little before the start. */
const LEAD_MS = 10 * 60 * 1000;
const HOURS_AHEAD = 12;

async function fetchHome(): Promise<{ events: ListedEvent[]; channels: ListedChannel[] }> {
    const { text } = await getText(`${SITE}/`);
    // A 200 that is not this page at all must throw, not read as "nothing on".
    if (!text.includes('id="live-matches"')) throw new Error("cricweb: home page not recognised");

    const events: ListedEvent[] = [];

    for (const article of text.matchAll(/<article\s+class="card event-card"[\s\S]*?<\/article>/g)) {
        const block = article[0];
        const slug = /\/watch\/([^'"?#]+)/.exec(block)?.[1];
        const ms = Number(/data-event-ms="(\d+)"/.exec(block)?.[1]);
        const league = decodeEntities(/class="event-title-text"\s+title="([^"]*)"/.exec(block)?.[1] || "");
        const teams = [...block.matchAll(/<div class="team">\s*<img\s+src="([^"]+)"[\s\S]*?<div class="team-name">([^<]*)<\/div>/g)].map((m) => ({
            logo: decodeEntities(m[1]!),
            name: decodeEntities(m[2]!)
        }));

        if (!slug || !Number.isFinite(ms) || teams.length < 2) continue;
        events.push({ slug, league, tag: /data-sport="(\w+)"/.exec(block)?.[1] || "", start: ms, teams });
    }

    const channels = [
        ...text.matchAll(/class="card channel-card"\s+onclick="location\.href='[^']*\/watch\/([^'"?#]+)'">\s*<img\s+src="([^"]+)"[^>]*>\s*<span class="channel-name">([^<]*)<\/span>/g)
    ].map((m) => ({ slug: m[1]!, logo: decodeEntities(m[2]!), name: decodeEntities(m[3]!) }));

    return { events, channels };
}

// --- a watch page ------------------------------------------------------------------

interface Source {
    /** The button's text ("Bein Sports 3 AQ"), or "" for a lone player. */
    name: string;
    url: string;
    type: string;
    /** `data-stream-kid` / `data-stream-key`, set on a DASH button. */
    kid: string;
    key: string;
}

async function fetchSources(slug: string): Promise<Source[]> {
    const { text } = await getText(`${WATCH}/watch/${encodeURIComponent(slug)}`, `${SITE}/`);
    const sources: Source[] = [];

    for (const button of text.matchAll(/<button[^>]*data-stream-button[^>]*>([\s\S]*?)<\/button>/g)) {
        const attribute = (name: string): string => decodeEntities(new RegExp(`${name}="([^"]*)"`).exec(button[0])?.[1] || "");
        sources.push({
            name: decodeEntities(button[1]!.replace(/<[^>]*>/g, "")),
            url: attribute("data-stream-url"),
            type: attribute("data-stream-type"),
            kid: attribute("data-stream-kid").trim(),
            key: attribute("data-stream-key").trim()
        });
    }

    // One source has no buttons: it is rendered into the player itself.
    if (!sources.length) {
        const player = /data-stream-player-wrapper>([\s\S]*?)<\/div>/.exec(text)?.[1] || "";
        const frame = /<iframe[^>]*\ssrc="([^"]+)"/.exec(player)?.[1];
        const video = /<video[^>]*\sdata-src="([^"]+)"[^>]*data-stream-type="(\w+)"/.exec(player);

        if (frame) sources.push({ name: "", url: decodeEntities(frame), type: "embed", kid: "", key: "" });
        else if (video) sources.push({ name: "", url: decodeEntities(video[1]!), type: video[2]!, kid: "", key: "" });
    }

    return sources;
}

// --- which sources are playable ----------------------------------------------------

/** A token that carries its own expiry, long past, is not worth offering. */
function expired(url: string): boolean {
    const epoch = Number(/[?&]auth_key=(\d{10})-/.exec(url)?.[1]);
    return Number.isFinite(epoch) && epoch * 1000 < Date.now();
}

interface Found {
    url: string;
    referrer: string;
    userAgent: string;
    clearKey?: ClearKey;
}

const HEX32 = /^[0-9a-f]{32}$/i;

/** Kodi-style `manifest.mpd|user-agent=...&referer=...`: the address and the headers the site's player adds. */
function splitHeaders(raw: string): { url: string; referrer: string; userAgent: string } {
    const at = raw.indexOf("|");
    let referrer = "";
    let userAgent = "";

    if (at >= 0) {
        for (const pair of raw.slice(at + 1).split("&")) {
            const eq = pair.indexOf("=");
            const name = pair.slice(0, eq).trim().toLowerCase();
            const value = pair.slice(eq + 1).trim();

            if (name === "user-agent") userAgent = value;
            else if (name === "referer" || name === "referrer") referrer = value;
        }
    }

    return { url: at >= 0 ? raw.slice(0, at) : raw, referrer, userAgent };
}

/**
 * `api.sportzf*.com/drm/player.php?id=N`: a Shaka page whose script opens with
 * `const MANIFEST_URL / STREAM_TYPE / STREAM_HEADERS / DRM_KID / DRM_KEY /
 * HAS_DRM`. The values are JSON literals, so they are parsed, not evaluated.
 * Cached for the run: one player id is listed on many fixtures.
 */
const playerPages = new Map<string, Promise<Found | null>>();

function fromPlayerPage(url: string): Promise<Found | null> {
    const cached = playerPages.get(url);
    if (cached) return cached;

    const work = (async (): Promise<Found | null> => {
        const { text } = await getText(url, `${WATCH}/`, 10_000);
        const constant = (name: string): unknown => {
            const raw = new RegExp(`const ${name} = (.*?);\\n`).exec(text)?.[1];
            try {
                return raw === undefined ? undefined : JSON.parse(raw);
            } catch {
                return undefined;
            }
        };

        const manifest = constant("MANIFEST_URL");
        const type = constant("STREAM_TYPE");
        const drm = constant("HAS_DRM") === true;
        const headers = constant("STREAM_HEADERS");
        const lower: Record<string, string> = {};

        if (headers && typeof headers === "object") {
            for (const [name, value] of Object.entries(headers as Record<string, unknown>)) if (typeof value === "string") lower[name.toLowerCase()] = value;
        }

        if (typeof manifest !== "string" || !/^https?:\/\//i.test(manifest)) return null;

        const referrer = lower["referer"] || "";
        const userAgent = lower["user-agent"] || "";

        // Plain HLS behind a player page: no key needed.
        if (!drm && type === "hls" && /\.m3u8/i.test(manifest) && !expired(manifest)) return { url: manifest, referrer, userAgent };

        const key = constant("DRM_KEY");
        const kid = constant("DRM_KID");

        if (drm && type === "dash" && typeof key === "string" && HEX32.test(key)) {
            return { url: manifest, referrer, userAgent, clearKey: { kid: typeof kid === "string" && HEX32.test(kid) ? kid.toLowerCase() : "", key: key.toLowerCase() } };
        }

        return null;
    })().catch(() => null);

    playerPages.set(url, work);
    return work;
}

/** The stream behind a source, and the headers its own player would send, or
 *  null for everything this contract cannot play (see the header). */
async function playable(source: Source): Promise<Found | null> {
    let inner: string | null = null;
    let referrer = "";

    try {
        const url = new URL(source.url);

        // DASH + ClearKey, straight off the button (Kodi-style `|header=value` suffix and all).
        if (source.type === "dash" && HEX32.test(source.key)) {
            const split = splitHeaders(source.url);

            if (!/^https?:\/\/[^\s]+\.mpd/i.test(split.url)) return null;

            return {
                url: split.url,
                referrer: split.referrer,
                userAgent: split.userAgent,
                clearKey: { kid: HEX32.test(source.kid) ? source.kid.toLowerCase() : "", key: source.key.toLowerCase() }
            };
        }

        if (/^api\.sportzf(?:y24)?\.com$/.test(url.hostname) && url.pathname === "/drm/player.php") return await fromPlayerPage(source.url);

        if (url.pathname.endsWith("/m3u8.php") && source.url.includes("?id=")) {
            // The id is not encoded; everything after `id=` is the stream.
            inner = source.url.slice(source.url.indexOf("?id=") + 4).replace(/^ttps:/, "https:");
            referrer = `${url.origin}/`;
        } else if (url.hostname === "playyyz1.cc" && url.pathname === "/e") {
            inner = url.searchParams.get("hls");
            referrer = `${url.origin}/`;
        } else if (source.type === "hls") {
            inner = source.url;
        }
    } catch {
        return null;
    }

    if (!inner || !/^https?:\/\/[^\s]+\.m3u8/i.test(inner) || expired(inner)) return null;
    return { url: inner, referrer, userAgent: "" };
}

/** "Bein Sports 3 AQ" -> "Bein Sports 3"; a flag emoji pair -> country codes. */
function channelNameOf(raw: string): { name: string; hints: string[] } {
    const hints: string[] = [];

    for (const flag of raw.matchAll(/\p{Regional_Indicator}{2}/gu)) {
        const code = [...flag[0]].map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 65)).join("");
        hints.push(code === "GB" ? "UK" : code);
    }

    const name = cleanChannelName(
        raw
            .replace(/\p{Regional_Indicator}|\p{Extended_Pictographic}|‍|️/gu, " ")
            .replace(/\b(?:aq|ads?\s*free|mobile|server|fast|download now)\b/gi, " ")
    );

    return { name, hints };
}

/** "West indies" -> "West Indies": other sources spell the fixture the usual way, and a name must match to merge. */
function titleCase(name: string): string {
    return name.replace(/\p{L}[\p{L}'’.]*/gu, (word, at: number) => (at > 0 && /^(?:and|of|the|de|da|di|del|la|le|von|van)$/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1)));
}

/** Names that name a server, not a channel. */
const SERVERISH = /^(?:|hd|fhd|link|main|backup|server|stream|player|live|tv|\d+)$/i;

// --- fixtures -> cards, channels ---------------------------------------------------

interface Fetched {
    channels: ScrapedChannel[];
}

function startsLabel(start: number): string {
    const date = new Date(start);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `Starts ${date.getUTCDate()} ${date.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

async function fetchAll(want: { events: boolean; channels: boolean }): Promise<Fetched> {
    const now = Date.now();
    const home = await fetchHome();

    const due = (want.events ? home.events : []).flatMap((event) => {
        const sport = sportOf(event.league, event.tag);
        if (!sport) return [];
        const started = now >= event.start - LEAD_MS;
        const live = started && now <= event.start + windowOf(sport, event.league);
        const soon = !started && event.start - now <= HOURS_AHEAD * 60 * 60 * 1000;
        return live || soon ? [{ event, sport, live: started }] : [];
    });

    const [eventPages, channelPages] = await Promise.all([
        mapWithConcurrency(due, 4, async (item) => ({
            ...item,
            sources: await fetchSources(item.event.slug).catch((cause) => {
                console.error(`cricweb: ${item.event.slug} skipped`, cause);
                return null;
            })
        })),
        mapWithConcurrency(want.channels ? home.channels : [], 4, async (channel) => ({
            channel,
            sources: await fetchSources(channel.slug).catch((cause) => {
                console.error(`cricweb: channel ${channel.slug} skipped`, cause);
                return null;
            })
        }))
    ]);

    // Every page failing is the site being down, not nothing being on.
    if (eventPages.length + channelPages.length && [...eventPages, ...channelPages].every((p) => !p.sources)) {
        throw new Error("cricweb: no watch page could be read");
    }

    const known = await knownChannels();
    const channels = new Map<string, ScrapedChannel>();
    const cards: ScrapedChannel[] = [];

    const emit = (name: string, hint: string, stream: ScrapedStream, extra: Partial<ScrapedChannel> = {}): void => {
        const { name: canonicalName, country } = canonical(name, hint, known);
        const id = idFor(`channel:${fold(canonicalName)}:${country.toLowerCase() || "xx"}`);
        const channel: ScrapedChannel = channels.get(id) || {
            id,
            name: canonicalName,
            country,
            countryName: country ? countryNameOf(country) : "",
            countryFlag: country ? flagOf(country) : "",
            categories: ["sports"],
            languages: [],
            logo: "",
            website: SITE,
            network: "",
            streams: [],
            ...extra
        };

        if (!channel.streams.some((s) => s.url === stream.url)) channel.streams.push(stream);
        if (!channel.logo && extra.logo) channel.logo = extra.logo;
        channels.set(id, channel);
    };

    for (const { event, sport, live, sources } of eventPages) {
        if (!sources) continue;

        const streams: ScrapedStream[] = [];
        let skipped = 0;

        for (const source of sources) {
            const found = await playable(source);
            if (!found) {
                skipped += 1;
                continue;
            }

            const { name, hints } = channelNameOf(source.name);
            const shown = source.name.replace(/\p{Regional_Indicator}|️/gu, "").trim();
            const stream: ScrapedStream = {
                url: found.url,
                quality: resolutionOf(source.name),
                labels: [...(shown ? [shown] : []), ...(live ? [] : [startsLabel(event.start)])],
                referrer: found.referrer,
                userAgent: found.userAgent,
                ...(found.clearKey ? { clearKey: found.clearKey } : {})
            };

            if (!streams.some((s) => s.url === stream.url)) streams.push(stream);

            // Only a name iptv-org knows is a channel; "HD Server" is not.
            if (!SERVERISH.test(name) && (known.get(fold(ALIASES[fold(name)] || name)) || []).some((c) => c.primary || c.sports)) {
                emit(name, hints[0] || "", { ...stream, labels: stream.labels.filter((l) => !l.startsWith("Starts ")) });
            }
        }

        if (!streams.length) {
            console.error(`cricweb: ${event.slug}: none of ${sources.length} sources is playable (${skipped} skipped)`);
            continue;
        }

        const [first, second] = event.teams as [Team, Team];

        const described = eventFor(`${titleCase(first.name)} vs ${titleCase(second.name)}`, {
            sides: [titleCase(first.name), titleCase(second.name)],
            competition: event.league,
            sport,
            start: event.start
        });

        cards.push({
            id: idFor(`event:${event.slug}`),
            name: described.name,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", sport, ...(event.league && event.league.toLowerCase() !== sport ? [event.league.toLowerCase()] : [])],
            languages: [],
            // Both sides' flags on one tile (the host draws the pair); `logo` is the home side for a host that predates `logos`.
            logo: first.logo,
            ...(first.logo && second.logo ? { logos: [first.logo, second.logo] } : {}),
            event: described.event,
            website: `${WATCH}/watch/${event.slug}`,
            network: SCRAPER_NAME,
            streams
        });
    }

    for (const { channel, sources } of channelPages) {
        if (!sources) continue;

        for (const source of sources) {
            const found = await playable(source);
            if (!found) continue;

            const { name } = channelNameOf(channel.name);
            const stream: ScrapedStream = {
                url: found.url,
                quality: resolutionOf(source.name || channel.name),
                labels: source.name ? [source.name] : [],
                referrer: found.referrer,
                userAgent: found.userAgent,
                ...(found.clearKey ? { clearKey: found.clearKey } : {})
            };

            emit(name || channel.name, "", stream, {
                logo: channel.logo,
                categories: [/sport|cricket|willow|fancode|bein|tnt|ten\b|star/i.test(channel.name) ? "sports" : "general"]
            });
        }
    }

    return { channels: [...cards, ...channels.values()] };
}

// --- the two jobs: build() and buildEvents() ----------------------------------

/*
    The host runs these separately: the channel list changes by the day, the
    fixtures by the minute. Both read the same home page; each then fetches
    only its own watch pages.
*/
const configSchema: ScraperConfigField[] = [
    {
        key: "channelsIntervalMinutes",
        label: "Channels refresh interval (minutes)",
        type: "number",
        default: 360,
        min: 30,
        help: "How often each channel's source list is re-read."
    },
    {
        key: "eventsIntervalMinutes",
        label: "Fixtures refresh interval (minutes)",
        type: "number",
        default: 15,
        min: 5,
        help: "How often the live and upcoming fixtures and their source lists are re-read."
    }
];

async function build(): Promise<ScrapedCatalogue> {
    const { channels } = await fetchAll({ events: false, channels: true });

    return { channels };
}

async function buildEvents(): Promise<ScrapedCatalogue> {
    const { channels } = await fetchAll({ events: true, channels: false });
    const events = channels.filter((c) => c.id.includes(":event:"));
    const ofSport = (sport: Sport): string[] => events.filter((e) => e.categories.includes(sport)).map((e) => e.id);
    const rail = (id: string, heading: string, channelIds: string[]): ScrapedRail[] =>
        channelIds.length ? [{ id, heading, channelIds, group: "Live events" }] : [];

    /*
        "Live Events" is the heading every events scraper here shares (so
        the host merges them into one rail, one card per fixture); "Live
        Cricket" is crichd's and ntvst's; "Live Football" has no twin
        (ntvst's football rail is "Live Soccer").
    */
    return {
        channels: events,
        rails: [
            ...rail("live-events", "Live Events", events.map((e) => e.id)),
            ...rail("live-cricket", "Live Cricket", ofSport("cricket")),
            ...rail("live-football", "Live Football", ofSport("football"))
        ]
    };
}

export const cricwebScraper: Scraper = {
    id: SCRAPER_ID,
    name: SCRAPER_NAME,
    version: "1.5.4",
    configSchema,
    build,
    buildEvents
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/cricweb.mts` -- prints what is on, then fetches each
// distinct playlist once, so a feed going dark shows up here.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const [base, live] = await Promise.all([build(), buildEvents()]);
        const catalogue = { channels: [...live.channels, ...base.channels], rails: live.rails };
        const events = catalogue.channels.filter((c) => c.id.includes(":event:"));
        console.log(
            `${events.length} fixtures, ${catalogue.channels.length - events.length} channels, rails: ${(catalogue.rails || []).map((r) => `${r.heading}(${r.channelIds.length})`).join(", ")}`
        );

        for (const event of events) {
            console.log(`\n${event.name}  [${event.categories.join(", ")}]  logo=${event.logo ? "yes" : "NO"}`);
            for (const s of event.streams) console.log(`  ${s.quality || "-"}  ${s.labels.join(" | ")}  ${s.url.slice(0, 100)}`);
        }
        for (const c of catalogue.channels.filter((c) => !c.id.includes(":event:"))) console.log(`channel: ${c.name} [${c.country || "-"}] x${c.streams.length}`);

        const urls = new Map<string, ScrapedStream>();
        for (const c of catalogue.channels) for (const s of c.streams) urls.set(s.url, s);
        let ok = 0;
        for (const [url, s] of urls) {
            const status = await fetch(url, { headers: { "User-Agent": BROWSER_UA, ...(s.referrer ? { Referer: s.referrer } : {}) }, signal: AbortSignal.timeout(8000) })
                .then(async (r) => `${r.status}${(await r.text()).startsWith("#EXTM3U") ? " M3U" : ""}`)
                .catch(() => "ERR");
            if (status.endsWith("M3U")) ok += 1;
        }
        console.log(`\n${ok}/${urls.size} distinct playlists answer from here`);
    })().catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
