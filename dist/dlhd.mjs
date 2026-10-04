/**
 * DaddyLive (dlhd.st, currently served from dlive.sx) -- about 900 24/7
 * channels and a daily sports schedule, all on ONE backend whose video
 * arrives disguised as PNG images. This is the first scraper here that
 * needs the scraper contract's segment `decoders`; it was rejected before
 * that existed (see SOURCES.md and ntvst.mts's old `dlhd` note).
 *
 * THE CHANNELS
 *   `/24-7-channels.php` is a plain list of `<a href="/watch.php?id=N">`
 *   cards, the channel's name in `.card__title`. Every channel's player
 *   (`daddyliveplayer.st/premiumtv/daddy.php?id=N`, ~650KB of HTML) holds
 *   one line that matters, `const SRC = "https://edge.<host>/premiumN/
 *   index.m3u8"`, and the edge host is the same for every id (verified
 *   2026-10-01 across ids, with and without a Referer, which it does not
 *   need). So ONE player page is fetched per build to learn the current
 *   edge host, and every channel's URL is built from it -- 900 fetches of
 *   650KB each would be half a gigabyte to learn the same hostname 900
 *   times. The edge host rotates now and then; the twelve-hourly rebuild
 *   picks the new one up.
 *
 *   Names carry their country as a trailing word ("ABC USA", "Star Sports
 *   1 IN", "Canal+ Sport Poland"). That word is moved into `country`, so
 *   "ABC" + US merges with iptv-org's ABC instead of sitting beside it as
 *   a second card. Names with no country word keep `country` empty.
 *
 * THE EVENTS
 *   The home page's `#schedule` lists today's events (UK time), each with
 *   the channel ids carrying it -- often event-only ids above the 24/7
 *   range. Every event starting between three hours ago and two hours from
 *   now becomes one card on the shared "Live Events" rail (same heading as
 *   ntvst/zlive/futbolx, so the rails merge), refreshed hourly by the
 *   `events` task.
 *
 * THE DISGUISE (the `tiktikpx` decoder)
 *   The playlist itself is ordinary HLS. Each segment it lists is a real
 *   PNG on a TikTok image CDN. Decoded exactly as daddyliveplayer.st's own
 *   `unwrap()`/`pngRGB()` do (plain JS, no WASM, no anti-tamper): inflate
 *   the PNG's IDAT stream, undo the per-row PNG filters into RGB, and the
 *   first eight bytes of pixel data read `TIKTIKPX`; the next four are a
 *   big-endian length, followed by that many bytes of gzip whose contents
 *   are the MPEG-TS. The player also accepts two older layouts (TS after
 *   IEND, TS in a WebP EXIF chunk) and raw/`TIKTIKRAW`/`TIKTIKTSGZ`-tagged
 *   bodies; all are handled here too, because the site switches between
 *   them without notice. Verified 2026-10-01 on a live segment: 1.43MB
 *   PNG in, 1.51MB of TS out, sync byte on every 188-byte packet.
 *
 *   The decoding runs inside live-tv, on every segment, via its relay. On a
 *   host without segment decoders these streams are dropped rather than
 *   offered -- see the template.
 */
import { gunzipSync, inflateSync } from "node:zlib";
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
const SCRAPER_ID = "dlhd";
function idFor(rawId) {
    return `live:${SCRAPER_ID}:${rawId}`;
}
async function withTimeout(work, ms = 20_000) {
    const controller = new AbortController();
    // Deliberately NOT cleared once `work` resolves: `fetch()` resolves on
    // headers, and the body read that follows is still tied to this
    // signal -- clearing the timer here would leave a stalled body able to
    // hang build() forever. `unref()` keeps the timer from holding the
    // process open.
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
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
//: dlhd.st redirects here; tried in order, so a domain move costs one
//: failed request rather than the whole build.
const SITES = ["https://dlhd.st", "https://dlive.sx"];
const PLAYER = "https://daddyliveplayer.st/premiumtv/daddy.php?id=";
const DECODER = "tiktikpx";
async function getText(url, referrer = "") {
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...(referrer ? { Referer: referrer } : {}) } }));
    if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
    return { text: await response.text(), url: response.url };
}
async function fromSite(path) {
    let last = null;
    for (const site of SITES) {
        try {
            const got = await getText(`${site}${path}`);
            return { text: got.text, base: new URL(got.url).origin };
        }
        catch (cause) {
            last = cause;
        }
    }
    throw last instanceof Error ? last : new Error(`dlhd: ${path} unreachable`);
}
function decodeEntities(text) {
    return text
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}
/** A trailing word in a channel name, as the site writes it, and the
 *  country it means. iptv-org's codes, so "UK" not "GB". */
const COUNTRY_WORDS = {
    USA: ["US", "United States"],
    US: ["US", "United States"],
    UK: ["UK", "United Kingdom"],
    Poland: ["PL", "Poland"],
    Italy: ["IT", "Italy"],
    France: ["FR", "France"],
    CZ: ["CZ", "Czechia"],
    DE: ["DE", "Germany"],
    Germany: ["DE", "Germany"],
    Spain: ["ES", "Spain"],
    Portugal: ["PT", "Portugal"],
    Israel: ["IL", "Israel"],
    Bulgaria: ["BG", "Bulgaria"],
    SK: ["SK", "Slovakia"],
    Denmark: ["DK", "Denmark"],
    Serbia: ["RS", "Serbia"],
    MX: ["MX", "Mexico"],
    Mexico: ["MX", "Mexico"],
    Greece: ["GR", "Greece"],
    Croatia: ["HR", "Croatia"],
    Turkey: ["TR", "Turkey"],
    NL: ["NL", "Netherlands"],
    Netherland: ["NL", "Netherlands"],
    Netherlands: ["NL", "Netherlands"],
    Brasil: ["BR", "Brazil"],
    Brazil: ["BR", "Brazil"],
    CA: ["CA", "Canada"],
    Canada: ["CA", "Canada"],
    NZ: ["NZ", "New Zealand"],
    Argentina: ["AR", "Argentina"],
    Romania: ["RO", "Romania"],
    Cyprus: ["CY", "Cyprus"],
    UAE: ["AE", "United Arab Emirates"],
    AU: ["AU", "Australia"],
    Australia: ["AU", "Australia"],
    Russia: ["RU", "Russia"],
    Malaysia: ["MY", "Malaysia"],
    Sweden: ["SE", "Sweden"],
    PK: ["PK", "Pakistan"],
    Norway: ["NO", "Norway"],
    IN: ["IN", "India"],
    India: ["IN", "India"],
    Ireland: ["IE", "Ireland"],
    Belgium: ["BE", "Belgium"],
    Austria: ["AT", "Austria"],
    Hungary: ["HU", "Hungary"],
    Slovenia: ["SI", "Slovenia"],
    Finland: ["FI", "Finland"],
    Chile: ["CL", "Chile"],
    Colombia: ["CO", "Colombia"],
    Peru: ["PE", "Peru"],
    SA: ["ZA", "South Africa"],
    Qatar: ["QA", "Qatar"]
};
function flagOf(code) {
    const iso = code === "UK" ? "GB" : code;
    if (!/^[A-Z]{2}$/.test(iso))
        return "";
    return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
/** "Star Sports 1 IN" -> name "Star Sports 1", country IN. */
function splitCountry(raw) {
    const match = /^(.*\S)\s+\(?([A-Za-z]+)\)?$/.exec(raw);
    const word = match?.[2];
    const known = word ? COUNTRY_WORDS[word] : undefined;
    if (match && known)
        return { name: match[1], country: known[0], countryName: known[1] };
    return { name: raw, country: "", countryName: "" };
}
/** Categories from the name alone -- this site gives none. Unrecognised
 *  is fine: live-tv files it under General. */
function categoriesOf(name) {
    const n = name.toLowerCase();
    const out = [];
    if (/sport|espn|bein|dazn|tnt sports|eurosport|golf|nba|nfl|nhl|mlb|tennis|cricket|racing|f1|motor|fight|wwe|ufc|fox soccer|premier|laliga|ligue|bundesliga|sky sports|arena|eleven|polsat sport|canal\+ sport|setanta|supersport|sportsnet|tsn/.test(n))
        out.push("sports");
    if (/\bnews\b|cnn|msnbc|cnbc|bloomberg|fox business|sky news|al jazeera|euronews/.test(n))
        out.push("news");
    if (/cartoon|nick|disney|boomerang|baby|kids|junior|jr\b/.test(n))
        out.push("kids");
    if (/movie|cinema|film|hbo|starz|showtime|cinemax|mgm|amc|tcm|paramount|epix/.test(n))
        out.push("movies");
    if (/music|mtv|vh1|bet\b/.test(n) && !out.includes("kids"))
        out.push("music");
    if (/discovery|history|national geographic|nat geo|animal planet|science|documentary|smithsonian/.test(n))
        out.push("documentary");
    return out;
}
/** The current edge host, learnt from one channel's player page. */
async function edgeBase(probeId, site) {
    const { text } = await getText(`${PLAYER}${encodeURIComponent(probeId)}`, `${site}/`);
    const src = /SRC\s*=\s*"(https:\/\/[^"]+?)\/premium\d+\/index\.m3u8"/.exec(text)?.[1];
    if (!src)
        throw new Error("dlhd: the player page no longer names an edge host");
    return src;
}
function streamFor(edge, id, labels = []) {
    return { url: `${edge}/premium${id}/index.m3u8`, quality: "", labels, referrer: "", userAgent: "", decoder: DECODER };
}
async function fetchChannels() {
    const { text, base } = await fromSite("/24-7-channels.php");
    const cards = [...text.matchAll(/href="\/watch\.php\?id=(\d+)"[\s\S]*?card__title">([^<]*)</g)];
    if (!cards.length)
        throw new Error("dlhd: no channels found on the 24/7 page");
    const edge = await edgeBase(cards[0][1], base);
    const channels = [];
    const seen = new Set();
    for (const card of cards) {
        const id = card[1];
        const raw = decodeEntities(card[2]);
        if (!raw || seen.has(id))
            continue;
        seen.add(id);
        const { name, country, countryName } = splitCountry(raw);
        channels.push({
            id: idFor(id),
            name,
            country,
            countryName,
            countryFlag: flagOf(country),
            categories: categoriesOf(raw),
            languages: [],
            logo: "",
            website: `${base}/watch.php?id=${id}`,
            network: "",
            streams: [streamFor(edge, id)]
        });
    }
    return { channels, edge, base };
}
/** UK wall-clock HH:MM today, as an instant. The schedule is "UK GMT",
 *  which in summer means BST -- Intl gives the real offset either way. */
function ukTimeToday(hhmm, now) {
    const [h, m] = hhmm.split(":").map(Number);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const londonNowAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    const offset = londonNowAsUtc - Math.floor(now.getTime() / 60_000) * 60_000;
    return Date.UTC(get("year"), get("month") - 1, get("day"), h || 0, m || 0) - offset;
}
const BEFORE_MS = 2 * 60 * 60 * 1000;
const AFTER_MS = 3 * 60 * 60 * 1000;
async function fetchEvents(edge) {
    const { text, base } = await fromSite("/");
    const at = text.indexOf('id="schedule"');
    if (at < 0)
        return [];
    const schedule = text.slice(at);
    const now = new Date();
    const events = [];
    let category = "";
    /*
        Walked as a token stream rather than a nested parse: a category
        header, then events, each event a time, a title and channel links.
        Only the FIRST day block is today's; later days are skipped by the
        `schedule__dayTitle` check.
    */
    const tokens = schedule.matchAll(/schedule__dayTitle">([^<]*)<|card__meta">([^<]*)<|schedule__time" data-time="(\d\d:\d\d)"|schedule__eventTitle">([^<]*)<|watch\.php\?id=(\d+)" title="([^"]*)"/g);
    let days = 0;
    let current = null;
    const finish = () => {
        if (!current || !current.ids.length)
            return;
        // "Upcoming Events" is a list of future fixtures, days or weeks
        // out, each pinned to a placeholder time today -- not live.
        if (/upcoming/i.test(category))
            return;
        const start = ukTimeToday(current.time, now);
        if (start - BEFORE_MS > now.getTime() || start + AFTER_MS < now.getTime())
            return;
        const title = decodeEntities(current.title).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
        if (!title)
            return;
        const upcoming = start > now.getTime();
        const sport = category.split(/\s{2,}| - /)[0].trim().toLowerCase().replace(/^all\s+|\s+events$/g, "");
        const described = eventFor(title, { sport, start });
        events.push({
            id: idFor(`event-${current.time.replace(":", "")}-${current.ids.join("-")}`),
            name: described.name,
            event: described.event,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", category.split(/\s{2,}| - /)[0].trim().toLowerCase().replace(/^all\s+|\s+events$/g, "")].filter(Boolean),
            languages: [],
            logo: "",
            website: base,
            network: current.names.join(", "),
            streams: current.ids.map((id) => streamFor(edge, id, upcoming ? [`Starts ${current.time} UK`] : []))
        });
    };
    for (const token of tokens) {
        if (token[1] !== undefined) {
            days += 1;
            if (days > 1)
                break;
        }
        else if (token[2] !== undefined) {
            finish();
            current = null;
            category = decodeEntities(token[2]).replace(/[^\p{L}\p{N} ()&'+-]/gu, "").trim();
        }
        else if (token[3] !== undefined) {
            finish();
            current = { time: token[3], title: "", ids: [], names: [] };
        }
        else if (token[4] !== undefined && current) {
            current.title = token[4];
        }
        else if (token[5] !== undefined && current && !current.ids.includes(token[5])) {
            current.ids.push(token[5]);
            current.names.push(decodeEntities(token[6] || ""));
        }
    }
    finish();
    return events;
}
// --- the decoder -----------------------------------------------------------
const TPIX = [84, 73, 75, 84, 73, 75, 80, 88]; // "TIKTIKPX"
const TRAW = [84, 73, 75, 84, 73, 75, 82, 65, 87]; // "TIKTIKRAW"
const TSGZ = [84, 73, 75, 84, 73, 75, 84, 83, 71, 90]; // "TIKTIKTSGZ"
function isTs(bytes, at = 0) {
    return bytes[at] === 0x47 && (at + 188 >= bytes.length || bytes[at + 188] === 0x47);
}
function find(bytes, tag) {
    outer: for (let i = 0; i + tag.length < bytes.length; i++) {
        for (let j = 0; j < tag.length; j++)
            if (bytes[i + j] !== tag[j])
                continue outer;
        return i;
    }
    return -1;
}
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc)
        return a;
    return pb <= pc ? b : c;
}
/** PNG -> its pixels as packed RGB, or null for any PNG this cannot be
 *  (not 8-bit, interlaced, not RGB/RGBA). */
function pngRgb(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = 0;
    let interlace = 0;
    const idat = [];
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12)
            return null;
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        const data = bytes.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") {
            width = view.getUint32(off + 8);
            height = view.getUint32(off + 12);
            depth = data[8];
            colour = data[9];
            interlace = data[12];
        }
        else if (type === "IDAT") {
            idat.push(data);
        }
        else if (type === "IEND") {
            break;
        }
        off += 12 + len;
    }
    if (!width || !height || depth !== 8 || interlace || (colour !== 2 && colour !== 6))
        return null;
    const raw = inflateSync(Buffer.concat(idat));
    const bpp = colour === 6 ? 4 : 3;
    const stride = width * bpp;
    const rgb = new Uint8Array(width * height * 3);
    let src = 0;
    let dst = 0;
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        if (src + 1 + stride > raw.length)
            return null;
        const filter = raw[src++];
        const row = raw.subarray(src, src + stride);
        src += stride;
        const out = new Uint8Array(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            let v = row[i];
            if (filter === 1)
                v += a;
            else if (filter === 2)
                v += b;
            else if (filter === 3)
                v += (a + b) >> 1;
            else if (filter === 4)
                v += paeth(a, b, c);
            else if (filter !== 0)
                return null;
            out[i] = v & 255;
        }
        if (colour === 2) {
            rgb.set(out, dst);
            dst += stride;
        }
        else {
            for (let i = 0; i < stride; i += 4) {
                rgb[dst++] = out[i];
                rgb[dst++] = out[i + 1];
                rgb[dst++] = out[i + 2];
            }
        }
        prev = out;
    }
    return rgb;
}
/** The newest layout: TS gzipped into the pixels, behind "TIKTIKPX". */
function fromPixels(bytes) {
    const rgb = pngRgb(bytes);
    if (!rgb || rgb.length < 12)
        return null;
    for (let k = 0; k < TPIX.length; k++)
        if (rgb[k] !== TPIX[k])
            return null;
    const size = new DataView(rgb.buffer, rgb.byteOffset + 8, 4).getUint32(0);
    if (size <= 0 || 12 + size > rgb.length)
        return null;
    const ts = gunzipSync(rgb.subarray(12, 12 + size));
    return isTs(ts) ? new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength) : null;
}
/** An older layout: TS appended after the PNG's IEND chunk. */
function afterIend(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        if (len > bytes.length - off - 12)
            return null;
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        off += 12 + len;
        if (type === "IEND")
            return off < bytes.length && isTs(bytes, off) ? bytes.subarray(off) : null;
    }
    return null;
}
/** An older layout still: TS in a WebP's EXIF chunk. */
function webpExif(bytes) {
    const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    if (bytes.length < 16 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP")
        return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 12;
    while (off + 8 <= bytes.length) {
        const tag = ascii(off, 4);
        const n = view.getUint32(off + 4, true);
        off += 8;
        if (off + n > bytes.length)
            return null;
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
export function unwrapSegment(bytes) {
    if (isTs(bytes))
        return bytes;
    const webp = webpExif(bytes);
    if (webp)
        return webp;
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
        const tail = afterIend(bytes);
        if (tail)
            return tail;
        const pixels = fromPixels(bytes);
        if (pixels)
            return pixels;
        throw new Error("dlhd: PNG segment with no TS payload");
    }
    const raw = find(bytes, TRAW);
    if (raw >= 0 && isTs(bytes, raw + TRAW.length))
        return bytes.subarray(raw + TRAW.length);
    const gz = find(bytes, TSGZ);
    if (gz >= 0) {
        const ts = gunzipSync(bytes.subarray(gz + TSGZ.length));
        return new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength);
    }
    for (let i = 0; i + 188 < bytes.length; i++)
        if (isTs(bytes, i))
            return bytes.subarray(i);
    throw new Error("dlhd: segment with no TS payload");
}
// --- tasks, caches and build() ------------------------------------------------
const configSchema = [
    {
        key: "channelsIntervalMinutes",
        label: "Channel list refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 60,
        help: "How often the 24/7 channel list (and the current video edge host) is re-read."
    },
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 60,
        min: 10,
        help: "How often today's schedule is re-read for the Live Events rail."
    }
];
/**
 * TWO JOBS, run and scheduled separately by the host (`buildEvents`): the
 * channel list changes by the day, today's schedule by the hour. The events
 * need the current video edge host, which the channel job reads; it is kept
 * here so the events job does not re-read the whole list for it.
 */
let edgeCache = null;
async function build() {
    const { channels, edge } = await fetchChannels();
    edgeCache = edge;
    return { channels, rails: railsFor(channels, SCRAPER_ID, "DaddyLive") };
}
async function buildEvents() {
    const edge = edgeCache || (edgeCache = (await fetchChannels()).edge);
    const events = await fetchEvents(edge);
    return {
        channels: events,
        rails: events.length ? [{ id: "live-events", heading: "Live Events", channelIds: events.map((e) => e.id), group: "Live events" }] : []
    };
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
export const dlhdScraper = {
    id: SCRAPER_ID,
    name: "DaddyLive",
    version: "1.4.1",
    configSchema,
    buildEvents,
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/dlhd.mts` -- prints a channel count and the first
// channel, then fetches that channel's playlist and first segment and
// decodes it, so a change in the disguise shows up here, not on a sofa.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const catalogue = await build();
        const events = catalogue.rails?.[0]?.channelIds.length || 0;
        console.log(`${catalogue.channels.length} channels (${events} live events), ${(catalogue.rails || []).length} rails`);
        console.log(catalogue.channels[0] || "(none)");
        const url = catalogue.channels[0]?.streams[0]?.url;
        if (!url)
            return;
        const playlist = await (await fetch(url)).text();
        const segmentUrl = playlist.split("\n").find((line) => /^https?:/.test(line.trim()));
        if (!segmentUrl)
            throw new Error(`no segment in ${url}`);
        const segment = new Uint8Array(await (await fetch(segmentUrl.trim())).arrayBuffer());
        const ts = unwrapSegment(segment);
        console.log(`segment: ${segment.length} bytes in, ${ts.length} bytes of TS out, sync ${ts[0] === 0x47 && ts[188] === 0x47}`);
    })().catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
