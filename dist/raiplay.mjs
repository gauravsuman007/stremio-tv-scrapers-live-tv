/**
 * RaiPlay -- Rai's own live channels (about 15: Rai 1, 2, 3, News 24, Sport,
 * 4, 5, Movie, Premium, Storia, Yoyo, Gulp, Italiana, 4K ...), from Rai's
 * public JSON.
 *
 *   1. `GET https://www.raiplay.it/dirette.json` -> `contents[]: { channel,
 *      path_id: "/dirette/rai1.json", is_live, transparent_icon }`.
 *   2. `GET https://www.raiplay.it/dirette/<slug>.json` -> `video.content_url`,
 *      a `mediapolis.rai.it/relinker/relinkerServlet.htm?cont=<id>` address.
 *   3. `GET <relinker>&output=7` redirects to the channel's HLS. THE GEOBLOCK
 *      (2026-10-05, from Germany): outside Italy it redirects to
 *      `download-rai-it.akamaized.net/video_no_available.mp4`, a decoy video, with a
 *      200. No header was tried: the answer is the caller's country. So
 *      each stream carries `country: "IT"` (the proxy pool, AGENTS.md
 *      "Geoblocked streams") and its resolver asks the relinker through
 *      `context.fetch`, returning only a final address that is an `.m3u8`
 *      (a decoy mp4 resolves to `null`). Radio channels are left out.
 *
 * NOT VERIFIED END TO END: from Germany only the decoy could be seen; the
 * Italian branch is written from Rai's own relinker contract. Check it on a
 * host with an Italian exit or the proxy pool before relying on it.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
const SCRAPER_ID = "raiplay";
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
const RESOLVER = "raiplay";
const HANDLE_HOST = "raiplay.invalid";
const SITE = "https://www.raiplay.it";
const NEWS = /news/i;
const SPORT = /sport/i;
const KIDS = /yoyo|gulp/i;
function handleFor(slug) {
    return `https://${HANDLE_HOST}/${encodeURIComponent(slug)}`;
}
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** The resolver's own requests leave through the stream's country when the host offers a context; an older host falls back to a direct fetch. */
async function viaContext(context, url, headers = {}) {
    if (context) {
        const got = await context.fetch(url, { headers: { "User-Agent": BROWSER_UA, ...headers }, timeoutMs: 15_000 });
        return { status: got.status, url: got.url, text: got.text ?? "" };
    }
    const response = await withTimeout((signal) => fetch(url, { signal, headers: { "User-Agent": BROWSER_UA, ...headers } }), 15_000);
    return { status: response.status, url: response.url, text: await response.text() };
}
async function resolveStream(handle, context) {
    try {
        const url = new URL(handle);
        if (url.hostname !== HANDLE_HOST)
            return null;
        const slug = decodeURIComponent(url.pathname.slice(1));
        if (!/^[a-z0-9]{2,30}$/.test(slug))
            return null;
        const page = await viaContext(context, `${SITE}/dirette/${slug}.json`);
        const relinker = JSON.parse(page.text).video?.content_url;
        if (!relinker || !/^https:\/\/mediapolis\.rai\.it\/relinker\//.test(relinker))
            return null;
        const hop = await viaContext(context, `${relinker}${relinker.includes("?") ? "&" : "?"}output=7`);
        // Outside Italy the redirect ends at a decoy mp4; a real answer ends at an HLS playlist.
        if (!/^https:\/\//.test(hop.url) || !/\.m3u8(\?|$)/i.test(hop.url))
            return null;
        return { url: hop.url, referrer: "", userAgent: BROWSER_UA };
    }
    catch {
        return null;
    }
}
async function build() {
    const response = await withTimeout((signal) => fetch(`${SITE}/dirette.json`, { signal, headers: { "User-Agent": BROWSER_UA } }));
    if (!response.ok)
        throw new Error(`raiplay: dirette.json -> ${response.status}`);
    const list = (await response.json()).contents || [];
    const channels = [];
    for (const item of list) {
        const name = (item.channel || "").trim();
        const slug = /^\/dirette\/([a-z0-9]+)\.json$/.exec(item.path_id || "")?.[1];
        if (!name || !slug || item.is_live === false || /radio/i.test(name))
            continue;
        channels.push({
            id: idFor(slug),
            name,
            country: "IT",
            countryName: "Italy",
            countryFlag: "🇮🇹",
            categories: [NEWS.test(name) ? "news" : SPORT.test(name) ? "sports" : KIDS.test(name) ? "kids" : "general"],
            languages: ["ita"],
            logo: item.transparent_icon ? new URL(item.transparent_icon, SITE).href : "",
            website: `${SITE}/dirette/${slug}`,
            network: "Rai",
            streams: [{ url: handleFor(slug), quality: "", labels: ["Geo-blocked IT"], referrer: "", userAgent: BROWSER_UA, resolver: RESOLVER, country: "IT" }]
        });
    }
    if (!channels.length)
        throw new Error("raiplay: the channel list was empty");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "RaiPlay") };
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
export const raiplayScraper = {
    id: SCRAPER_ID,
    name: "RaiPlay (Italy)",
    version: "1.0.0",
    resolvers: { [RESOLVER]: resolveStream },
    build
};
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
        console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
        console.log(catalogue.channels[0] || "(none)");
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
