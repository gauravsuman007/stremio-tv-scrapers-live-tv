/**
 * Pitsport (pitsport.st) -- live football (Nations League, club games), US
 * sport (NFL/NBA/MLB/NHL), NASCAR, F1 and other motorsport, boxing/UFC.
 * Events only: the site has no 24/7 channels.
 *
 * THE CHAIN (verified 2026-10-04, plain HTTP, no browser)
 * -------------------------------------------------------
 *   1. `GET https://pitsport.st/api/v1/live-now` -> `{ data: { live: [...],
 *      upcoming: [...] } }`. A live entry: `{ programId, titleText, title:
 *      [{ text, flag }], footer (the competition), sessionStart (epoch s),
 *      competitionSlug, liveState: "live" }`. `title` has one entry per side.
 *   2. `GET /api/v1/programs/<programId>/play` -> `{ data: { program,
 *      video, videos: [{ embedUrl: "https://embdlol.st/embed/<uuid>", label,
 *      isDefault }] } }`. Every video is one mirror of the event.
 *   3. `POST https://api.embdlol.st/watch` with `{"watchId": "<uuid>"}` (JSON)
 *      -> `{ channel: { channelname, channelCode }, url, "hmk-token" }`, where
 *      `url` = `https://prod-eN.tonzoidio.st/hmk/<token>/out/v1/channel(<code>)
 *      /index.m3u8`. The token is IN THE PATH, issued per call, and the
 *      playlist, its variants (`/hmk/<fresh token>/.../tracks-v0a0/mono.ts.
 *      m3u8`) and segments need NO header at all: no Referer, no Origin, no
 *      `hmk-token` header. (An earlier note here said the URL 403'd with the
 *      token as a header and that a final gate was unidentified -- there is
 *      none; the page just never needed more than this POST.)
 *   4. The variant lists `https://p16-common-sign.tiktokcdn.com/...~tplv-
 *      tiktokx-origin.image` segments: WebP images with the MPEG-TS inside
 *      (1080p H.264 + AAC), the same disguise as streamed.mts / ppv.mts,
 *      handled by the same `webpexif` decoder.
 *
 * The token is minted per call and the segments are signed with an expiry, so
 * each stream's `url` is a HANDLE (`https://pitsport.invalid/<embed uuid>`)
 * resolved at play time by `resolvers.pitsport`. Needs live-tv >= 1.6.0 (the
 * resolver; no TLS 1.2 retry is needed, TikTok's CDN accepts Node). `onAir` (copied from streamed.mts) answers null for a
 * feed whose newest segment is gone.
 *
 * What returns nothing: `/watch` answering anything but 200 with a `url`, a
 * program with no `videos`, a feed that is listed live but not on air.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
import { request } from "node:https";
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
// -------------------------------------------------------------------------
// The scraper
// -------------------------------------------------------------------------
const SCRAPER_ID = "pitsport";
const DECODER = "webpexif";
const RESOLVER = "pitsport";
const SITE = "https://pitsport.st";
const WATCH = "https://api.embdlol.st/watch";
const HANDLE_HOST = "pitsport.invalid";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
/** `live:<scraper id>:<whatever>` -- the id space every non-built-in scraper must use. */
function idFor(rawId) {
    return `live:${SCRAPER_ID}:${rawId}`;
}
async function withTimeout(work, ms = 15_000) {
    const controller = new AbortController();
    // Not cleared on success: the body read that follows is still tied to this signal.
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
async function getJson(url) {
    return withTimeout(async (signal) => {
        const response = await fetch(url, { signal, headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
        if (!response.ok)
            throw new Error(`${url} -> ${response.status}`);
        return (await response.json());
    });
}
// ---- the handshake -------------------------------------------------------
async function resolveStream(handle) {
    let url;
    try {
        url = new URL(handle);
    }
    catch {
        return null;
    }
    if (url.host !== HANDLE_HOST)
        return null;
    const watchId = decodeURIComponent(url.pathname.slice(1));
    if (!/^[0-9a-f-]{36}$/i.test(watchId))
        return null;
    const answer = await withTimeout(async (signal) => {
        const response = await fetch(WATCH, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
            body: JSON.stringify({ watchId })
        });
        return response.ok ? (await response.json()) : null;
    }).catch(() => null);
    const playlist = answer?.url;
    if (!playlist || !/^https:\/\/[a-z0-9.-]+\/hmk\/[0-9a-f]+\/out\/.+\.m3u8$/i.test(playlist))
        return null;
    if (!(await onAir(playlist, "")))
        return null;
    return { url: playlist, referrer: "", userAgent: "" };
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
// ---- the segment disguise -----------------------------------------------
/** 0x47 every 188 bytes from `at`, three times over. */
function syncedAt(view, at) {
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
export function unwrapSegment(segment) {
    const view = Buffer.from(segment.buffer, segment.byteOffset, segment.length);
    if (syncedAt(view, 0))
        return segment;
    if (view.length < 20 || view.toString("latin1", 0, 4) !== "RIFF" || view.toString("latin1", 8, 12) !== "WEBP") {
        throw new Error("neither MPEG-TS nor a WebP");
    }
    let at = 12;
    while (at + 8 <= view.length) {
        if (syncedAt(view, at))
            return view.subarray(at);
        const type = view.toString("latin1", at, at + 4);
        const size = view.readUInt32LE(at + 4);
        if (type === "EXIF") {
            const body = view.subarray(at + 8, Math.min(view.length, at + 8 + size));
            if (body[0] !== 0x47)
                throw new Error("EXIF chunk is not MPEG-TS");
            return body;
        }
        at += 8 + size + (size & 1);
    }
    throw new Error("no MPEG-TS inside the WebP");
}
function https(url) {
    return url ? url.replace(/^http:\/\//, "https://") : "";
}
/** The sport, from the competition's name, for the few the host's merge or the rails care about. */
function sportOf(competition) {
    if (/\b(?:nfl|ncaa|cfl|college football)\b/i.test(competition))
        return "american football";
    if (/\b(?:mlb|baseball)\b/i.test(competition))
        return "baseball";
    if (/\b(?:nba|wnba|basketball|euroleague)\b/i.test(competition))
        return "basketball";
    if (/\b(?:nhl|ice hockey)\b/i.test(competition))
        return "ice hockey";
    if (/\b(?:nascar|formula|f1|motogp|indycar|rally|supercars|motorsport)\b/i.test(competition))
        return "motorsport";
    if (/\b(?:ufc|boxing|mma|bellator|pfl)\b/i.test(competition))
        return "mma";
    if (/\b(?:uefa|league|cup|liga|serie|bundesliga|premier|fifa|mls|football|soccer)\b/i.test(competition))
        return "football";
    return "";
}
function handleFor(uuid) {
    return `https://${HANDLE_HOST}/${encodeURIComponent(uuid)}`;
}
async function fetchEvents() {
    const body = await getJson(`${SITE}/api/v1/live-now`);
    if (!Array.isArray(body.data?.live))
        throw new Error("pitsport: the live list is not in the expected shape");
    const live = body.data.live.filter((entry) => entry.programId && entry.titleText && (!entry.liveState || entry.liveState === "live"));
    const mirrors = await Promise.all(live.map((entry) => getJson(`${SITE}/api/v1/programs/${entry.programId}/play`)
        .then((answer) => answer.data?.videos || [])
        .catch(() => [])));
    const channels = [];
    live.forEach((entry, index) => {
        const streams = [];
        for (const video of mirrors[index] || []) {
            const uuid = /\/embed\/([0-9a-f-]{36})/i.exec(video.embedUrl || "")?.[1];
            if (!uuid)
                continue;
            streams.push({
                url: handleFor(uuid),
                quality: video.label || (video.isDefault ? "Main" : `Mirror ${streams.length + 1}`),
                labels: [],
                referrer: "",
                userAgent: "",
                resolver: RESOLVER,
                decoder: DECODER
            });
        }
        if (!streams.length)
            return;
        const competition = (entry.footer || "").trim();
        const named = (entry.title || []).map((side) => (side.text || "").trim()).filter(Boolean);
        const described = eventFor(entry.titleText.trim(), {
            ...(named.length >= 2 ? { sides: named } : {}),
            ...(competition ? { competition } : {}),
            ...(sportOf(competition) ? { sport: sportOf(competition) } : {}),
            ...(entry.sessionStart && entry.sessionStart > 0 ? { start: entry.sessionStart * 1000 } : {})
        });
        channels.push({
            id: idFor(String(entry.programId)),
            name: described.name,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", ...(sportOf(competition) ? [sportOf(competition).replace(/ /g, "-")] : [])],
            languages: [],
            logo: https(entry.logo) || https(entry.background),
            event: described.event,
            website: `${SITE}/programs/${entry.programId}`,
            network: "",
            streams
        });
    });
    if (!channels.length && live.length)
        throw new Error("pitsport: no live program had a stream");
    return {
        channels,
        rails: channels.length ? [{ id: "live-events", heading: "Live Events", channelIds: channels.map((channel) => channel.id), group: "Live events" }] : []
    };
}
const configSchema = [
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 15,
        min: 5,
        help: "How often the list of live events is re-read. Each stream is resolved when someone plays it, not here."
    }
];
/*
    EVENTS ONLY: this source has no channel list, so `build()` is empty and
    `buildEvents()` is the whole scraper.
*/
async function build() {
    return { channels: [] };
}
function buildEvents() {
    return fetchEvents();
}
export const pitsportScraper = {
    id: SCRAPER_ID,
    name: "Pitsport",
    version: "1.0.3",
    configSchema,
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    resolvers: { [RESOLVER]: resolveStream },
    build,
    buildEvents
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/pitsport.mts` -- prints the events, the first one, and
// resolves its first stream.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    buildEvents()
        .then(async (catalogue) => {
        console.log(`${catalogue.channels.length} events: ${catalogue.channels.map((channel) => channel.name).join("; ")}`);
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
