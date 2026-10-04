/**
 * StreamFree (streamfree.top) -- live NFL, NBA, MLB, NHL, football and other
 * sport, plus a few always-on feeds (NFL RedZone, Sky Sports F1, Willow).
 *
 * THE CHAIN (verified 2026-10-04, plain HTTP, no browser)
 * -------------------------------------------------------
 *   1. `GET https://streamfree.top/api/v1/streams` -- a documented public API
 *      (`/api` is its own docs page) -> `{ count, streams: [{ stream_key,
 *      name, category, league, team1: { name }, team2: { name },
 *      match_timestamp (epoch s), viewers, sources: [ "https://strmfree.st/
 *      embed/<category>/<key><quality><n>" ] }] }`. `sources` is EMPTY until
 *      the event is on air, so a non-empty `sources` is the "live" test. An
 *      entry whose `match_timestamp` is more than a day old is an always-on
 *      feed (RedZone, Sky Sports F1, Willow) and goes to `build()` as a
 *      channel; the rest are events for `buildEvents()`.
 *   2. The same path on `https://streamfree.top/embed/<category>/<key><quality>
 *      <n>` is the player page (the `strmfree.st` host itself answers 403
 *      `Violation` to anything but its own parent). Its inline script holds
 *      `const QUALITY = '1080p'`, `SOURCE_SUFFIX`, `VARIANT = '<key>' +
 *      QUALITY + SOURCE_SUFFIX` and `const _0x = { "1080p": { _e, _n, _t }, ... }`,
 *      a per-page signed token (about 8 hours) per quality.
 *   3. The stream is `https://streamfree.top/live/<VARIANT>/index.m3u8?_t=<_t>&
 *      _e=<_e>&_n=<_n>` (or `/live-cdn/...` when `/get-stream-key/<key>`
 *      names another server). It needs `Referer: https://streamfree.top/`
 *      (403 without) and the token; the segments (`<n>.js`, really MPEG-TS) are
 *      relative and need the Referer only.
 *
 * The token expires, so each stream's `url` is a HANDLE
 * (`https://streamfree.invalid/<embed path>`) resolved at play time by
 * `resolvers.streamfree`: it reads the player page and builds the address
 * above. Needs live-tv >= 1.6.0 (resolvers).
 *
 * What returns nothing: a feed whose `sources` is empty (not on air), a player
 * page whose `VARIANT`/`_0x` shape has changed (the resolver answers null, never
 * guesses), a playlist that does not answer.
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
 * The card's `event` and display name. `key` is what the host merges on: the
 * sides' identities, sorted (so order does not matter), or for an event with
 * no opponents its folded title without the year. Two sources that compute
 * the same key for an event are the same event -- the host compares nothing else
 * but the start time. `keys` are further keys the same event goes by (a
 * name with its trailing words dropped), for a source that spells a team
 * shorter: two cards are one event when ANY of their keys is shared.
 */
function eventFor(title, extra = {}) {
    const fixture = extra.sides && extra.sides.length >= 2 ? { sides: extra.sides, competition: "" } : readFixture(title);
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
const SCRAPER_ID = "streamfree";
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
const BASE = "https://streamfree.top";
const REFERRER = `${BASE}/`;
const RESOLVER = "streamfree";
const HANDLE_HOST = "streamfree.invalid";
/** An entry this long after its match_timestamp is a standing feed, not an event. */
const STANDING_MS = 24 * 3600_000;
/** Offered from this long before kick-off. */
const BEFORE_MS = 30 * 60 * 1000;
async function getText(url, ms = 15_000) {
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": "Mozilla/5.0" } }), ms);
    if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
    return await response.text();
}
/** "/embed/<category>/<key><quality><n>" of an embed address, or "". */
function embedPath(source) {
    const m = /^https?:\/\/[a-z0-9.-]+\/embed\/([a-z0-9-]+\/[A-Za-z0-9._-]+)$/i.exec(source);
    return m ? m[1] : "";
}
/** "1080p" or "720p2" from the tail of the embed key, for the quality label. */
function qualityOf(path) {
    const m = /(\d{3,4}p)(\d?)$/.exec(path);
    return { quality: m?.[1] || "", label: m?.[2] ? `Source ${m[2]}` : "" };
}
function streamsOf(entry) {
    const out = [];
    for (const source of entry.sources || []) {
        const path = embedPath(source);
        if (!path)
            continue;
        const { quality, label } = qualityOf(path);
        out.push({ url: `https://${HANDLE_HOST}/${path}`, quality, labels: label ? [label] : [], referrer: REFERRER, userAgent: "", resolver: RESOLVER });
    }
    return out;
}
function thumbnail(entry) {
    return entry.thumbnail_url ? new URL(entry.thumbnail_url, BASE).href : "";
}
async function fetchEntries() {
    const response = await withTimeout((signal) => fetch(`${BASE}/api/v1/streams`, { signal, headers: { "User-Agent": "Mozilla/5.0" } }));
    if (!response.ok)
        throw new Error(`streamfree: /api/v1/streams -> ${response.status}`);
    const body = (await response.json());
    return (body.streams || []).filter((entry) => entry.stream_key && entry.name && streamsOf(entry).length);
}
function isStanding(entry, now) {
    return !entry.match_timestamp || entry.match_timestamp * 1000 < now - STANDING_MS;
}
function categoryOf(entry) {
    return (entry.category || "").toLowerCase();
}
async function build() {
    const now = Date.now();
    const channels = [];
    for (const entry of await fetchEntries()) {
        if (!isStanding(entry, now))
            continue;
        channels.push({
            id: idFor(`feed:${entry.stream_key}`),
            name: entry.name.trim(),
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", categoryOf(entry)].filter(Boolean),
            languages: [],
            logo: thumbnail(entry),
            website: `${BASE}/player/${encodeURIComponent(entry.category || "")}/${encodeURIComponent(entry.stream_key)}`,
            network: entry.league || "",
            streams: streamsOf(entry)
        });
    }
    return { channels };
}
async function buildEvents() {
    const now = Date.now();
    const channels = [];
    for (const entry of await fetchEntries()) {
        if (isStanding(entry, now) || entry.match_timestamp * 1000 - BEFORE_MS > now)
            continue;
        const sides = [entry.team1?.name, entry.team2?.name].map((side) => (side || "").trim()).filter(Boolean);
        const described = eventFor(entry.name.trim(), {
            ...(sides.length === 2 ? { sides } : {}),
            competition: entry.league || "",
            sport: categoryOf(entry),
            start: entry.match_timestamp * 1000
        });
        channels.push({
            id: idFor(`event:${entry.stream_key}`),
            name: described.name,
            event: described.event,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", categoryOf(entry)].filter(Boolean),
            languages: [],
            logo: thumbnail(entry),
            website: `${BASE}/player/${encodeURIComponent(entry.category || "")}/${encodeURIComponent(entry.stream_key)}`,
            network: described.event.competition || entry.league || "",
            streams: streamsOf(entry)
        });
    }
    return {
        channels,
        rails: channels.length ? [{ id: "live-events", heading: "Live Events", channelIds: channels.map((c) => c.id), group: "Live events" }] : []
    };
}
/** Handle -> the address as it is this second: read the player page, build the playlist URL with its token. */
async function resolveStream(handle) {
    let url;
    try {
        url = new URL(handle);
    }
    catch {
        return null;
    }
    const path = url.pathname.replace(/^\//, "");
    if (url.hostname !== HANDLE_HOST || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/i.test(path))
        return null;
    let page;
    try {
        page = await getText(`${BASE}/embed/${path}`);
    }
    catch {
        return null;
    }
    const quality = /const QUALITY = '([^']*)'/.exec(page)?.[1];
    const suffix = /const SOURCE_SUFFIX = '([^']*)'/.exec(page)?.[1] ?? "";
    const key = /const VARIANT = '([^']+)'/.exec(page)?.[1];
    const tokens = /const _0x = (\{[^;]*\});/.exec(page)?.[1];
    if (!quality || !key || !tokens)
        return null;
    let token;
    try {
        token = JSON.parse(tokens)[quality];
    }
    catch {
        return null;
    }
    if (!token?._t || !token._e || !token._n)
        return null;
    const stream = path.split("/")[1].replace(/(\d{3,4}p)\d?$/, "");
    let route = "live";
    try {
        const info = JSON.parse(await getText(`${BASE}/get-stream-key/${encodeURIComponent(stream)}`));
        if (info.server_name && info.server_name !== "origin")
            route = "live-cdn";
    }
    catch {
        /* origin */
    }
    const variant = `${key}${quality}${suffix}`;
    const address = `${BASE}/${route}/${variant}/index.m3u8?_t=${encodeURIComponent(token._t)}&_e=${token._e}&_n=${token._n}`;
    try {
        const response = await withTimeout((signal) => fetch(address, { signal, headers: { "User-Agent": "Mozilla/5.0", Referer: REFERRER } }), 10_000);
        const text = await response.text();
        if (!response.ok || !text.includes("#EXTM3U"))
            return null;
    }
    catch {
        return null;
    }
    return { url: address, referrer: REFERRER, userAgent: "" };
}
const configSchema = [
    {
        key: "channelsIntervalMinutes",
        label: "Channels refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 30,
        help: "How often the always-on feeds (RedZone, Sky Sports F1, Willow) are re-read."
    },
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 15,
        min: 5,
        help: "How often the live events are re-read. Each stream is resolved when someone plays it."
    }
];
export const streamfreeScraper = {
    id: SCRAPER_ID,
    name: "StreamFree",
    version: "1.0.0",
    configSchema,
    resolvers: { [RESOLVER]: resolveStream },
    build,
    buildEvents
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/streamfree.mts` -- prints the feeds and events, and
// resolves the first stream.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    Promise.all([build(), buildEvents()])
        .then(async ([feeds, events]) => {
        console.log(`${feeds.channels.length} feeds, ${events.channels.length} events: ${events.channels.map((c) => c.name).join("; ")}`);
        const first = events.channels[0] || feeds.channels[0];
        console.log(first || "(none)");
        if (first?.streams[0])
            console.log(await resolveStream(first.streams[0].url));
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
