/*
    GEOBLOCKED STREAMS: THE SCRAPERS THAT TAG THEM (`ScrapedStream.country`),
    against stubbed network only -- a global `fetch` that answers fixtures.

    The promises: a stream a source says is locked is tagged with the country
    that locks it, and only such a stream; iptv-org's feed area beats the
    channel's own country, "UK" is "GB", and an area that cannot be pinned to
    one country gives no tag instead of a guess; Rakuten tags each market and
    makes BOTH of its resolver requests through `context.fetch` with that
    market's country, never its own `fetch`. Run with `npm test`.
*/
import assert from "node:assert";

import { iptvOrgScraper } from "../scrapers/iptv-org.mts";
import { famelackScraper } from "../scrapers/famelack.mts";
import { freetvScraper } from "../scrapers/freetv.mts";
import { tdtchannelsScraper } from "../scrapers/tdtchannels.mts";
import { xumoScraper } from "../scrapers/xumo.mts";
import { rakutenScraper } from "../scrapers/rakuten.mts";

let checks = 0;
const ok = (value: unknown, said: string): void => {
    assert.ok(value, said);
    checks += 1;
};

type Answer = { status?: number; json?: unknown; text?: string };
let route: (url: string, init?: RequestInit) => Answer | undefined = () => undefined;
const real = globalThis.fetch;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const answer = route(url, init);

    if (!answer) return new Response("not found", { status: 404 });

    return new Response(answer.json !== undefined ? JSON.stringify(answer.json) : answer.text ?? "", { status: answer.status ?? 200 });
}) as typeof fetch;

const channelsOf = async (scraper: { build: (context?: never) => Promise<{ channels: { id: string; streams: { url: string; country?: string; labels: string[] }[] }[] }> }) => (await scraper.build()).channels;
const streamsOf = (channels: Awaited<ReturnType<typeof channelsOf>>, id: string) => channels.find((channel) => channel.id.endsWith(id))?.streams ?? [];

// ---- iptv-org ---------------------------------------------------------------

const channel = (id: string, country: string) => ({ id, name: id, country, categories: ["news"], is_nsfw: false, closed: null, replaced_by: null, website: null, network: null });
const feed = (channelId: string, id: string, area: string[]) => ({ channel: channelId, id, is_main: true, languages: ["eng"], broadcast_area: area });
const stream = (channelId: string, feedId: string | null, url: string, labels: string[]) => ({ channel: channelId, feed: feedId, url, quality: null, labels, user_agent: null, referrer: null });

route = (url) => {
    const name = /api\/([a-z]+)\.json/.exec(url)?.[1];

    switch (name) {
        case "channels":
            return { json: [channel("Own.de", "DE"), channel("Bbc.uk", "UK"), channel("Multi.es", "ES"), channel("Odd.us", "US"), channel("Bare.fr", "FR"), channel("Wide.it", "IT"), channel("Free.ca", "CA")] };
        case "streams":
            return {
                json: [
                    stream("Own.de", "Main", "https://a.example/own.m3u8", ["Geo-blocked"]),
                    stream("Bbc.uk", "SD", "https://a.example/bbc.m3u8", ["Geo-blocked"]),
                    stream("Bbc.uk", "Us", "https://a.example/bbc-us.m3u8", ["Geo-blocked"]),
                    stream("Multi.es", "Eu", "https://a.example/multi-in.m3u8", ["Geo-blocked"]),
                    stream("Odd.us", "Eu", "https://a.example/odd.m3u8", ["Geo-blocked"]),
                    stream("Bare.fr", null, "https://a.example/bare.m3u8", ["Geo-blocked"]),
                    stream("Wide.it", "World", "https://a.example/wide.m3u8", ["Geo-blocked"]),
                    stream("Free.ca", "Main", "https://a.example/free.m3u8", [])
                ]
            };
        case "feeds":
            return {
                json: [
                    feed("Own.de", "Main", ["c/DE"]),
                    feed("Bbc.uk", "SD", ["c/UK"]),
                    feed("Bbc.uk", "Us", ["c/US"]),
                    feed("Multi.es", "Eu", ["c/ES", "c/PT", "c/AD"]),
                    feed("Odd.us", "Eu", ["c/DE", "c/AT"]),
                    feed("Wide.it", "World", ["r/WLD"]),
                    feed("Free.ca", "Main", ["c/CA"])
                ]
            };
        case "logos":
        case "blocklist":
            return { json: [] };
        case "countries":
            return { json: [{ code: "DE", name: "Germany", flag: "🇩🇪" }] };
        default:
            return undefined;
    }
};

{
    const channels = await channelsOf(iptvOrgScraper as never);
    const country = (id: string): (string | undefined)[] => streamsOf(channels, id).map((entry) => entry.country);

    ok(country("Own.de")[0] === "DE", "a geo-blocked stream whose feed is one country is tagged with it");
    ok(country("Bbc.uk")[0] === "GB", "iptv-org's UK is GB to a proxy");
    ok(country("Bbc.uk")[1] === "US", "a UK channel's US-only feed is locked to the US, not to the UK");
    ok(country("Multi.es")[0] === "ES", "several countries including the channel's own: the channel's");
    ok(country("Odd.us")[0] === undefined, "several countries that do not include the channel's own: no tag, not a guess");
    ok(country("Bare.fr")[0] === "FR", "no feed to say: the channel's own country");
    ok(country("Wide.it")[0] === undefined, "a region with no country in it cannot be pinned: no tag");
    ok(country("Free.ca")[0] === undefined, "a stream that is not labelled geo-blocked is never tagged");
}

// ---- Famelack -----------------------------------------------------------------

route = (url) => {
    if (url.endsWith("countries_metadata.json")) return { json: { gb: { country: "United Kingdom", hasChannels: true }, de: { country: "Germany", hasChannels: true } } };
    if (url.endsWith("/countries/gb.json")) return { json: [{ nanoid: "g1", name: "Locked UK", sources: { streams: ["https://f.example/uk.m3u8"] }, isGeoBlocked: true }, { nanoid: "g2", name: "Open UK", sources: { streams: ["https://f.example/uk2.m3u8"] } }] };
    if (url.endsWith("/countries/de.json")) return { json: [{ nanoid: "d1", name: "Locked DE", sources: { streams: ["https://f.example/de.m3u8"] }, isGeoBlocked: true }] };

    return undefined;
};

{
    const channels = await channelsOf(famelackScraper as never);

    ok(streamsOf(channels, "g1")[0]?.country === "GB", "famelack: a blocked channel is locked to its file's country");
    ok(streamsOf(channels, "g2")[0]?.country === undefined, "famelack: an open channel carries no country");
    ok(streamsOf(channels, "d1")[0]?.country === "DE", "famelack: another country's blocked channel");
}

// ---- Free-TV ------------------------------------------------------------------

route = () => ({
    text: [
        "#EXTM3U",
        '#EXTINF:-1 tvg-country="UK" group-title="UK",Blocked One Ⓖ',
        "https://t.example/one.m3u8",
        '#EXTINF:-1 tvg-country="DE" group-title="Germany",Open Two',
        "https://t.example/two.m3u8",
        '#EXTINF:-1 tvg-country="FR" group-title="France",Blocked Three Ⓖ',
        "https://t.example/three.m3u8"
    ].join("\n")
});

{
    const channels = await channelsOf(freetvScraper as never);

    ok(streamsOf(channels, "blocked-one")[0]?.country === "GB", "free-tv: Ⓖ locks a stream to the channel's country, UK as GB");
    ok(streamsOf(channels, "open-two")[0]?.country === undefined, "free-tv: an open stream is untagged");
    ok(streamsOf(channels, "blocked-three")[0]?.country === "FR", "free-tv: another country");
}

// ---- TDTChannels --------------------------------------------------------------

route = () => ({
    json: {
        countries: [
            {
                name: "Spain",
                ambits: [
                    {
                        name: "Nacionales",
                        channels: [
                            { name: "Chan SP", options: [{ format: "m3u8", url: "https://d.example/sp.m3u8", geo2: "SP" }] },
                            { name: "Chan CAT", options: [{ format: "m3u8", url: "https://d.example/cat.m3u8", geo2: "CAT" }] },
                            { name: "Chan Open", options: [{ format: "m3u8", url: "https://d.example/open.m3u8" }] },
                            { name: "Chan Other", options: [{ format: "m3u8", url: "https://d.example/other.m3u8", geo2: "FR" }] }
                        ]
                    }
                ]
            }
        ]
    }
});

{
    const channels = await channelsOf(tdtchannelsScraper as never);

    ok(streamsOf(channels, "chan-sp")[0]?.country === "ES" && streamsOf(channels, "chan-cat")[0]?.country === "ES", "tdtchannels: SP and CAT (Catalonia) are Spain");
    ok(streamsOf(channels, "chan-open")[0]?.country === undefined, "tdtchannels: an open option is untagged");
    ok(streamsOf(channels, "chan-other")[0]?.country === undefined, "tdtchannels: a lock the source names in a form we do not know gives no tag");
}

// ---- Xumo ---------------------------------------------------------------------

route = (url) => {
    if (url.includes("/channels/list/")) return { json: { channel: { item: [{ guid: { value: "x1" }, title: "Xumo One", genre: [{ value: "News" }], properties: { is_live: "true" } }] } } };
    if (url.includes("/broadcast.json")) return { json: { ssaiStreamUrl: "https://x.example/xumo.m3u8" } };

    return undefined;
};

{
    const channels = await channelsOf(xumoScraper as never);

    ok(streamsOf(channels, "x1")[0]?.country === "US", "xumo: every stream is locked to the US");
}

// ---- Rakuten: the resolver goes through context.fetch -----------------------------

route = (url) => {
    if (url.includes("/live_channels")) {
        const market = /market_code=([a-z]+)/.exec(url)?.[1];

        return { json: { data: market === "es" ? [{ id: "ch1", title: "Spanish One", labels: { languages: [{ id: "SPA" }] } }] : [] } };
    }

    return undefined;
};

{
    const channels = await channelsOf(rakutenScraper as never);
    const only = streamsOf(channels, "ch1")[0];

    ok(only?.country === "ES", "rakuten: a market's stream is locked to that market's country");

    const calls: { url: string; country?: string; method?: string }[] = [];
    const context = {
        fetch: async (url: string, options: { method?: string; country?: string } = {}) => {
            calls.push({ url, country: options.country, method: options.method });

            return url.includes("/avod/streamings")
                ? { status: 200, url, type: "application/json", text: JSON.stringify({ data: { stream_infos: [{ url: "https://mt.example/master.m3u8" }] } }), bytes: new Uint8Array() }
                : { status: 200, url, type: "application/vnd.apple.mpegurl", text: "#EXTM3U\n", bytes: new Uint8Array() };
        }
    };
    let direct = 0;

    route = () => {
        direct += 1;

        return undefined;
    };

    const resolve = rakutenScraper.resolvers!.rakuten!;
    const got = await resolve(only!.url, context as never);

    ok(got?.url === "https://mt.example/master.m3u8", "rakuten: the resolver returns the playlist it found");
    ok(calls.length === 2 && calls.every((call) => call.country === "ES"), "rakuten: the handshake and the playlist check both go through context.fetch for the market's country");
    ok(calls[0]?.method === "POST" && direct === 0, "rakuten: the handshake is a POST, and nothing used the resolver's own fetch");

    const bad = await resolve("https://rakuten.invalid/xx/1/SPA/ch1", context as never);

    ok(bad === null, "rakuten: an unknown market resolves to nothing");
}

globalThis.fetch = real;
console.log(`geo-tags: ${checks} checks ok`);
