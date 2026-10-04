/**
 * Samsung TV Plus -- the free, ad-supported linear channels of Samsung's
 * TV Plus service (about 1,800 across 11 countries: US, UK, Canada,
 * Germany, Austria, Switzerland, France, Spain, Italy, India, Korea).
 *
 *   1. `GET https://i.mjh.nz/SamsungTVPlus/.channels.json.gz` -- the
 *      community channel list (matthuisman's i.mjh.nz, a public GitHub
 *      mirror): `regions.<cc>.channels.<id> = { name, chno, logo, group,
 *      description, programs }`. The ids are Samsung's own (`USBA370000104`).
 *   2. `GET https://jmp2.uk/stvp-<id>` -- the same project's redirector;
 *      it answers 302 to the channel's real stream, a Google DAI
 *      (`dai.google.com/linear/hls/...`) HLS master with the ad
 *      insertion in-stream. The address carries a session, so each stream
 *      here is a handle (`https://samsungtvplus.invalid/<id>`) that
 *      the resolver turns into the redirect target when the channel is
 *      played or checked, and looks at (`#EXTM3U`) before returning it.
 *   The User-Agent is `okhttp/4.12.0`, which is what the list names for it.
 *
 * Verified 2026-10-04 from a German address (the channel list is not
 * region-checked for playback; ffmpeg decodes a US channel).
 *
 * What returns nothing: the list host or the redirector down (the build
 * throws, so the host keeps the last good catalogue), a channel the
 * redirector no longer knows (404 -> the resolver returns `null`).
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
const SCRAPER_ID = "samsungtvplus";
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
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
        for (;;) {
            const index = next++;
            if (index >= items.length)
                return;
            results[index] = await worker(items[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
    return results;
}
import { gunzipSync } from "node:zlib";
const RESOLVER = "samsungtvplus";
const HANDLE_HOST = "samsungtvplus.invalid";
const LIST_URL = "https://i.mjh.nz/SamsungTVPlus/.channels.json.gz";
const REDIRECT = "https://jmp2.uk/stvp-";
const REDIRECT_SUFFIX = "";
const CATEGORY_WORDS = [
    [/news|politic|weather/i, "news"],
    [/sport|soccer|football|golf|racing|fight|wrestl/i, "sports"],
    [/kid|famil|cartoon|animation|anime/i, "kids"],
    [/movie|film|cinema|western|horror|thriller/i, "movies"],
    [/music/i, "music"],
    [/documentar|nature|science|history|true crime|lifestyle|travel|food|cook/i, "documentary"],
    [/entertain|comedy|drama|reality|game|romance|crime|action|sci|general/i, "entertainment"]
];
function categoryOf(group) {
    const hit = CATEGORY_WORDS.find(([pattern]) => pattern.test(group));
    return hit ? [hit[1]] : group.trim() ? [group.trim().toLowerCase()] : ["general"];
}
function flagOf(code) {
    return /^[a-z]{2}$/i.test(code) ? String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : "";
}
async function getList() {
    const response = await withTimeout((signal) => fetch(LIST_URL, { signal }), 60_000);
    if (!response.ok)
        throw new Error(`samsungtvplus: list -> ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    let text;
    try {
        text = gunzipSync(bytes).toString("utf8");
    }
    catch {
        text = bytes.toString("utf8");
    }
    return JSON.parse(text);
}
function handleFor(id) {
    return `https://${HANDLE_HOST}/${encodeURIComponent(id)}`;
}
/** The address the redirector sends this channel to (a fresh one each time: it is a per-session stream). */
async function resolveStream(handle) {
    try {
        const url = new URL(handle);
        if (url.hostname !== HANDLE_HOST)
            return null;
        const id = decodeURIComponent(url.pathname.slice(1));
        if (!/^[A-Za-z0-9_.-]{3,120}$/.test(id))
            return null;
        const hop = await withTimeout((signal) => fetch(`${REDIRECT}${id}${REDIRECT_SUFFIX}`, { signal, redirect: "manual", headers: { "User-Agent": STREAM_UA } }), 15_000);
        const target = hop.headers.get("location");
        if (!target || !/^https:\/\//.test(target))
            return null;
        const check = await withTimeout((signal) => fetch(target, { signal, headers: { "User-Agent": STREAM_UA } }), 15_000);
        const text = check.ok ? await check.text() : "";
        if (!text.includes("#EXTM3U"))
            return null;
        return { url: target, referrer: "", userAgent: STREAM_UA };
    }
    catch {
        return null;
    }
}
const STREAM_UA = "okhttp/4.12.0";
const LANGUAGES = { us: "eng", gb: "eng", ca: "eng", in: "eng", de: "deu", at: "deu", ch: "deu", fr: "fra", es: "spa", it: "ita", kr: "kor" };
async function build() {
    const list = await getList();
    const channels = [];
    const seen = new Set();
    for (const [region, body] of Object.entries(list.regions || {})) {
        for (const [key, channel] of Object.entries(body.channels || {})) {
            const name = (channel.name || "").trim();
            const id = idFor(key.toLowerCase());
            if (!name || seen.has(id))
                continue;
            seen.add(id);
            channels.push({
                id,
                name,
                country: region.toUpperCase(),
                countryName: body.name || region.toUpperCase(),
                countryFlag: flagOf(region),
                categories: categoryOf(channel.group || ""),
                languages: LANGUAGES[region] ? [LANGUAGES[region]] : [],
                logo: channel.logo || "",
                website: "https://www.samsung.com/us/televisions-home-theater/tvs/tv-plus/",
                network: "Samsung TV Plus",
                streams: [{ url: handleFor(key), quality: "", labels: [], referrer: "", userAgent: STREAM_UA, resolver: RESOLVER }]
            });
        }
    }
    if (!channels.length)
        throw new Error("samsungtvplus: the channel list was empty");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "Samsung TV Plus") };
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
export const samsungtvplusScraper = {
    id: SCRAPER_ID,
    name: "Samsung TV Plus",
    version: "1.0.0",
    resolvers: { [RESOLVER]: resolveStream },
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/samsungtvplus.mts` -- prints a channel count and the first channel,
// then resolves it.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then(async (catalogue) => {
        console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
        const first = catalogue.channels[0];
        console.log(first || "(none)");
        if (first?.streams[0])
            console.log(await resolveStream(first.streams[0].url));
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
