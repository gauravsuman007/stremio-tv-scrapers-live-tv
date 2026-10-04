/**
 * New Zealand and Australian TV (about 150 channels: Three/ThreeNow, TVNZ,
 * Sky's free and pop-up channels, Trackside racing, Māori TV, regional and
 * community stations, Australian networks). Geo-fenced by the broadcasters:
 * a channel plays where its broadcaster allows, the rest are dropped by the
 * host's check.
 *
 *   1. `GET https://i.mjh.nz/nzau/raw-tv.m3u8` -- matthuisman's community
 *      playlist (i.mjh.nz): `#EXTINF ... channel-id tvg-logo tvg-chno
 *      group-title, <name>`, a User-Agent line (`otg/1.5.1 (AppleTv ...)`)
 *      and `https://i.mjh.nz/.r/<slug>.m3u8`.
 *   2. `GET https://i.mjh.nz/.r/<slug>.m3u8` -- the same project's redirector:
 *      302 to the channel's own stream (`linear.stream.skyone.co.nz`,
 *      `video.trackside.co.nz`, `stream.wairarapatv.co.nz` ...). The addresses
 *      change, so each stream is a handle (`https://nzau.invalid/<slug>`)
 *      resolved when the channel is played or checked; the resolver looks at
 *      the playlist (`#EXTM3U`) before returning it.
 *
 * Verified 2026-10-05 from a German address: ThreeNow Sport 1 and Wairarapa
 * TV decode, Three answers 403 (NZ only).
 */
// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------

interface ScrapedStream {
    url: string;
    quality: string;
    labels: string[];
    referrer: string;
    userAgent: string;
    headers?: Record<string, string>;
    resolver?: string;
}

interface ScrapedChannel {
    id: string;
    name: string;
    country: string;
    countryName: string;
    countryFlag: string;
    categories: string[];
    languages: string[];
    logo: string;
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
    filter?: { countries?: string[]; categories?: string[]; genres?: string[]; languages?: string[]; sources?: string[]; networks?: string[]; market?: "home-first" | "first" };
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

interface ResolvedStream {
    url: string;
    referrer?: string;
    userAgent?: string;
    headers?: Record<string, string>;
}

type StreamResolver = (handle: string) => Promise<ResolvedStream | null>;

interface Scraper {
    id: string;
    name: string;
    version?: string;
    configSchema?: ScraperConfigField[];
    tasks?: ScraperTask[];
    resolvers?: Record<string, StreamResolver>;
    build(): Promise<ScrapedCatalogue>;
}


const SCRAPER_ID = "nzau";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
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
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function run(): Promise<void> {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index] as T);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
    return results;
}


const RESOLVER = "nzau";
const HANDLE_HOST = "nzau.invalid";
const PLAYLIST = "https://i.mjh.nz/nzau/raw-tv.m3u8";
const REDIRECT = "https://i.mjh.nz/.r/";
const STREAM_UA = "otg/1.5.1 (AppleTv Apple TV 4; tvOS16.0; appletv.client) libcurl/7.58.0 OpenSSL/1.0.2o zlib/1.2.11 clib/1.8.56";

const CATEGORY_WORDS: [RegExp, string][] = [
    [/news|1news|newshub|rnz/i, "news"],
    [/sport|trackside|racing|rugby|cricket|racing|tab\b|premier/i, "sports"],
    [/kids|junior|cartoon|nick|disney|bubble|treehouse/i, "kids"],
    [/movie|film|cinema|hallmark|rialto/i, "movies"],
    [/music|mtv|vevo|hits/i, "music"],
    [/discovery|documentar|history|nat geo|science|choice|lifestyle|hgtv|food/i, "documentary"]
];

function categoryOf(name: string): string[] {
    const hit = CATEGORY_WORDS.find(([pattern]) => pattern.test(name));
    return [hit ? hit[1] : "general"];
}

const GROUP_COUNTRY: Record<string, [string, string, string]> = {
    nz: ["NZ", "New Zealand", "🇳🇿"],
    au: ["AU", "Australia", "🇦🇺"],
    sydney: ["AU", "Australia", "🇦🇺"]
};

function attribute(line: string, key: string): string {
    return new RegExp(`${key}="([^"]*)"`).exec(line)?.[1]?.trim() || "";
}

function handleFor(slug: string): string {
    return `https://${HANDLE_HOST}/${encodeURIComponent(slug)}`;
}

async function resolveStream(handle: string): Promise<ResolvedStream | null> {
    try {
        const url = new URL(handle);
        if (url.hostname !== HANDLE_HOST) return null;
        const slug = decodeURIComponent(url.pathname.slice(1));
        if (!/^[A-Za-z0-9_.-]{2,100}$/.test(slug)) return null;
        const hop = await withTimeout((signal) => fetch(`${REDIRECT}${slug}.m3u8`, { signal, redirect: "manual", headers: { "User-Agent": STREAM_UA } }), 15_000);
        const target = hop.headers.get("location");
        if (!target || !/^https:\/\//.test(target)) return null;
        const check = await withTimeout((signal) => fetch(target, { signal, headers: { "User-Agent": STREAM_UA } }), 15_000);
        const text = check.ok ? await check.text() : "";
        if (!text.includes("#EXTM3U")) return null;
        return { url: target, referrer: "", userAgent: STREAM_UA };
    } catch {
        return null;
    }
}

async function build(): Promise<ScrapedCatalogue> {
    const response = await withTimeout((signal) => fetch(PLAYLIST, { signal }), 60_000);
    if (!response.ok) throw new Error(`nzau: playlist -> ${response.status}`);
    const lines = (await response.text()).split(/\r?\n/);
    const channels: ScrapedChannel[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
        const info = lines[i]!;
        if (!info.startsWith("#EXTINF")) continue;
        const address = lines.slice(i + 1, i + 6).find((line) => line.startsWith("https://i.mjh.nz/.r/"));
        const slug = address?.replace(REDIRECT, "").replace(/\.m3u8.*$/, "");
        const name = info.slice(info.lastIndexOf(",") + 1).trim();
        if (!slug || !name || seen.has(slug)) continue;
        seen.add(slug);
        const [country, countryName, flag] = GROUP_COUNTRY[attribute(info, "group-title").toLowerCase()] || ["", "", ""];
        channels.push({
            id: idFor(slug),
            name,
            country,
            countryName,
            countryFlag: flag,
            categories: categoryOf(name),
            languages: [],
            logo: attribute(info, "tvg-logo"),
            website: "https://i.mjh.nz/",
            network: "",
            streams: [{ url: handleFor(slug), quality: "", labels: [], referrer: "", userAgent: STREAM_UA, resolver: RESOLVER }]
        });
    }
    if (!channels.length) throw new Error("nzau: no channel parsed");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "NZ & AU TV") };
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
const CONTINENTS: [string, string][] = [
    ["Asia", "AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE AE"],
    ["Europe", "AD AL AT BA BE BG BY CH CZ DE DK EE ES FI FO FR GB UK GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK"],
    ["Africa", "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW RE"],
    ["North America", "US CA MX GL BM"],
    ["Latin America & Caribbean", "AG AI AR AW BB BO BQ BR BS BZ CL CO CR CU CW DM DO EC GD GT GY HN HT JM KN KY LC NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI MQ GP GF"],
    ["Oceania", "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS"]
];

function continentName(code: string): string {
    return CONTINENTS.find(([, codes]) => codes.split(" ").includes(code.toUpperCase()))?.[0] || "Elsewhere";
}

function languageTitle(code: string): string {
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);

        return name && name !== code ? name : code.toUpperCase();
    } catch {
        return code.toUpperCase();
    }
}

/** Words the host's own genre rails (News, Sports, Movies ...) already carry under the same name. */
const GENRE_NAMES = new Set([
    "news", "sports", "movies", "kids", "music", "documentary", "lifestyle", "business", "entertainment", "general"
]);

/** Never offered as a rail: shopping and adult shelves. */
const UNLISTED = /\b(shop\w*|xxx|adult|erotic\w*|sinnlich\w*|telesales|18\+)\b/i;

function railsFor(channels: ScrapedChannel[], sourceId: string, sourceName: string, wanted: { countries: boolean; languages: boolean; categories: boolean; networks?: boolean } = { countries: true, languages: true, categories: true }): ScrapedRail[] {
    const rails: ScrapedRail[] = [];
    const perCountry = new Map<string, { n: number; names: Map<string, number> }>();
    const perLanguage = new Map<string, number>();
    const perWord = new Map<string, number>();
    const perNetwork = new Map<string, { n: number; name: string }>();

    for (const channel of channels) {
        if (channel.country) {
            const entry = perCountry.get(channel.country) || { n: 0, names: new Map<string, number>() };

            entry.n += 1;
            if (channel.countryName) entry.names.set(channel.countryName, (entry.names.get(channel.countryName) || 0) + 1);
            perCountry.set(channel.country, entry);
        }

        for (const code of new Set(channel.languages)) perLanguage.set(code, (perLanguage.get(code) || 0) + 1);
        for (const word of new Set(channel.categories)) perWord.set(word, (perWord.get(word) || 0) + 1);

        const network = (channel.network || "").trim();

        if (network) {
            const key = network.toLowerCase();

            perNetwork.set(key, { n: (perNetwork.get(key)?.n || 0) + 1, name: perNetwork.get(key)?.name || network });
        }
    }

    function byCount<T>(a: [string, T], b: [string, T], size: (value: T) => number): number {
        return size(b[1]) - size(a[1]) || a[0].localeCompare(b[0]);
    }

    if (wanted.countries) {
        for (const [code, entry] of [...perCountry.entries()].sort((a, b) => byCount(a, b, (v) => v.n))) {
            const name = [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

            if (!name || !/^[A-Za-z]{2,3}$/.test(code)) continue;

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
            if (!/^[a-z]{2,3}$/.test(code)) continue;

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
        const taken = new Set<string>();
        let added = 0;

        for (const [word, count] of [...perWord.entries()].sort((a, b) => byCount(a, b, (v) => v))) {
            const slug = `cat-${word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");

            if (count < 3 || word.length > 40 || GENRE_NAMES.has(word) || UNLISTED.test(word) || slug === "cat" || taken.has(slug)) continue;

            taken.add(slug);
            rails.push({
                id: slug,
                heading: word.replace(/(^|[\s(+&/-])(\p{L})/gu, (_all, lead: string, first: string) => lead + first.toUpperCase()).replace(/\bTv\b/g, "TV"),
                by: "Its own category",
                group: "Categories",
                channelIds: [],
                filter: { categories: [word] }
            });

            added += 1;
            if (added >= 60) break;
        }
    }

    if (wanted.networks !== false) {
        let added = 0;

        for (const [key, entry] of [...perNetwork.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
            const slug = `network-${key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40).replace(/-+$/, "");

            if (entry.n < 3 || key.length < 3 || key.length > 30 || slug === "network" || UNLISTED.test(key) || /[^\p{L}\p{N} &.+'-]/u.test(key) || sourceName.toLowerCase().includes(key) || key.includes(sourceName.toLowerCase())) continue;

            rails.push({
                id: slug,
                heading: entry.name,
                by: "One network",
                group: "Networks",
                channelIds: [],
                filter: { networks: [key] }
            });

            added += 1;
            if (added >= 60) break;
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

export const nzauScraper: Scraper = {
    id: SCRAPER_ID,
    name: "NZ & AU TV",
    version: "1.0.0",
    resolvers: { [RESOLVER]: resolveStream },
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/nzau.mts` -- prints a channel count and the first channel,
// then resolves it.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then(async (catalogue) => {
            console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
            const first = catalogue.channels[0];
            console.log(first || "(none)");
            if (first?.streams[0]) console.log(await resolveStream(first.streams[0].url));
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
