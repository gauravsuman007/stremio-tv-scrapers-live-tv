/**
 * Free-TV/IPTV (github.com/Free-TV/IPTV) -- a community-curated playlist of
 * free-to-air channels by country (about 1,600 usable HLS channels: Europe
 * most of all, plus the Americas, Asia, Africa, Oceania). Separate from
 * iptv-org: it is hand-maintained, smaller and carries different mirrors.
 *
 *   `GET https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8`
 *   -- `#EXTINF:-1 tvg-name tvg-logo tvg-id tvg-country group-title, <name>`
 *   then the address. Name suffixes are the list's own marks: `Ⓢ` not HD,
 *   `Ⓖ` GeoIP-blocked, `Ⓨ` a YouTube live page, `Ⓣ` a Twitch page.
 *
 * Kept: plain `http(s)` HLS addresses. Left out: YouTube/Twitch pages (not
 * streams), Pluto TV's stitcher (`pluto.mts` has those), the `VOD` groups
 * and anything that is not an `.m3u8`. Same name in the same country with
 * several addresses becomes one channel with several streams. A `Ⓖ`
 * channel is labelled "Geo-blocked"; the host drops it where it cannot play.
 *
 * What returns nothing: GitHub unreachable (the build throws and the host
 * keeps the last good catalogue).
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
const SCRAPER_ID = "freetv";
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
const PLAYLIST = "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8";
const SKIP_HOST = /(^|\.)(youtube\.com|youtu\.be|twitch\.tv|pluto\.tv)$/i;
const CATEGORY_WORDS = [
    [/news|noticias|actualit|nachrichten|notizie|tg\b|info\b|24\b/i, "news"],
    [/sport|futbol|football|soccer|calcio|golf|racing|motor/i, "sports"],
    [/kids|child|junior|cartoon|nick|disney|baby|bambini|infantil|enfant/i, "kids"],
    [/movie|film|cinema|cine\b|kino/i, "movies"],
    [/music|musik|musica|radio|mtv|hits|vevo/i, "music"],
    [/doc|nature|natgeo|discovery|history|science|wild/i, "documentary"]
];
function categoryOf(name) {
    const hit = CATEGORY_WORDS.find(([pattern]) => pattern.test(name));
    return [hit ? hit[1] : "general"];
}
function flagOf(code) {
    return /^[a-z]{2}$/i.test(code) ? String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : "";
}
function attribute(line, key) {
    return new RegExp(`${key}="([^"]*)"`).exec(line)?.[1]?.trim() || "";
}
async function build() {
    const response = await withTimeout((signal) => fetch(PLAYLIST, { signal }), 60_000);
    if (!response.ok)
        throw new Error(`freetv: playlist -> ${response.status}`);
    const lines = (await response.text()).split(/\r?\n/);
    const regions = new Intl.DisplayNames(["en"], { type: "region" });
    const byKey = new Map();
    for (let i = 0; i < lines.length; i++) {
        const info = lines[i];
        if (!info.startsWith("#EXTINF"))
            continue;
        const address = (lines[i + 1] || "").trim();
        if (!/^https?:\/\//.test(address))
            continue;
        let host = "";
        try {
            host = new URL(address).hostname;
        }
        catch {
            continue;
        }
        if (SKIP_HOST.test(host) || !/\.m3u8?(\?|$)/i.test(address))
            continue;
        const group = attribute(info, "group-title");
        if (/^vod\b/i.test(group))
            continue;
        const rawName = info.slice(info.lastIndexOf(",") + 1).trim();
        const name = rawName.replace(/\s*[ⓈⒼⓎⓉ]+\s*/g, " ").replace(/\s+/g, " ").trim();
        if (!name)
            continue;
        const country = attribute(info, "tvg-country").split(/[;,]/)[0].trim().toUpperCase();
        const key = `${country || group}:${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`;
        const labels = [/Ⓖ/.test(rawName) ? "Geo-blocked" : "", /Ⓢ/.test(rawName) ? "SD" : ""].filter(Boolean);
        const stream = { url: address, quality: "", labels, referrer: "", userAgent: "" };
        const known = byKey.get(key);
        if (known) {
            if (!known.streams.some((s) => s.url === address))
                known.streams.push(stream);
            continue;
        }
        let countryName = group;
        try {
            countryName = (country && regions.of(country)) || group;
        }
        catch { /* unknown region */ }
        byKey.set(key, {
            id: idFor(key),
            name,
            country,
            countryName,
            countryFlag: flagOf(country),
            categories: categoryOf(name),
            languages: [],
            logo: attribute(info, "tvg-logo"),
            website: "https://github.com/Free-TV/IPTV",
            network: "",
            streams: [stream]
        });
    }
    const channels = [...byKey.values()];
    if (!channels.length)
        throw new Error("freetv: no channel parsed");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "Free-TV/IPTV") };
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
export const freetvScraper = {
    id: SCRAPER_ID,
    name: "Free-TV/IPTV",
    version: "1.0.0",
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/freetv.mts` -- prints a channel count and the first channel,
// then resolves it.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then(async (catalogue) => {
        console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
        const first = catalogue.channels[0];
        console.log(first || "(none)");
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
