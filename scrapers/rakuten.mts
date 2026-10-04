/**
 * Rakuten TV live channels -- the free, ad-supported linear channels of
 * Rakuten TV in five markets (Germany, Spain, France, Italy, UK: about 28
 * each, mostly the same FAST channels in each language).
 *
 *   1. `GET https://gizmo.rakuten.tv/v3/live_channels?classification_id=<c>
 *      &device_identifier=web&locale=<l>&market_code=<m>` -> `{ data: [{
 *      id, title, channel_number, images, labels: { tags, languages: [{ id:
 *      "DEU" }] } }] }`. Public, no key. (`classification_id` per market:
 *      de 307, es 5, fr 23, it 36, uk 18; a wrong one answers 400.)
 *   2. `POST https://gizmo.rakuten.tv/v3/avod/streamings?device_identifier=web
 *      &market_code=<m>` with `{ audio_language: <the channel's language id>,
 *      audio_quality: "2.0", classification_id, content_id: <channel id>,
 *      content_type: "live_channels", device_identifier: "web",
 *      device_serial: "not_implemented", device_stream_video_quality: "FHD",
 *      player: "web:HLS-NONE:NONE", subtitle_language: "MIS", video_type:
 *      "stream" }` -> `data.stream_infos[0].url`, an AWS MediaTailor HLS master
 *      minted per request. THE MARKET MUST MATCH THE CALLER'S COUNTRY: from
 *      Germany the Spanish market answers `error.geo_market_not_allowed_for_user_market`
 *      ("you are in Germany"). So a channel carries one stream per market,
 *      each a handle (`https://rakuten.invalid/<market>/<classification>/<audio>/<id>`)
 *      resolved at play time; on any host only the markets of its own country
 *      play, and the resolver returns `null` for the others (the host drops them).
 *
 * Verified 2026-10-05 from a German address: the German market resolves and
 * plays. What returns nothing: a market whose classification id changed
 * (400 -> skipped), the geo check (-> `null`).
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


const SCRAPER_ID = "rakuten";

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


const API = "https://gizmo.rakuten.tv/v3";
const RESOLVER = "rakuten";
const HANDLE_HOST = "rakuten.invalid";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MARKETS: { market: string; classification: number; locale: string; country: string; name: string }[] = [
    { market: "de", classification: 307, locale: "de", country: "DE", name: "Germany" },
    { market: "es", classification: 5, locale: "es", country: "ES", name: "Spain" },
    { market: "fr", classification: 23, locale: "fr", country: "FR", name: "France" },
    { market: "it", classification: 36, locale: "it", country: "IT", name: "Italy" },
    { market: "uk", classification: 18, locale: "en", country: "GB", name: "United Kingdom" }
];

const CATEGORY_WORDS: [RegExp, string][] = [
    [/news|nachricht|noticia|actualit|notizie|france 24|cna|cgtn|africanews|euronews|welt/i, "news"],
    [/sport|fussball|futbol|calcio/i, "sports"],
    [/kids|kinder|infantil|enfant|bambini|cartoon|junior/i, "kids"],
    [/movie|film|cine|kino/i, "movies"],
    [/music|musik|musica|musique|mtv|hits/i, "music"],
    [/doc|natur|wild|history|geschichte|planet|crime/i, "documentary"]
];

interface RakutenChannel {
    id?: string;
    title?: string;
    images?: Record<string, string>;
    labels?: { tags?: { name?: string }[]; languages?: { id?: string }[] };
}

function flagOf(code: string): string {
    return String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
}

function handleFor(market: string, classification: number, audio: string, id: string): string {
    return `https://${HANDLE_HOST}/${market}/${classification}/${encodeURIComponent(audio)}/${encodeURIComponent(id)}`;
}

async function resolveStream(handle: string): Promise<ResolvedStream | null> {
    try {
        const url = new URL(handle);
        if (url.hostname !== HANDLE_HOST) return null;
        const [market, classification, audio, id] = url.pathname.slice(1).split("/").map(decodeURIComponent);
        if (!MARKETS.some((m) => m.market === market) || !/^\d+$/.test(classification || "") || !/^[A-Z]{3}$/.test(audio || "") || !id || !/^[A-Za-z0-9_.-]+$/.test(id)) return null;
        const response = await withTimeout((signal) => fetch(`${API}/avod/streamings?device_identifier=web&market_code=${market}`, {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
            body: JSON.stringify({
                audio_language: audio,
                audio_quality: "2.0",
                classification_id: Number(classification),
                content_id: id,
                content_type: "live_channels",
                device_identifier: "web",
                device_serial: "not_implemented",
                device_stream_video_quality: "FHD",
                player: "web:HLS-NONE:NONE",
                subtitle_language: "MIS",
                video_type: "stream"
            })
        }), 15_000);
        if (!response.ok) return null;
        const body = (await response.json()) as { data?: { stream_infos?: { url?: string }[] } };
        const address = body.data?.stream_infos?.[0]?.url;
        if (!address || !/^https:\/\//.test(address)) return null;
        const playlist = await withTimeout((signal) => fetch(address, { signal, headers: { "User-Agent": BROWSER_UA } }), 15_000);
        const text = playlist.ok ? await playlist.text() : "";
        return text.includes("#EXTM3U") ? { url: address, referrer: "", userAgent: BROWSER_UA } : null;
    } catch {
        return null;
    }
}

async function build(): Promise<ScrapedCatalogue> {
    const byId = new Map<string, ScrapedChannel>();
    for (const market of MARKETS) {
        let list: RakutenChannel[] = [];
        try {
            const response = await withTimeout((signal) => fetch(`${API}/live_channels?classification_id=${market.classification}&device_identifier=web&locale=${market.locale}&market_code=${market.market}`, { signal, headers: { "User-Agent": BROWSER_UA } }));
            if (!response.ok) continue;
            list = ((await response.json()) as { data?: RakutenChannel[] }).data || [];
        } catch {
            continue;
        }
        for (const channel of list) {
            const title = (channel.title || "").trim();
            if (!channel.id || !title) continue;
            const audio = channel.labels?.languages?.[0]?.id || "";
            if (!/^[A-Z]{3}$/.test(audio)) continue;
            const stream: ScrapedStream = {
                url: handleFor(market.market, market.classification, audio, channel.id),
                quality: "",
                labels: [market.name],
                referrer: "",
                userAgent: BROWSER_UA,
                resolver: RESOLVER
            };
            const known = byId.get(channel.id);
            if (known) { known.streams.push(stream); continue; }
            const text = `${title} ${(channel.labels?.tags || []).map((tag) => tag.name || "").join(" ")}`;
            byId.set(channel.id, {
                id: idFor(channel.id),
                name: title,
                country: market.country,
                countryName: market.name,
                countryFlag: flagOf(market.country),
                categories: [CATEGORY_WORDS.find(([pattern]) => pattern.test(text))?.[1] || "general"],
                languages: [audio.toLowerCase()],
                logo: channel.images?.artwork || channel.images?.artwork_negative || "",
                website: "https://rakuten.tv/",
                network: "Rakuten TV",
                streams: [stream]
            });
        }
    }
    const channels = [...byId.values()];
    if (!channels.length) throw new Error("rakuten: no market answered");
    return { channels, rails: railsFor(channels, SCRAPER_ID, "Rakuten TV") };
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

export const rakutenScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Rakuten TV",
    version: "1.0.0",
    resolvers: { [RESOLVER]: resolveStream },
    build
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/rakuten.mts` -- prints a channel count and the first channel,
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
