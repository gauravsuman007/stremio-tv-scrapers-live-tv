/**
 * Famelack -- ~6.7k live-TV channels across ~170 countries, published as a
 * plain public dataset on GitHub (`famelack/famelack-data`) that the
 * famelack.com player itself reads. No API, no gate: every file is static
 * JSON on raw.githubusercontent.com.
 *
 *   - `tv/raw/countries_metadata.json` -- `{ <ISO>: { country,
 *     hasChannels, channelCount } }`, used to enumerate countries.
 *   - `tv/raw/countries/<iso lowercase>.json` -- that country's channels:
 *     `{ nanoid, name, sources: { streams?: string[], youtube?: string[] },
 *     languages, country, isGeoBlocked }`.
 *   - `tv/raw/categories/<category>.json` -- the same records, grouped by
 *     category; read only to tag each channel with its categories. The
 *     category names aren't listed anywhere in the dataset, so the
 *     iptv-org-style names below are tried and any 404 is ignored.
 *
 * Much of the dataset overlaps iptv-org (it credits iptv-org as a
 * source); an overlapping channel merges centrally into the existing card
 * as an extra mirror rather than duplicating it. `youtube` sources are
 * YouTube embed pages, not streams, and are skipped -- a channel with
 * only YouTube sources is dropped.
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------
const SCRAPER_ID = "famelack";
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
const DATA = "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/raw";
const CATEGORY_GUESSES = [
    "animation", "auto", "business", "classic", "comedy", "cooking", "culture", "documentary",
    "education", "entertainment", "family", "general", "kids", "legislative", "lifestyle",
    "movies", "music", "news", "outdoor", "relax", "religious", "science", "series", "shop",
    "sports", "travel", "weather"
];
async function getJson(url) {
    const response = await withTimeout((signal) => fetch(url, { signal }));
    if (response.status === 404)
        return null;
    if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
    return (await response.json());
}
function flagEmoji(code) {
    if (!/^[A-Z]{2}$/.test(code))
        return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
const LOGO_API = "https://iptv-org.github.io/api";
const LOGO_DIRECTORY_IDLE_MS = 10 * 60_000;
const logoShared = (globalThis[Symbol.for("live-tv.logo-directory")] ||= {
    directory: null,
    timer: null
});
function foldLogoName(name) {
    return name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/^\s*(?:\[[^\]]{1,6}\]\s*)+/, "")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/\b(hd\+?|fhd|uhd|sd|4k|hevc|raw|backup|feed|\d{3,4}p)\b/g, "")
        .replace(/[^a-z0-9]+/g, "");
}
async function loadLogoDirectory() {
    try {
        const get = async (file) => {
            const response = await fetch(`${LOGO_API}/${file}.json`, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok)
                throw new Error(`${file}.json -> ${response.status}`);
            return (await response.json());
        };
        const [channels, logos] = (await Promise.all([get("channels"), get("logos")]));
        /* The biggest raster logo per channel; a vector only when there is nothing else (a panel cannot sniff SVG). */
        const best = new Map();
        for (const logo of logos) {
            if (!logo.channel || !logo.url)
                continue;
            const candidate = { url: logo.url, width: logo.width || 0, vector: /svg/i.test(logo.format || "") };
            const held = best.get(logo.channel);
            if (!held || (held.vector && !candidate.vector) || (held.vector === candidate.vector && candidate.width > held.width))
                best.set(logo.channel, candidate);
        }
        const directory = { byCountry: new Map(), byName: new Map() };
        for (const channel of channels) {
            const logo = channel.id ? best.get(channel.id) : undefined;
            if (!logo)
                continue;
            for (const name of [channel.name || "", ...(channel.alt_names || [])]) {
                const folded = foldLogoName(name);
                if (folded.length < 3)
                    continue;
                directory.byCountry.set(`${folded}|${(channel.country || "").toUpperCase()}`, logo.url);
                (directory.byName.get(folded) || directory.byName.set(folded, new Set()).get(folded)).add(logo.url);
            }
        }
        return directory;
    }
    catch (cause) {
        console.error("logo directory unavailable:", cause);
        logoShared.directory = null;
        return null;
    }
}
/** Fills `logo` on channels that have none (or whose own is `dead`). Never throws; returns how many it filled. */
async function fillLogos(channels, dead) {
    if (logoShared.timer)
        clearTimeout(logoShared.timer);
    const directory = await (logoShared.directory ||= loadLogoDirectory());
    logoShared.timer = setTimeout(() => {
        logoShared.directory = null;
        logoShared.timer = null;
    }, LOGO_DIRECTORY_IDLE_MS);
    logoShared.timer.unref?.();
    if (!directory)
        return 0;
    let filled = 0;
    for (const channel of channels) {
        if (channel.logo && !(dead && dead(channel.logo)))
            continue;
        const folded = foldLogoName(channel.name);
        if (folded.length < 3)
            continue;
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
async function build() {
    const meta = await getJson(`${DATA}/countries_metadata.json`);
    if (!meta)
        throw new Error("famelack: countries_metadata.json missing");
    const countries = Object.entries(meta).filter(([, v]) => v.hasChannels);
    const categoriesById = new Map();
    await mapWithConcurrency(CATEGORY_GUESSES, 8, async (category) => {
        const list = await getJson(`${DATA}/categories/${category}.json`).catch(() => null);
        for (const entry of list || []) {
            if (!entry.nanoid)
                continue;
            const existing = categoriesById.get(entry.nanoid) || [];
            existing.push(category);
            categoriesById.set(entry.nanoid, existing);
        }
    });
    let failures = 0;
    const perCountry = await mapWithConcurrency(countries, 8, async ([code, info]) => {
        try {
            const list = await getJson(`${DATA}/countries/${code.toLowerCase()}.json`);
            return { code: code.toUpperCase(), name: info.country || "", list: list || [] };
        }
        catch (cause) {
            failures++;
            console.error(`famelack: ${code} failed`, cause);
            return { code, name: "", list: [] };
        }
    });
    if (failures === countries.length)
        throw new Error("famelack: every country file failed");
    const seen = new Set();
    const channels = [];
    for (const { code, name: countryName, list } of perCountry) {
        for (const entry of list) {
            if (!entry.nanoid || !entry.name || seen.has(entry.nanoid))
                continue;
            const urls = (entry.sources?.streams || []).filter((u) => /^https?:\/\//.test(u));
            if (!urls.length)
                continue;
            seen.add(entry.nanoid);
            const labels = entry.isGeoBlocked ? ["Geo-blocked"] : [];
            // Famelack files channels by country, and a blocked one is locked to its own.
            const lock = entry.isGeoBlocked && /^[A-Za-z]{2}$/.test(code) ? { country: code.toUpperCase() === "UK" ? "GB" : code.toUpperCase() } : {};
            channels.push({
                id: idFor(entry.nanoid),
                name: entry.name.trim(),
                country: code,
                countryName,
                countryFlag: flagEmoji(code),
                categories: categoriesById.get(entry.nanoid) || [],
                languages: entry.languages || [],
                logo: "",
                website: "",
                network: "",
                streams: urls.map((url) => ({ url, quality: "", labels, referrer: "", userAgent: "", ...lock }))
            });
        }
    }
    if (!channels.length)
        throw new Error("famelack: no channels found");
    await fillLogos(channels);
    return { channels, rails: railsFor(channels, SCRAPER_ID, "Famelack") };
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
export const famelackScraper = {
    id: SCRAPER_ID,
    name: "Famelack",
    version: "1.5.1",
    build
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/famelack.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
        console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
        console.log(`${catalogue.channels.filter((c) => c.categories.length).length} with categories`);
        console.log(catalogue.channels[0] || "(none)");
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
