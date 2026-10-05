/**
 * Xumo Play -- free, ad-supported, fully legal US linear TV (~450
 * channels), from Xumo's own public web-app API. US-only: from outside
 * the US, `play.xumo.com` 302s to `/geo-block` and this API is expected
 * to refuse or return nothing, in which case `build()` throws and the
 * host keeps the last good catalogue.
 *
 *   1. `GET valencia-app-mds.xumo.com/v2/channels/list/10006.json` -- the
 *      web app's channel list: `channel.item[]` with `title`,
 *      `guid.value` (the channel id), `genre[]`, `properties.is_live`.
 *   2. `GET .../v2/channels/channel/<id>/broadcast.json?hour=<UTC hour>`
 *      -- answers `ssaiStreamUrl`, a static per-channel
 *      `<cloudfront>/10001/<id>/hls/playlist.m3u8?ads.*=...` master. Its
 *      query string carries a long tail of unfilled `[PLACEHOLDER]` ad
 *      macros meant for native apps; those are dropped (verified: the
 *      playlist and its `wurl.com`/MediaTailor segments still play), but
 *      the rest of the query has to stay -- the bare path 400s with
 *      "Unable to resolve origin prefix after interpolation."
 *
 *   3. About 40% of channels answer `broadcast.json` with no
 *      `ssaiStreamUrl`, only `assets: [{ id, live: true }]`. For those,
 *      `GET .../v2/assets/asset/<asset id>.json?f=providers` lists
 *      `providers[].sources[].uri` -- the same cloudfront URL shape
 *      (`.../hls/index.m3u8?...`), cleaned the same way. A channel with
 *      neither is skipped.
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

interface Scraper {
    id: string;
    name: string;
    version?: string;
    configSchema?: ScraperConfigField[];
    tasks?: ScraperTask[];
    build(): Promise<ScrapedCatalogue>;
}

const SCRAPER_ID = "xumo";

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

const API = "https://valencia-app-mds.xumo.com/v2";

interface XumoItem {
    title?: string;
    guid?: { value?: string };
    genre?: Array<{ value?: string }>;
    properties?: { is_live?: string };
}

async function getJson<T>(url: string): Promise<T> {
    const response = await withTimeout((signal) => fetch(url, { signal }));
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return (await response.json()) as T;
}

/** Drops the `[MACRO]` placeholders native apps are meant to fill in. */
function cleanStreamUrl(raw: string): string {
    const url = new URL(raw);
    for (const [key, value] of [...url.searchParams]) {
        if (value.includes("[")) url.searchParams.delete(key);
    }
    return url.href;
}

async function streamFor(id: string): Promise<string | null> {
    try {
        const hour = new Date().getUTCHours();
        const body = await getJson<{ ssaiStreamUrl?: string; assets?: Array<{ id?: string }> }>(
            `${API}/channels/channel/${id}/broadcast.json?hour=${hour}`
        );
        if (body.ssaiStreamUrl) return cleanStreamUrl(body.ssaiStreamUrl);

        const assetId = body.assets?.[0]?.id;
        if (!assetId) return null;
        const asset = await getJson<{ providers?: Array<{ sources?: Array<{ uri?: string }> }> }>(
            `${API}/assets/asset/${assetId}.json?f=providers`
        );
        const uris = (asset.providers || []).flatMap((p) => p.sources || []).map((s) => s.uri || "");
        const uri = uris.find((u) => /\.m3u8/.test(u)) || uris.find((u) => /^https?:\/\//.test(u));
        return uri ? cleanStreamUrl(uri) : null;
    } catch {
        return null;
    }
}

async function build(): Promise<ScrapedCatalogue> {
    const list = await getJson<{ channel?: { item?: XumoItem[] } }>(
        `${API}/channels/list/10006.json?sort=hybrid&geoId=unknown`
    );
    const items = (list.channel?.item || []).filter(
        (item) => item.guid?.value && item.title && item.properties?.is_live !== "false"
    );
    if (!items.length) throw new Error("xumo: channel list came back empty (geo-blocked?)");

    const urls = await mapWithConcurrency(items, 12, (item) => streamFor(item.guid!.value!));

    const channels: ScrapedChannel[] = [];
    items.forEach((item, index) => {
        const url = urls[index];
        if (!url) return;
        const id = item.guid!.value!;
        channels.push({
            id: idFor(id),
            name: item.title!.trim(),
            country: "US",
            countryName: "United States",
            countryFlag: "🇺🇸",
            categories: (item.genre || []).map((g) => (g.value || "").toLowerCase()).filter(Boolean),
            languages: [],
            logo: `https://image.xumo.com/v1/channels/channel/${id}/248x140.png?type=color_onBlack`,
            website: "https://play.xumo.com/",
            network: "Xumo Play",
            streams: [{ url, quality: "", labels: ["Geo-blocked"], referrer: "", userAgent: "", country: "US" }]
        });
    });

    if (!channels.length) throw new Error("xumo: no channel had a stream URL");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "Xumo Play") };
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

export const xumoScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Xumo Play",
    version: "1.4.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/xumo.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------

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
