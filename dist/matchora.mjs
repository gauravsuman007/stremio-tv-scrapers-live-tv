/**
 * Matchora (matchora.pro, also matchora.to / matchora.link) -- a sports-TV
 * index: about 1,600 broadcaster channels from many countries and the
 * fixtures they show, in a documented, key-free JSON API.
 *
 *   1. THE LISTS (documented at `/developers`, plain JSON):
 *      `GET /api/v1/channels` -> `{ channels: [{ name, countries, quality,
 *      featured, feeds: [{ label, country, quality, embed_url }] }] }` (a feed's
 *      `embed_url` ends in its id), `GET /api/v1/live` -> `{ events: [{ id, home,
 *      away, league, sport, kickoff (epoch seconds), live, channels: [{ id,
 *      name, country (a flag), quality, lang, dead, embed_url }] }] }`,
 *      `GET /api/v1/schedule?watchable=1` the same for the day's fixtures.
 *   2. THE STREAM. The page's own player asks `GET /api/play/<feed id>`
 *      (Referer `https://matchora.pro/`), which starts the feed on demand:
 *      `{ ready: false, reason: "warming" }` until it is up, then `{ ready: true,
 *      url: "https://edge.matchora.pro/hls/<id>/index.m3u8?t=<token>",
 *      expires_in: 600 }`. The token is `base64(id|expiry|nonce|)` plus a
 *      signature and is minted per request; each segment name carries its own
 *      `?t=`. Plain MPEG-TS. Nothing is evaluated.
 *
 * NOTE: the site's developer page says direct stream URLs are not part of its
 * public API and asks that its player (which carries its advertising) be
 * used. This scraper uses the lists as documented and the player's own
 * `/api/play` call only when someone plays a channel (never at build time), at
 * most one call per play and a few polls while a feed warms up (the API answers
 * `reason: "limit"` per IP when hit hard).
 *
 * Handles, not URLs: each stream's `url` is `https://matchora.invalid/<feed
 * id>`, resolved at play time by `resolvers.matchora` (poll `/api/play` for up
 * to ~20 s, then check the playlist). A feed that never gets ready resolves to
 * `null`.
 *
 * 24/7 CHANNELS: none. `/api/v1/channels` lists 2,746 feeds of 1,630 channels, but
 * a feed only starts for a match on that broadcaster (sampled 2026-10-05: 12 of 24
 * answered `ready`, the rest `dead` or `warming` forever; of the "featured"
 * pay broadcasters nearly all were off air), so `build()` returns no channels and
 * only the live and imminent fixtures (`buildEvents`) are listed, from the feeds
 * the fixture itself names and has not marked `dead`.
 *
 * What returns nothing: a feed that stays "warming" (its source is off air),
 * an `/api/play` answer without `ready` or `url`, a changed Referer rule.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
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
            ...(extra.sport ? { sport: extra.sport } : {}),
            ...(extra.start && extra.start > 0 ? { start: extra.start } : {})
        }
    };
}
const SCRAPER_ID = "matchora";
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
const API = "https://matchora.pro/api";
const SITE = "https://matchora.pro/";
const RESOLVER = "matchora";
const HANDLE_HOST = "matchora.invalid";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const BEFORE_MS = 20 * 60 * 1000;
const WARM_POLLS = 8;
const WARM_GAP_MS = 2500;
const CHECK_POLLS = 2;
const CHECK_CONCURRENCY = 4;
const CHECK_BUDGET_MS = 90_000;
const FEEDS_PER_FIXTURE = 8;
async function get(url, ms = 15_000) {
    return await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, Referer: SITE, Origin: SITE.slice(0, -1) } }), ms);
}
async function getJson(path) {
    const response = await get(`${API}/${path}`);
    if (!response.ok)
        throw new Error(`matchora: ${path} answered ${response.status}`);
    return (await response.json());
}
// --- handles -----------------------------------------------------------------------
function handleFor(feedId) {
    return `https://${HANDLE_HOST}/${feedId}`;
}
function feedFrom(handle) {
    try {
        const url = new URL(handle);
        const id = url.pathname.slice(1);
        return url.hostname === HANDLE_HOST && /^\d{1,12}$/.test(id) ? id : null;
    }
    catch {
        return null;
    }
}
/** Start the feed and wait for it: `/api/play/<id>` says `warming` until it is up. */
async function resolveWith(handle, polls) {
    const id = feedFrom(handle);
    if (!id)
        return null;
    try {
        for (let poll = 0; poll < polls; poll++) {
            const response = await get(`${API}/play/${id}`);
            if (!response.ok)
                return null;
            const body = (await response.json());
            if (body.ready && body.url && /^https:\/\/[^/]*matchora\.pro\//.test(body.url)) {
                const playlist = await get(body.url);
                if (!playlist.ok || !(await playlist.text()).includes("#EXTM3U"))
                    return null;
                return { url: body.url, referrer: SITE, userAgent: BROWSER_UA };
            }
            if (body.reason && body.reason !== "warming")
                return null;
            await new Promise((resolve) => setTimeout(resolve, WARM_GAP_MS));
        }
        return null;
    }
    catch {
        return null;
    }
}
async function resolveStream(handle) {
    return await resolveWith(handle, WARM_POLLS);
}
function feedIdOf(embedUrl) {
    const id = /\/embed\/channel\/(\d{1,12})\b/.exec(embedUrl || "")?.[1];
    return id || null;
}
const SPORT_NAMES = {
    soccer: "football", "american football": "american football", "ice hockey": "hockey", "motorsport": "motorsport", "mixed martial arts": "fighting"
};
/** No 24/7 channels: a feed only starts for a match that is on (see the header), so the channel list is empty. */
async function build() {
    return { channels: [], rails: [] };
}
async function buildEvents() {
    const [live, soon] = await Promise.all([
        getJson("v1/live"),
        getJson("v1/schedule?watchable=1").catch(() => ({ events: [] }))
    ]);
    const now = Date.now();
    const fixtures = new Map();
    for (const fixture of [...(live.events || []), ...(soon.events || [])]) {
        const start = (fixture.kickoff || 0) * 1000;
        const inWindow = fixture.live || (start > 0 && now >= start - BEFORE_MS && now <= start + 4 * 3600_000);
        if (fixture.id && !fixture.finished && inWindow && !fixtures.has(fixture.id))
            fixtures.set(fixture.id, fixture);
    }
    // Keep only feeds that are on air: start each (a few at a time, a short warm-up) and see whether it answers.
    const on = new Map();
    const jobs = [...fixtures.values()].flatMap((fixture) => (fixture.channels || []).filter((channel) => !channel.dead).slice(0, FEEDS_PER_FIXTURE)
        .map((channel) => feedIdOf(channel.embed_url)).filter((id) => !!id).map(handleFor));
    let next = 0;
    const began = Date.now();
    await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, async () => {
        while (next < jobs.length && Date.now() - began < CHECK_BUDGET_MS) {
            const handle = jobs[next++];
            on.set(handle, !!(await resolveWith(handle, CHECK_POLLS)));
        }
    }));
    const channels = [];
    const seen = new Set();
    for (const [fixtureId, fixture] of fixtures) {
        const feeds = (fixture.channels || []).filter((channel) => !channel.dead && feedIdOf(channel.embed_url) && on.get(handleFor(feedIdOf(channel.embed_url))));
        const sides = [fixture.home, fixture.away].map((side) => (side || "").trim()).filter(Boolean);
        if (!feeds.length || sides.length < 2)
            continue;
        const sport = SPORT_NAMES[(fixture.sport || "").toLowerCase()] || (fixture.sport || "").toLowerCase();
        const start = (fixture.kickoff || 0) * 1000;
        const described = eventFor(sides.join(" vs "), {
            sides,
            ...(fixture.league ? { competition: fixture.league } : {}),
            ...(sport ? { sport } : {}),
            ...(start > 0 ? { start } : {})
        });
        const id = idFor(`event:${fixtureId}`);
        if (seen.has(id))
            continue;
        seen.add(id);
        channels.push({
            id,
            name: described.name,
            event: described.event,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", ...(sport ? [sport] : [])],
            languages: [],
            logo: "",
            website: SITE,
            network: fixture.league || "",
            streams: feeds.map((channel) => ({
                url: handleFor(feedIdOf(channel.embed_url)),
                quality: channel.quality || "",
                labels: [channel.name || "", channel.lang || ""].filter(Boolean),
                referrer: "",
                userAgent: BROWSER_UA,
                resolver: RESOLVER
            }))
        });
    }
    return {
        channels,
        rails: channels.length ? [{ id: "live-events", heading: "Live Events", channelIds: channels.map((c) => c.id), group: "Live events" }] : []
    };
}
const configSchema = [
    {
        key: "channelsIntervalMinutes",
        label: "Channels refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 60,
        help: "How often the channel list is re-read. A channel is started when someone plays it."
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
export const matchoraScraper = {
    id: SCRAPER_ID,
    name: "Matchora",
    version: "1.0.0",
    configSchema,
    resolvers: { [RESOLVER]: resolveStream },
    build,
    buildEvents
};
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const [catalogue, events] = await Promise.all([build(), buildEvents()]);
    console.log("channels", catalogue.channels.length, "events", events.channels.length);
    for (const c of [...catalogue.channels.slice(0, 3), ...events.channels.slice(0, 3)])
        console.log(c.name, c.event?.key ?? "", c.streams.length, c.streams[0]?.labels.join("/"));
}
