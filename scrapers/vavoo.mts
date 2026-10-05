/**
 * vavoo.to -- ~10k European/Middle-Eastern live-TV entries, and the same
 * catalogue re-skinned under `kool.to`/`kool.ws`, `huhu.to` and `oha.to`.
 *
 * All four sites are the same "MediaHubMX" web player pointed at an addon
 * on their own origin. vavoo/kool expose it as the `mediahubmx` engine,
 * huhu/oha as the older `mediaurl` engine; channel ids, names and the
 * resolved stream servers are identical across all four (verified
 * 2026-09-30), so this one scraper covers the whole family and the others
 * are only fallbacks if vavoo.to itself is down.
 *
 *   1. `POST /mediahubmx-catalog.json` (`User-Agent: MediaHubMX/2`, JSON
 *      body with `catalogId: "iptv"`, a `filter.group` and a `cursor`)
 *      pages 300 items at a time. An empty filter silently means
 *      "Germany", so every group named in the first response's
 *      `features.filter` has to be walked separately.
 *   2. Each item's `url` (`https://vavoo.to/vavoo-iptv/play/<id>`) is NOT
 *      playable -- it 404s. `POST /mediahubmx-resolve.json` with that url
 *      answers `[{ url }]`: a plain-HTTP `http://<ip>:8008/sunshine/
 *      <opaque token>/hls/index.m3u8` that plays with no headers at all.
 *      No signature is needed from a web client (the native apps' signed
 *      `addonSig` ping is only required for the native "proxy" features).
 *
 * The resolved token is opaque (encrypted, so its lifetime can't be read
 * off it) -- a URL was confirmed still playing ~55 minutes after being
 * resolved; the real lifetime is unknown. If it turns out shorter than
 * the host's twelve-hour rebuild, entries will go stale between rebuilds
 * and this should move to a shorter-interval task (see showroom.mts).
 *
 * The same channel usually appears several times with a suffix naming its
 * upstream (`"ZDF .c"`, `"ZDF HD .b"`, `"ZDF |H"` on huhu); those are
 * folded into ONE channel per (group, cleaned name) with every copy as a
 * separate mirror stream.
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

const SCRAPER_ID = "vavoo";

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

/** Tried in order; the first one whose catalogue answers is used for
 *  every request in this build. */
const HOSTS: Array<{ base: string; engine: "mediahubmx" | "mediaurl" }> = [
    { base: "https://vavoo.to", engine: "mediahubmx" },
    { base: "https://kool.to", engine: "mediahubmx" },
    { base: "https://huhu.to", engine: "mediaurl" },
    { base: "https://oha.to", engine: "mediaurl" }
];

type Host = (typeof HOSTS)[number];

/** Group name -> ISO country code and ISO 639-3 language. Groups that
 *  span several countries ("Arabia", "Balkans") get no country. */
const GROUPS: Record<string, { country: string; language: string; category?: string }> = {
    Albania: { country: "AL", language: "sqi" },
    Arabia: { country: "", language: "ara" },
    Balkans: { country: "", language: "" },
    Bulgaria: { country: "BG", language: "bul" },
    Croatia: { country: "HR", language: "hrv" },
    France: { country: "FR", language: "fra" },
    "France Sport": { country: "FR", language: "fra", category: "sports" },
    Germany: { country: "DE", language: "deu" },
    Italy: { country: "IT", language: "ita" },
    Netherlands: { country: "NL", language: "nld" },
    Poland: { country: "PL", language: "pol" },
    Portugal: { country: "PT", language: "por" },
    Romania: { country: "RO", language: "ron" },
    Russia: { country: "RU", language: "rus" },
    Spain: { country: "ES", language: "spa" },
    Turkey: { country: "TR", language: "tur" },
    "United Kingdom": { country: "GB", language: "eng" }
};

/**
 * "Arabia" and "Balkans" are grab-bags with no country. The names usually
 * say where a channel is from, in words that mean one place and only that,
 * so those are read; anything ambiguous keeps no country.
 */
const NAME_COUNTRIES: [RegExp, string][] = [
    [/\b(algeria|alg|dz)\b/i, "DZ"],
    [/\b(morocco|maroc|2m)\b/i, "MA"],
    [/\b(tunisia|tunisie)\b/i, "TN"],
    [/\b(libya)\b/i, "LY"],
    [/\b(egypt|misr)\b/i, "EG"],
    [/\b(jordan|amman)\b/i, "JO"],
    [/\b(palestine)\b/i, "PS"],
    [/\b(lebanon|liban)\b/i, "LB"],
    [/\b(syria)\b/i, "SY"],
    [/\b(iraq|iraqi)\b/i, "IQ"],
    [/\b(kuwait)\b/i, "KW"],
    [/\b(oman)\b/i, "OM"],
    [/\b(qatar|kass)\b/i, "QA"],
    [/\b(ksa|saudi|ssc)\b/i, "SA"],
    [/\b(abu dhabi|dubai|uae)\b/i, "AE"],
    [/\b(bahrain)\b/i, "BH"],
    [/\b(yemen|aden)\b/i, "YE"],
    [/\b(sudan)\b/i, "SD"],
    [/\b(afghanistan|afg)\b/i, "AF"],
    [/\b(argentina|arg)\b/i, "AR"]
];

const COUNTRY_TITLES: Record<string, string> = {
    DZ: "Algeria", MA: "Morocco", TN: "Tunisia", LY: "Libya", EG: "Egypt", JO: "Jordan", PS: "Palestine", LB: "Lebanon",
    SY: "Syria", IQ: "Iraq", KW: "Kuwait", OM: "Oman", QA: "Qatar", SA: "Saudi Arabia", AE: "United Arab Emirates",
    BH: "Bahrain", YE: "Yemen", SD: "Sudan", AF: "Afghanistan", AR: "Argentina"
};

function countryTitle(code: string): string {
    return COUNTRY_TITLES[code] || code;
}

function countryFromName(name: string): string {
    return NAME_COUNTRIES.find(([pattern]) => pattern.test(name))?.[1] || "";
}

interface CatalogItem {
    ids?: { id?: string };
    url?: string;
    name?: string;
    group?: string;
    logo?: string;
}

interface CatalogPage {
    features?: { filter?: Array<{ id?: string; values?: string[] }> };
    nextCursor?: number | null;
    items?: CatalogItem[];
}

async function post<T>(host: Host, action: "catalog" | "resolve", body: Record<string, unknown>): Promise<T> {
    const response = await withTimeout((signal) =>
        fetch(`${host.base}/${host.engine}-${action}.json`, {
            method: "POST",
            signal,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": host.engine === "mediahubmx" ? "MediaHubMX/2" : "MediaUrl/2"
            },
            body: JSON.stringify({ language: "de", region: "AT", clientVersion: "3.0.2", ...body })
        })
    );
    if (!response.ok) throw new Error(`${host.base} ${action} -> ${response.status}`);
    return (await response.json()) as T;
}

function catalogPage(host: Host, group: string, cursor: number): Promise<CatalogPage> {
    return post<CatalogPage>(host, "catalog", {
        catalogId: "iptv",
        id: "iptv",
        adult: false,
        search: "",
        sort: "name",
        filter: group ? { group } : {},
        cursor
    });
}

async function pickHost(): Promise<{ host: Host; groups: string[] }> {
    const errors: string[] = [];
    for (const host of HOSTS) {
        try {
            const first = await catalogPage(host, "", 0);
            const groups = first.features?.filter?.find((f) => f.id === "group")?.values || [];
            if (groups.length) return { host, groups };
            errors.push(`${host.base}: no groups`);
        } catch (cause) {
            errors.push(String(cause));
        }
    }
    throw new Error(`vavoo: every host failed -- ${errors.join("; ")}`);
}

async function listGroup(host: Host, group: string): Promise<CatalogItem[]> {
    const items: CatalogItem[] = [];
    let cursor: number | null | undefined = 0;
    // Bounded, in case a server ever stops advancing its cursor.
    for (let page = 0; cursor !== null && cursor !== undefined && page < 100; page++) {
        const result: CatalogPage = await catalogPage(host, group, cursor);
        items.push(...(result.items || []));
        cursor = result.nextCursor;
    }
    return items;
}

async function resolve(host: Host, url: string): Promise<string | null> {
    try {
        const result = await post<Array<{ url?: string }>>(host, "resolve", { url });
        const resolved = result[0]?.url;
        return resolved && /^https?:\/\//.test(resolved) ? resolved : null;
    } catch {
        return null;
    }
}

/** `"ZDF HD .c"` / `"ZDF |H"` -> `"ZDF"`. */
function cleanName(raw: string): string {
    return raw
        .replace(/\s+(\.[a-z0-9]{1,3}|\|[A-Z0-9]{1,3})\s*$/i, "")
        .replace(/\s+\((backup|[0-9]+)\)\s*$/i, "")
        .replace(/\s+(FHD|UHD|HD|SD|4K|HEVC|H265|RAW)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

function qualityOf(raw: string): string {
    if (/\b(UHD|4K)\b/i.test(raw)) return "4K";
    if (/\bFHD\b/i.test(raw)) return "1080p";
    if (/\bHD\b/i.test(raw)) return "720p";
    return "";
}

function slug(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

function flagEmoji(code: string): string {
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// BEGIN logo-directory -- identical in every scraper that fills in missing logos. scripts/sync-blocks.mjs keeps the copies in step.

/*
    A SOURCE THAT HAS NO LOGO FOR A CHANNEL BORROWS ONE FROM IPTV-ORG'S
    DIRECTORY, by name. The directory is iptv-org's public `channels.json`
    (name, alternate names, country) joined to `logos.json`; it is held for the
    life of the process and fetched once. Two rules, both about not putting the
    wrong logo on a channel:
      1. the same folded name (or alternate name) in the SAME country;
      2. failing that, a name of five characters or more that every
         directory channel of that name gives ONE logo for, in any country.
    Nothing is borrowed for a name the directory does not know, and a logo the
    source already supplied is kept unless `dead` says its host is gone.
*/
interface LogoDirectory {
    byCountry: Map<string, string>;
    byName: Map<string, Set<string>>;
}

const LOGO_API = "https://iptv-org.github.io/api";
let logoDirectory: Promise<LogoDirectory | null> | null = null;

function foldLogoName(name: string): string {
    return name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/^\s*(?:\[[^\]]{1,6}\]\s*)+/, "")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/\b(hd\+?|fhd|uhd|sd|4k|hevc|raw|backup|feed|\d{3,4}p)\b/g, "")
        .replace(/[^a-z0-9]+/g, "");
}

async function loadLogoDirectory(): Promise<LogoDirectory | null> {
    try {
        const get = async (file: string): Promise<unknown[]> => {
            const response = await fetch(`${LOGO_API}/${file}.json`, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(`${file}.json -> ${response.status}`);
            return (await response.json()) as unknown[];
        };
        const [channels, logos] = (await Promise.all([get("channels"), get("logos")])) as [
            Array<{ id?: string; name?: string; alt_names?: string[]; country?: string }>,
            Array<{ channel?: string; url?: string; width?: number; format?: string }>
        ];
        /* The biggest raster logo per channel; a vector only when there is nothing else (a panel cannot sniff SVG). */
        const best = new Map<string, { url: string; width: number; vector: boolean }>();

        for (const logo of logos) {
            if (!logo.channel || !logo.url) continue;
            const candidate = { url: logo.url, width: logo.width || 0, vector: /svg/i.test(logo.format || "") };
            const held = best.get(logo.channel);
            if (!held || (held.vector && !candidate.vector) || (held.vector === candidate.vector && candidate.width > held.width)) best.set(logo.channel, candidate);
        }

        const directory: LogoDirectory = { byCountry: new Map(), byName: new Map() };

        for (const channel of channels) {
            const logo = channel.id ? best.get(channel.id) : undefined;
            if (!logo) continue;

            for (const name of [channel.name || "", ...(channel.alt_names || [])]) {
                const folded = foldLogoName(name);
                if (folded.length < 3) continue;
                directory.byCountry.set(`${folded}|${(channel.country || "").toUpperCase()}`, logo.url);
                (directory.byName.get(folded) || directory.byName.set(folded, new Set()).get(folded)!).add(logo.url);
            }
        }

        return directory;
    } catch (cause) {
        console.error("logo directory unavailable:", cause);
        logoDirectory = null;
        return null;
    }
}

/** Fills `logo` on channels that have none (or whose own is `dead`). Never throws; returns how many it filled. */
async function fillLogos(channels: Array<{ name: string; country: string; logo: string }>, dead?: (logo: string) => boolean): Promise<number> {
    const directory = await (logoDirectory ||= loadLogoDirectory());
    if (!directory) return 0;
    let filled = 0;

    for (const channel of channels) {
        if (channel.logo && !(dead && dead(channel.logo))) continue;

        const folded = foldLogoName(channel.name);
        if (folded.length < 3) continue;

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

async function build(): Promise<ScrapedCatalogue> {
    const { host, groups } = await pickHost();

    const perGroup = await mapWithConcurrency(groups, 4, async (group) => ({
        group,
        items: await listGroup(host, group).catch((cause) => {
            console.error(`vavoo: group ${group} failed`, cause);
            return [] as CatalogItem[];
        })
    }));

    const flat = perGroup.flatMap(({ group, items }) =>
        items.filter((item) => item.url && item.name).map((item) => ({ group, item }))
    );
    if (!flat.length) throw new Error("vavoo: catalogue came back empty");

    const resolved = await mapWithConcurrency(flat, 24, (entry) => resolve(host, entry.item.url!));

    const byKey = new Map<string, ScrapedChannel>();
    const channels: ScrapedChannel[] = [];

    flat.forEach(({ group, item }, index) => {
        const url = resolved[index];
        if (!url) return;
        const name = cleanName(item.name!);
        if (!name) return;

        const key = `${slug(group)}-${slug(name)}`;
        const stream: ScrapedStream = { url, quality: qualityOf(item.name!), labels: [], referrer: "", userAgent: "" };
        const existing = byKey.get(key);
        if (existing) {
            existing.streams.push(stream);
            if (!existing.logo && item.logo) existing.logo = item.logo;
            return;
        }

        const known = GROUPS[group] || { country: "", language: "" };
        const guessed = known.country ? "" : countryFromName(item.name!);
        const meta = guessed ? { ...known, country: guessed } : known;
        const channel: ScrapedChannel = {
            id: idFor(key),
            name,
            country: meta.country,
            countryName: guessed ? countryTitle(guessed) : meta.country ? group : "",
            countryFlag: flagEmoji(meta.country),
            categories: meta.category ? [meta.category] : [],
            languages: meta.language ? [meta.language] : [],
            logo: item.logo || "",
            website: "",
            network: "",
            streams: [stream]
        };
        byKey.set(key, channel);
        channels.push(channel);
    });

    if (!channels.length) throw new Error("vavoo: no channel resolved to a stream");
    await fillLogos(channels, (logo) => /logo\.huhu\.to/.test(logo));

    return { channels, rails: railsFor(channels, SCRAPER_ID, "vavoo.to") };
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

export const vavooScraper: Scraper = {
    id: SCRAPER_ID,
    name: "vavoo.to (+ kool/huhu/oha)",
    version: "1.3.0",
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/vavoo.mts` -- prints a channel count and the first
// channel found.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
            console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
            console.log(`${catalogue.channels.reduce((n, c) => n + c.streams.length, 0)} streams`);
            console.log(catalogue.channels[0] || "(none)");
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
