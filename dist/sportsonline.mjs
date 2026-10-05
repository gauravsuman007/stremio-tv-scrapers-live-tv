/**
 * SportsOnline (sportsonline.st; the front keeps changing domain: .si, .st,
 * sportsonliine.click, sportzonline.click) -- a live-sport schedule in plain
 * text and a handful of 24/7 sport channels, every one a small player page.
 *
 *   1. THE LISTS. `GET <front>/prog.txt` is the schedule: weekday headings
 *      (`MONDAY`), a legend of the channel slots under each (`HD1 ENGLISH`,
 *      `BR1 BRAZILIAN`), then `HH:MM   Home x Away | <page url>` lines, one
 *      per mirror. Times are UK time (checked against another source's
 *      fixtures: 19:45 here is 20:45 CEST). The same file names the 24/7 list
 *      (`24/7 CHANNELS <url>`): `NAME - <page url>` lines.
 *   2. THE CHANNEL PAGE (`.../channels/hd/hd1.php`, Referer the front) is a
 *      page with one `<iframe src="https://<host>/e/<id>">`.
 *   3. THE EMBED PAGE holds `window._econfig='...'`, a JSON config hidden in
 *      layers. The page's own `stream.js` (obfuscator.io, devtools detector
 *      and all) undoes it with: base64-decode the whole string; cut it into
 *      four equal parts; in each part drop the 4th character and base64-decode;
 *      put the parts back in the order 2, 0, 3, 1 (part i goes to slot
 *      `[2,0,3,1][i]`); join, base64-decode, `JSON.parse`. Nothing is
 *      evaluated: this is the whole decode. The config's `stream_url_nop2p`
 *      (else `stream_url`) is a signed `.m3u8` on a throwaway host (port 8443)
 *      with plain MPEG-TS segments; its `s`/`e` query is a signature and an
 *      expiry, so it is minted per play.
 *
 * Handles, not URLs: each stream's `url` is `https://sportsonline.invalid/<base64url
 * of the channel page>`, resolved at play time by `resolvers.sportsonline`
 * (the Referer is the embed host, the playlist is checked and its newest
 * segment must start with the TS sync byte -- an offline mirror answers a
 * page without a stream). ffmpeg's own first request to the throwaway host is
 * answered 403 (a TLS fingerprint check; the host's relay retries at TLS 1.2).
 *
 * What returns nothing: a front that no longer serves `prog.txt`; a channel
 * page without an iframe; an embed page without `_econfig` (the layered decode
 * changed -- see `readConfig`); a mirror that is offline.
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
            ...(extra.competitionLogo && /^https?:\/\//i.test(extra.competitionLogo) ? { competitionLogo: extra.competitionLogo } : {}),
            ...(extra.sport ? { sport: extra.sport } : {}),
            ...(extra.start && extra.start > 0 ? { start: extra.start } : {})
        }
    };
}
const SCRAPER_ID = "sportsonline";
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
const FRONTS = ["https://sportsonline.st", "https://sportsonline.si", "https://sportsonline.sx"];
const RESOLVER = "sportsonline";
const HANDLE_HOST = "sportsonline.invalid";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const ZONE = "Europe/London";
const BEFORE_MS = 30 * 60 * 1000;
const AFTER_MS = 6 * 3600_000;
const CONCURRENCY = 6;
const BUDGET_MS = 120_000;
async function get(url, referrer = "", ms = 15_000) {
    return await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(referrer ? { Referer: referrer } : {}) } }), ms);
}
async function text(url, referrer = "") {
    const response = await get(url, referrer);
    if (!response.ok)
        throw new Error(`sportsonline: ${url} answered ${response.status}`);
    return await response.text();
}
// --- handles -----------------------------------------------------------------------
function handleFor(page) {
    return `https://${HANDLE_HOST}/${Buffer.from(page).toString("base64url")}`;
}
function pageFrom(handle) {
    try {
        const url = new URL(handle);
        if (url.hostname !== HANDLE_HOST)
            return null;
        const page = new URL(Buffer.from(url.pathname.slice(1), "base64url").toString());
        return page.protocol === "https:" ? page.href : null;
    }
    catch {
        return null;
    }
}
// --- the embed page ------------------------------------------------------------------
/** `window._econfig='...'` -> the config object, or null. The layers are described in the header. */
function readConfig(html) {
    const blob = /_econfig\s*=\s*'([^']+)'/.exec(html)?.[1];
    if (!blob)
        return null;
    try {
        const decode = (value) => Buffer.from(value, "base64").toString("latin1");
        const whole = decode(blob);
        const size = Math.ceil(whole.length / 4);
        const order = [2, 0, 3, 1];
        const parts = [];
        for (let i = 0; i < 4; i++) {
            const part = whole.slice(i * size, (i + 1) * size);
            parts[order[i]] = decode(part.slice(0, 3) + part.slice(4));
        }
        return JSON.parse(decode(parts.join("")));
    }
    catch {
        return null;
    }
}
/** On air: the newest segment fetches and is MPEG-TS. */
async function onAir(playlist, referrer) {
    try {
        const body = await text(playlist, referrer);
        if (!body.includes("#EXTM3U"))
            return false;
        const lines = (value) => value.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
        const variant = body.includes("#EXT-X-STREAM-INF") ? lines(body)[0] : undefined;
        const variantUrl = variant ? new URL(variant, playlist).href : playlist;
        const media = variant ? await text(variantUrl, referrer) : body;
        const segment = lines(media).pop();
        if (!segment)
            return false;
        const response = await get(new URL(segment, variantUrl).href, referrer);
        const reader = response.body?.getReader();
        const first = await reader?.read();
        await reader?.cancel().catch(() => undefined);
        return response.ok && first?.value?.[0] === 0x47;
    }
    catch {
        return false;
    }
}
async function resolveStream(handle) {
    const page = pageFrom(handle);
    if (!page)
        return null;
    try {
        const front = `${new URL(page).origin}/`;
        const embed = /<iframe[^>]+src=["'](https:\/\/[^"']+)["']/i.exec(await text(page, front))?.[1];
        if (!embed)
            return null;
        const embedOrigin = `${new URL(embed).origin}/`;
        const config = readConfig(await text(embed, front));
        const address = config?.stream_url_nop2p || config?.stream_url;
        if (!address || !/^https:\/\//.test(address) || !(await onAir(address, embedOrigin)))
            return null;
        return { url: address, referrer: embedOrigin, userAgent: BROWSER_UA };
    }
    catch {
        return null;
    }
}
// --- times -------------------------------------------------------------------------
/** The offset (ms) of a zone from UTC at an instant. */
function zoneOffset(at, zone) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric"
    }).formatToParts(new Date(at));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - Math.floor(at / 60_000) * 60_000;
}
/** "2026-10-04T14:45" read as a wall-clock time in a zone -> epoch ms, or NaN. */
function zonedTime(text, zone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text || "");
    if (!m)
        return NaN;
    const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    const first = wall - zoneOffset(wall, zone);
    return wall - zoneOffset(first, zone);
}
const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
/** The UK calendar date ("2026-10-05") of a weekday heading: yesterday or one of the next six days. */
function dateOf(weekday, now) {
    const index = WEEKDAYS.indexOf(weekday);
    if (index < 0)
        return null;
    for (let ahead = -1; ahead <= 5; ahead++) {
        const at = now + ahead * 86_400_000;
        const day = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, weekday: "long" }).format(new Date(at)).toUpperCase();
        if (day === weekday)
            return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
    }
    return null;
}
/** The slot a channel page belongs to: ".../channels/hd/hd1.php" -> "HD1". */
function slotOf(page) {
    return (/\/([a-z0-9]+)\.php/i.exec(page)?.[1] || "").toUpperCase();
}
async function readSchedule(now = Date.now()) {
    let lastError = new Error("sportsonline: no front answered");
    for (const front of FRONTS) {
        try {
            const body = await text(`${front}/prog.txt`);
            if (!/\d\d:\d\d\s+\S[^|]*\|\s*https?:/.test(body))
                continue;
            const rows = [];
            const slots = new Map();
            let date = null;
            let channelList = "";
            for (const raw of body.split(/\r?\n/)) {
                const line = raw.replace(/^\uFEFF/, "").trim();
                const heading = /^([A-Z]{6,9})$/.exec(line)?.[1];
                if (heading && WEEKDAYS.includes(heading)) {
                    date = dateOf(heading, now);
                    continue;
                }
                const list = /^24\/7 CHANNELS\s+(https?:\/\/\S+)/i.exec(line)?.[1];
                if (list && !channelList)
                    channelList = list;
                const slot = /^((?:HD|BR)\d+)\s+([A-Z][A-Z &]*)$/.exec(line);
                if (slot) {
                    slots.set(slot[1], slot[2].trim());
                    continue;
                }
                const row = /^(\d{2}):(\d{2})\s+(.+?)\s*\|\s*(https:\/\/\S+)$/.exec(line);
                if (!row || !date)
                    continue;
                const start = zonedTime(`${date}T${row[1]}:${row[2]}`, ZONE);
                if (Number.isFinite(start))
                    rows.push({ start, title: row[3].replace(/\s+/g, " ").trim(), page: row[4] });
            }
            return { rows, slots, channelList: channelList || `${front}/247.txt`, front };
        }
        catch (cause) {
            lastError = cause;
        }
    }
    throw lastError;
}
function streamFor(page, slots) {
    const slot = slotOf(page);
    const language = slots.get(slot);
    return {
        url: handleFor(page),
        quality: "",
        labels: [slot, ...(language ? [language.toLowerCase().replace(/^./, (c) => c.toUpperCase())] : [])].filter(Boolean),
        referrer: "",
        userAgent: BROWSER_UA,
        resolver: RESOLVER
    };
}
const SPORT_PREFIX = {
    tennis: "tennis", nhl: "hockey", nba: "basketball", nfl: "american football", mlb: "baseball", f1: "motorsport", motogp: "motorsport",
    ufc: "fighting", boxing: "boxing", golf: "golf", rugby: "rugby", cricket: "cricket", volleyball: "volleyball", handball: "handball"
};
/** "NHL: Montreal Canadiens @ Carolinas Hurricanes" -> { sport, competition, fixture } */
function splitTitle(title) {
    const m = /^([^:]{2,40}):\s*(.+)$/.exec(title);
    if (!m)
        return { fixture: title, competition: "", sport: "" };
    const lead = m[1].trim();
    const sport = SPORT_PREFIX[lead.toLowerCase().split(/\s+/)[0]] || "";
    return { fixture: m[2].trim(), competition: lead, sport };
}
// --- the catalogue -------------------------------------------------------------------
async function build() {
    const schedule = await readSchedule();
    const list = await text(schedule.channelList, schedule.front);
    const channels = [];
    const seen = new Set();
    for (const raw of list.split(/\r?\n/)) {
        const m = /^\s*(.+?)\s+-\s+(https:\/\/\S+\.php)\s*$/.exec(raw.replace(/^\uFEFF/, ""));
        if (!m)
            continue;
        const page = m[2];
        const id = idFor(`channel:${slotOf(page).toLowerCase() || m[1].toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
        if (seen.has(id))
            continue;
        seen.add(id);
        const name = m[1].split(/\s+/).map((word) => (word.length > 3 || /^\d/.test(word) ? word[0] + word.slice(1).toLowerCase() : word)).join(" ").replace(/\b(tv|btv)\b/gi, (word) => word.toUpperCase());
        channels.push({
            id,
            name,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports"],
            languages: [],
            logo: "",
            website: schedule.front,
            network: "SportsOnline",
            streams: [{ url: handleFor(page), quality: "", labels: [], referrer: "", userAgent: BROWSER_UA, resolver: RESOLVER }]
        });
    }
    if (!channels.length)
        throw new Error("sportsonline: the 24/7 list was empty");
    return { channels, rails: [] };
}
async function buildEvents() {
    const schedule = await readSchedule();
    const now = Date.now();
    const groups = new Map();
    for (const row of schedule.rows) {
        if (now < row.start - BEFORE_MS || now > row.start + AFTER_MS)
            continue;
        const key = `${row.start}|${row.title.toLowerCase()}`;
        const group = groups.get(key) || { title: row.title, start: row.start, pages: [] };
        if (!group.pages.includes(row.page))
            group.pages.push(row.page);
        groups.set(key, group);
    }
    // Keep only mirrors that are on air: resolve each, a few at a time.
    const checked = new Map();
    const jobs = [...new Set([...groups.values()].flatMap((group) => group.pages))];
    let next = 0;
    const began = Date.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < jobs.length && Date.now() - began < BUDGET_MS) {
            const page = jobs[next++];
            checked.set(page, !!(await resolveStream(handleFor(page))));
        }
    }));
    const channels = [];
    const seen = new Set();
    for (const group of groups.values()) {
        const live = group.pages.filter((page) => checked.get(page));
        const { fixture, competition, sport } = splitTitle(group.title);
        const described = eventFor(fixture, { ...(competition ? { competition } : {}), ...(sport ? { sport } : {}), start: group.start });
        const id = idFor(`event:${group.start}:${described.event.key || fixture.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
        if (!live.length || seen.has(id))
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
            website: schedule.front,
            network: described.event.competition || competition,
            streams: live.map((page) => streamFor(page, schedule.slots))
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
export const sportsonlineScraper = {
    id: SCRAPER_ID,
    name: "SportsOnline",
    version: "1.0.0",
    configSchema,
    resolvers: { [RESOLVER]: resolveStream },
    build,
    buildEvents
};
export { readConfig, readSchedule };
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const [catalogue, events] = await Promise.all([build(), buildEvents()]);
    console.log("channels", catalogue.channels.length, "events", events.channels.length);
    for (const c of [...catalogue.channels.slice(0, 3), ...events.channels.slice(0, 3)])
        console.log(c.name, c.event?.key ?? "", c.streams.length, c.streams[0]?.labels.join("/"));
}
