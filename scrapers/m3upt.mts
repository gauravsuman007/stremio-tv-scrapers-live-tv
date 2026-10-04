/**
 * M3UPT (github.com/LITUATUI/M3UPT) -- Portuguese television: RTP, SIC,
 * TVI, CMTV, regional and thematic channels, "public and official streams
 * only" in the list's own words (about 190 channels; its VOD, webcam and radio
 * groups are left out).
 *
 *   `GET https://raw.githubusercontent.com/LITUATUI/M3UPT/main/M3U/M3UPT.m3u`
 *   -- `#EXTINF:-1 group-title tvg-id tvg-logo, <name>`, then
 *   `#EXTVLCOPT:http-user-agent|http-origin|http-referrer=...` lines, then
 *   the address. The options are carried onto the stream (`userAgent`,
 *   `referrer`, and `Origin` as a header), which is why RTP's streams play.
 *   Only the `TV` group is kept.
 *
 * What returns nothing: GitHub unreachable (the build throws and the host
 * keeps the last good catalogue).
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


const SCRAPER_ID = "m3upt";

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


const PLAYLIST = "https://raw.githubusercontent.com/LITUATUI/M3UPT/main/M3U/M3UPT.m3u";
const COUNTRY: [string, string, string] = ["PT", "Portugal", "🇵🇹"];
const LANGUAGE = "por";
const WEBSITE = "https://m3upt.com/";
const KEEP_GROUPS: RegExp | null = /^TV$/i;

const CATEGORY_WORDS: [RegExp, string][] = [
    [/news|noticias|informa|jornal|cnn|euronews|sic not|tvi 24|rtp3|nachricht|tagesschau|welt|n-tv|phoenix/i, "news"],
    [/sport|desporto|futebol|benfica|sporting|eleven|dazn|eurosport|sky sport|sportdigital|spox|motor/i, "sports"],
    [/kids|infant|criança|crian|cartoon|nick|disney|junior|boomerang|kika|toggo|baby/i, "kids"],
    [/movie|film|cinema|hollywood|axn|kino|sky cinema/i, "movies"],
    [/music|musik|musica|mtv|vevo|viva|radio|rádio/i, "music"],
    [/doc|discovery|history|nature|natgeo|nat geo|planet|geo\b|arte\b|3sat/i, "documentary"]
];

function categoryOf(name: string): string[] {
    const hit = CATEGORY_WORDS.find(([pattern]) => pattern.test(name));
    return [hit ? hit[1] : "general"];
}

function attribute(line: string, key: string): string {
    return new RegExp(`${key}="([^"]*)"`).exec(line)?.[1]?.trim() || "";
}

/** `#EXTVLCOPT:http-user-agent=...` and friends, which sit between the info line and the address. */
function playerOptions(options: string[]): { userAgent: string; referrer: string; headers: Record<string, string> } {
    let userAgent = "";
    let referrer = "";
    const headers: Record<string, string> = {};
    for (const line of options) {
        const match = /^#EXTVLCOPT:http-(user-agent|referrer|referer|origin)=(.*)$/i.exec(line.trim());
        if (!match) continue;
        const value = match[2]!.trim().replace(/^"|"$/g, "");
        if (!value) continue;
        const key = match[1]!.toLowerCase();
        if (key === "user-agent") userAgent = value;
        else if (key === "origin") headers["Origin"] = value;
        else referrer = value;
    }
    return { userAgent, referrer, headers };
}

async function build(): Promise<ScrapedCatalogue> {
    const response = await withTimeout((signal) => fetch(PLAYLIST, { signal }), 60_000);
    if (!response.ok) throw new Error(`m3upt: playlist -> ${response.status}`);
    const lines = (await response.text()).split(/\r?\n/);
    const byKey = new Map<string, ScrapedChannel>();

    for (let i = 0; i < lines.length; i++) {
        const info = lines[i]!;
        if (!info.startsWith("#EXTINF")) continue;
        const options: string[] = [];
        let address = "";
        for (let j = i + 1; j < lines.length && j < i + 8; j++) {
            const line = (lines[j] || "").trim();
            if (line.startsWith("#EXTINF")) break;
            if (line.startsWith("#EXTVLCOPT")) options.push(line);
            else if (/^https?:\/\//.test(line)) { address = line; break; }
        }
        if (!address || !/\.m3u8?(\?|$)/i.test(address)) continue;
        if (KEEP_GROUPS && !KEEP_GROUPS.test(attribute(info, "group-title"))) continue;
        const name = info.slice(info.lastIndexOf(",") + 1).trim();
        if (!name) continue;
        const { userAgent, referrer, headers } = playerOptions(options);
        const key = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
        const stream: ScrapedStream = { url: address, quality: "", labels: [], referrer, userAgent, ...(Object.keys(headers).length ? { headers } : {}) };

        const known = byKey.get(key);
        if (known) {
            if (!known.streams.some((s) => s.url === address)) known.streams.push(stream);
            continue;
        }
        byKey.set(key, {
            id: idFor(key),
            name,
            country: COUNTRY[0],
            countryName: COUNTRY[1],
            countryFlag: COUNTRY[2],
            categories: categoryOf(name),
            languages: [LANGUAGE],
            logo: attribute(info, "tvg-logo"),
            website: WEBSITE,
            network: "",
            streams: [stream]
        });
    }

    const channels = [...byKey.values()];
    if (!channels.length) throw new Error("m3upt: no channel parsed");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "M3UPT") };
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

export const m3uptScraper: Scraper = {
    id: SCRAPER_ID,
    name: "M3UPT (Portugal)",
    version: "1.0.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/m3upt.mts` -- prints a channel count and the first channel,
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
