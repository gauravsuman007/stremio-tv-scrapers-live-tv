/**
 * Plex Live TV -- Plex's free, ad-supported linear channels (about 2,900
 * across US, Canada, UK, Australia, New Zealand, Mexico, Spain, France).
 *
 *   1. `GET https://i.mjh.nz/Plex/.channels.json.gz` -- the community channel
 *      list (matthuisman's i.mjh.nz): `{ regions: { <cc>: { name, headers:
 *      { "X-Forwarded-For": <an address in that country> } } }, channels: {
 *      <id>: { name, logo, regions: [<cc>], programs } }, headers: {
 *      "X-Plex-Token": <Plex's own shared anonymous token>, ... } }`. The
 *      token is read from the list, not written here.
 *   2. The stream is `https://epg.provider.plex.tv/library/parts/<id>.m3u8?
 *      X-Plex-Token=<token>` -- a master of `variant.m3u8` playlists (their
 *      query carries the session) and AWS MediaTailor segments.
 *
 * THE GEOBLOCK (2026-10-05, from Germany): without a hint Plex answers 404
 * `Channel not available in current location`. The hint the list names, the
 * region's `X-Forwarded-For`, lifts it (200 master), so it is sent as the
 * stream's static `headers` on every request (AGENTS.md, "Geoblocks: working
 * around them is allowed", case 1: a header the scraper can send itself).
 * The stream is not tagged with a `country`: the header is enough, and the
 * proxy pool is for blocks that need an address.
 *
 * Measured 2026-10-05 from Germany with that header: Wurl-, Stingray- and
 * galxy-hosted channels play (the galxy ones are AES-128 encrypted, which an
 * HLS client decrypts). Channels whose segments are `*.amagi.tv/.../beacon/...`
 * addresses (those ARE the segments, not tracking pixels; the playout host
 * names its country, e.g. `...-plex-gb-...`) answer 403 to every header set
 * tried (plain, browser UA, Origin/Referer, with and without the forwarded
 * address): that CDN judges the connecting address itself, which no header
 * lifts (AGENTS.md, Geoblocks case 3). They are left in the list and dropped
 * by the host's playability check; tagging them needs the playout's country
 * per channel, which the list does not give, and a blanket `country` tag would
 * push the working majority through proxies.
 *
 * What returns nothing: the list host down (the build throws, the host keeps
 * the last good catalogue); a channel Plex no longer serves (404, dropped by
 * the host's check).
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
    /** Where the stream is locked to (live-tv 1.14.0): the host fetches it through that country's proxies. */
    country?: string;
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


const SCRAPER_ID = "plexlive";

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


import { gunzipSync } from "node:zlib";

const LIST_URL = "https://i.mjh.nz/Plex/.channels.json.gz";
const STREAM = "https://epg.provider.plex.tv/library/parts/";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";

interface PlexList {
    regions?: Record<string, { name?: string; headers?: Record<string, string> }>;
    channels?: Record<string, { name?: string; logo?: string; regions?: string[]; programs?: unknown[] }>;
    headers?: Record<string, string>;
}

const LANGUAGES: Record<string, string> = { us: "eng", ca: "eng", gb: "eng", au: "eng", nz: "eng", mx: "spa", es: "spa", fr: "fra" };

const CATEGORY_WORDS: [RegExp, string][] = [
    [/news|noticias|actualit|weather|cnn|abc news|cbs news|nbc news|reuters|bloomberg/i, "news"],
    [/sport|golf|nfl|nba|mlb|nhl|racing|fight|ufc|wrestl|fifa|futbol|soccer/i, "sports"],
    [/kids|cartoon|nick|disney|baby|junior|anime|toon/i, "kids"],
    [/movie|film|cinema|western|horror|thriller|cine\b/i, "movies"],
    [/music|mtv|vevo|hits|concert/i, "music"],
    [/doc|nature|wild|history|science|crime|investigat|true/i, "documentary"]
];

function flagOf(code: string): string {
    return /^[a-z]{2}$/i.test(code) ? String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : "";
}

async function build(): Promise<ScrapedCatalogue> {
    const response = await withTimeout((signal) => fetch(LIST_URL, { signal }), 60_000);
    if (!response.ok) throw new Error(`plexlive: list -> ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    let text: string;
    try { text = gunzipSync(bytes).toString("utf8"); } catch { text = bytes.toString("utf8"); }
    const list = JSON.parse(text) as PlexList;
    const token = list.headers?.["X-Plex-Token"];
    if (!token) throw new Error("plexlive: the list names no X-Plex-Token");

    const channels: ScrapedChannel[] = [];
    for (const [key, channel] of Object.entries(list.channels || {})) {
        const name = (channel.name || "").trim();
        const region = (channel.regions || [])[0] || "";
        const forwarded = list.regions?.[region]?.headers?.["X-Forwarded-For"];
        if (!name || !/^[A-Za-z0-9_-]{10,80}$/.test(key) || !forwarded) continue;
        channels.push({
            id: idFor(key),
            name,
            country: region.toUpperCase(),
            countryName: list.regions?.[region]?.name || region.toUpperCase(),
            countryFlag: flagOf(region),
            categories: [CATEGORY_WORDS.find(([pattern]) => pattern.test(name))?.[1] || "entertainment"],
            languages: LANGUAGES[region] ? [LANGUAGES[region]!] : [],
            logo: channel.logo || "",
            website: "https://watch.plex.tv/live-tv",
            network: "Plex",
            streams: [{
                url: `${STREAM}${key}.m3u8?X-Plex-Token=${encodeURIComponent(token)}`,
                quality: "",
                labels: [],
                referrer: "",
                userAgent: list.headers?.["user-agent"] || BROWSER_UA,
                headers: { "X-Forwarded-For": forwarded }
            }]
        });
    }
    if (!channels.length) throw new Error("plexlive: the channel list was empty");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "Plex") };
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

export const plexliveScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Plex Live TV",
    version: "1.0.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/plexlive.mts` -- prints a channel count and the first channel,
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
