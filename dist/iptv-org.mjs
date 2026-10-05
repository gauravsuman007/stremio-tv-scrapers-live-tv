/**
 * iptv-org's own curated, deduplicated JSON -- a real source, and the DEFAULT
 * scraper of the live-tv app (github.com/gauravsuman007/live-tv), which
 * fetches `dist/iptv-org.mjs` from this repository the first time it starts
 * on an empty data volume and then keeps it current through its ordinary
 * "Check for updates" on Settings > Live TV > Sources (a real `version`
 * increase here is what replaces it). It is also a worked example, beside
 * ntvst.mts, for a source that already publishes clean JSON across a handful
 * of small endpoints rather than one that has to be reverse-engineered.
 *
 * Its `iptv:` id prefix and the id `iptv-org` are never renamed: channel ids,
 * the nightly checks and the cached logos are all keyed under them. If you
 * want a similar scraper for a DIFFERENT source, copy this file and give it
 * a different id -- two scrapers sharing an id is refused everywhere a
 * scraper is loaded, first one loaded wins.
 */
const API = "https://iptv-org.github.io/api";
//: live-tv's merge step keeps this exact id-prefix, `iptv:`, as a
//: legacy exception granted specifically to whichever scraper has the id
//: "iptv-org" (by id, not by how it was loaded -- see live-tv's
//: AGENTS.md), so a deployment's existing favourites and
//: watch-progress rows keep matching once this scraper is imported. NEVER
//: change this scraper's own id away from "iptv-org" below, or this
//: exception stops applying and every existing id here becomes unrecognised.
const PREFIX = "iptv:";
const FETCH_TIMEOUT_MS = 30_000;
async function grab(name) {
    const response = await fetch(`${API}/${name}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok)
        throw new Error(`${name}.json -> ${response.status}`);
    return (await response.json());
}
/**
 * The country a "Geo-blocked" stream is locked to, for `ScrapedStream.country`
 * (the host then fetches it through that country's proxies, or directly when it
 * already exits there). iptv-org writes the lock as a label only; where it
 * applies is the stream's FEED's `broadcast_area` (`c/US`, `c/UK`, `r/EUR`...)
 * and failing that the channel's own country. Measured 2026-10-05: of 1,014
 * geo-blocked streams 784 have a feed that names exactly one country, and 27 of
 * those differ from the channel's (a UK channel's US-only amagi feed). An area
 * of several countries that does not include the channel's own, or none that
 * can be named, gives no country: tagging a guess would send a stream that may
 * play anywhere through a stranger's proxy. iptv-org's "UK" is "GB" to a proxy.
 */
function geoCountry(area, channelCountry) {
    const code = (value) => {
        const upper = (value || "").trim().toUpperCase();
        return /^[A-Z]{2}$/.test(upper) ? (upper === "UK" ? "GB" : upper) : undefined;
    };
    const named = (area || []).filter((entry) => entry.startsWith("c/")).map((entry) => code(entry.slice(2))).filter((entry) => Boolean(entry));
    const own = code(channelCountry);
    if (own && named.includes(own))
        return own;
    if (named.length === 1)
        return named[0];
    if (!(area || []).length)
        return own;
    return undefined;
}
async function build() {
    /*
        All six at once, and all six have to arrive. A half-built catalogue
        -- channels with no streams, or streams with no names -- is worse
        than this scraper saying it could not reach the list, because the
        merge step downstream cannot tell "empty on purpose" from "broken".
    */
    const [rawChannels, rawStreams, rawFeeds, rawLogos, rawCountries, blocked] = await Promise.all([
        grab("channels"),
        grab("streams"),
        grab("feeds"),
        grab("logos"),
        grab("countries"),
        grab("blocklist")
    ]);
    const banned = new Set(blocked.map((entry) => entry.channel));
    const mirrors = new Map();
    const areas = new Map(rawFeeds.filter((feed) => feed.id).map((feed) => [`${feed.channel}/${feed.id}`, feed.broadcast_area || []]));
    const homes = new Map(rawChannels.map((channel) => [channel.id, channel.country]));
    for (const raw of rawStreams) {
        // A stream with no channel is one nobody has matched to a name yet
        // -- no country, no category, no logo -- so it cannot be placed on
        // any rail and is dropped rather than shown as an untitled card.
        if (!raw.channel || banned.has(raw.channel))
            continue;
        const list = mirrors.get(raw.channel) || [];
        const labels = raw.labels || [];
        const country = labels.includes("Geo-blocked") ? geoCountry(raw.feed ? areas.get(`${raw.channel}/${raw.feed}`) : undefined, homes.get(raw.channel)) : undefined;
        list.push({
            url: raw.url,
            quality: raw.quality || "",
            labels,
            referrer: raw.referrer || "",
            userAgent: raw.user_agent || "",
            ...(country ? { country } : {})
        });
        mirrors.set(raw.channel, list);
    }
    const languages = new Map();
    for (const feed of rawFeeds) {
        if (feed.is_main && feed.languages?.length)
            languages.set(feed.channel, feed.languages);
    }
    /*
        THE BIGGEST RASTER LOGO, and a vector one only if there is nothing
        else -- an SVG logo breaks a proxy that can re-type raster formats
        but cannot sniff SVG (see the template's own note on this), which
        is iptv-org's own quirk (several American networks publish nothing
        else), not a rule every scraper needs to know.
    */
    const logos = new Map();
    const vector = (logo) => /svg/i.test(logo.format || "");
    for (const logo of rawLogos) {
        const best = logos.get(logo.channel);
        if (!best) {
            logos.set(logo.channel, logo);
            continue;
        }
        if (vector(best) && !vector(logo)) {
            logos.set(logo.channel, logo);
            continue;
        }
        if (vector(logo) && !vector(best))
            continue;
        if ((logo.width || 0) > (best.width || 0))
            logos.set(logo.channel, logo);
    }
    const named = new Map(rawCountries.map((entry) => [entry.code, entry]));
    const out = [];
    for (const raw of rawChannels) {
        const streams = mirrors.get(raw.id);
        // Four ways a channel is not offered: nothing carries it, it has
        // shut down, it is adult, or it is on the blocklist (nsfw and DMCA
        // complaints). A closed channel with a replacement is not silently
        // swapped for the replacement -- the replacement is in this list
        // on its own account.
        if (!streams || !streams.length)
            continue;
        if (raw.closed || raw.is_nsfw || banned.has(raw.id))
            continue;
        if (raw.categories.includes("xxx"))
            continue;
        const logo = logos.get(raw.id);
        const country = raw.country || "";
        out.push({
            id: PREFIX + raw.id,
            name: raw.name,
            country,
            countryName: named.get(country)?.name || country,
            countryFlag: named.get(country)?.flag || "",
            categories: raw.categories || [],
            languages: languages.get(raw.id) || [],
            logo: logo?.url || "",
            website: raw.website || "",
            network: raw.network || "",
            streams
        });
    }
    return { channels: out, ...layoutFor(out, named) };
}
/*
    THE RAILS, AND THE PAGES THAT START WITH THEM.

    Every rail the Live TV app can show comes from here or from another
    source; the app itself names no genre, country or language. They are
    DESCRIBED (`filter`) rather than listed, so the app fills each one from
    the finished index -- ranked by what last night's check proved, across
    every source at once, and for the household that is looking
    (`market`) -- instead of this scraper freezing a list of ids that goes
    stale the day a channel stops playing.

    Which rails exist is read from the data: a country appears when it has
    channels, a language when enough of them speak it. A rail that would
    hold two cards reads as a broken rail, so each kind has a floor.
*/
/** The host's own genre ids (taxonomy.ts there), with how each is titled. */
const GENRES = [
    ["news", "News"],
    ["entertainment", "Entertainment"],
    ["movies", "Movies"],
    ["sports", "Sports"],
    ["kids", "Kids"],
    ["music", "Music"],
    ["documentary", "Documentary"],
    ["lifestyle", "Lifestyle"],
    ["business", "Business"],
    ["devotional", "Devotional"],
    ["general", "General"]
];
/** iptv-org files cartoons under "animation" and family channels under
 *  "family"; a Kids rail that reads only "kids" misses most of what a
 *  child would watch. */
const KIDS = ["kids", "animation", "family"];
/** The host counts a rail over every source and drops the ones that stay small; these only keep a source from declaring nothing. */
const MIN_COUNTRY = 1;
const MIN_LANGUAGE = 1;
const MIN_KIDS = 4;
/** The languages the starting For you page has a rail for, in this order. */
const FOR_YOU = ["hin", "mal", "tam", "tel"];
/** Which part of the world a country is in, for the "Countries" groups. */
const CONTINENTS = [
    ["Asia", "asia", "AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE AE"],
    ["Europe", "europe", "AD AL AT BA BE BG BY CH CZ DE DK EE ES FI FO FR GB UK GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK"],
    ["Africa", "africa", "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW RE"],
    ["North America", "north-america", "US CA MX GL BM"],
    ["Latin America & Caribbean", "latin-america", "AG AI AR AW BB BO BQ BR BS BZ CL CO CR CU CW DM DO EC GD GT GY HN HT JM KN KY LC NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI MQ GP GF"],
    ["Oceania", "oceania", "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS"]
];
function continentName(code) {
    return CONTINENTS.find(([, , codes]) => codes.split(" ").includes(code.toUpperCase()))?.[0] || "Elsewhere";
}
function languageName(code) {
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
        return name && name !== code ? name : code.toUpperCase();
    }
    catch {
        return code.toUpperCase();
    }
}
function layoutFor(channels, countries) {
    const perCountry = new Map();
    const perLanguage = new Map();
    const kidsPerLanguage = new Map();
    for (const channel of channels) {
        if (channel.country)
            perCountry.set(channel.country, (perCountry.get(channel.country) || 0) + 1);
        const kids = channel.categories.some((category) => KIDS.includes(category));
        for (const code of channel.languages) {
            perLanguage.set(code, (perLanguage.get(code) || 0) + 1);
            if (kids)
                kidsPerLanguage.set(code, (kidsPerLanguage.get(code) || 0) + 1);
        }
    }
    const rails = [];
    for (const [id, heading] of GENRES) {
        rails.push({
            id: `genre-${id}`,
            heading,
            by: "Your countries first",
            group: "Genres",
            channelIds: [],
            filter: { genres: [id], market: "home-first" }
        });
    }
    const byName = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
    for (const [code, count] of [...perCountry.entries()].sort(byName)) {
        const name = countries.get(code)?.name;
        if (count < MIN_COUNTRY || !name || !/^[A-Za-z]{2,3}$/.test(code))
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
    for (const [code, count] of [...perLanguage.entries()].sort(byName)) {
        if (count < MIN_LANGUAGE || !/^[a-z]{2,3}$/.test(code))
            continue;
        const name = languageName(code);
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
    for (const [code, count] of [...kidsPerLanguage.entries()].sort(byName)) {
        if (count < MIN_KIDS || !/^[a-z]{2,3}$/.test(code))
            continue;
        rails.push({
            id: `kids-${code}`,
            heading: `Kids in ${languageName(code)}`,
            by: "Your countries first",
            group: "Kids/By language",
            channelIds: [],
            filter: { categories: KIDS, languages: [code], market: "home-first" }
        });
    }
    /*
        A KIND OF CHANNEL IN A PLACE, AND IN A LANGUAGE: "News in India",
        "Hindi Movies". Only for the places and languages with enough
        channels to have something in each kind; the host counts every
        combination over the whole index and does not offer the ones that
        come up small.
    */
    const COMBO_GENRES = GENRES.filter(([id]) => id !== "general");
    const COMBO_COUNTRY = 80;
    const COMBO_LANGUAGE = 60;
    for (const [code, count] of [...perCountry.entries()].sort(byName)) {
        const name = countries.get(code)?.name;
        if (count < COMBO_COUNTRY || !name || !/^[A-Za-z]{2,3}$/.test(code))
            continue;
        for (const [id, label] of COMBO_GENRES) {
            rails.push({
                id: `country-${code.toLowerCase()}-${id}`,
                heading: `${label} in ${name}`,
                by: "Most widely carried",
                group: `Countries/${continentName(code)}/${name}`,
                channelIds: [],
                filter: { countries: [code], genres: [id] }
            });
        }
    }
    for (const [code, count] of [...perLanguage.entries()].sort(byName)) {
        if (count < COMBO_LANGUAGE || !/^[a-z]{2,3}$/.test(code))
            continue;
        const name = languageName(code);
        for (const [id, label] of COMBO_GENRES) {
            rails.push({
                id: `language-${code}-${id}`,
                heading: `${name} ${label}`,
                by: "Your countries first",
                group: `Languages/${name}`,
                channelIds: [],
                filter: { languages: [code], genres: [id], market: "home-first" }
            });
        }
    }
    rails.push(...railsFor(channels, "iptv-org", "iptv-org"));
    const have = new Set(rails.map((rail) => rail.id));
    const pick = (ids, rows) => ids.filter((id) => have.has(id)).map((id) => ({ id, rows }));
    /*
        A genre page is one wall of that genre: rows 0, "as many lines as
        it takes", which is what these pages have always been. The For you
        page is rails of one line, the way a rail has always scrolled.
    */
    const pages = [
        { id: "foryou", title: "For you", rails: pick(FOR_YOU.map((code) => `language-${code}-home`), 1) },
        { id: "documentary", title: "Documentary", rails: pick(["genre-documentary"], 0) },
        { id: "sports", title: "Sports", rails: pick(["genre-sports"], 0) },
        { id: "kids", title: "Kids", rails: pick(["genre-kids"], 0) },
        { id: "news", title: "News", rails: pick(["genre-news"], 0) }
    ];
    return { rails, pages };
}
// -------------------------------------------------------------------------
// Category words and "everything on this source", declared like every other source does.
// -------------------------------------------------------------------------
/** Words the host's own genre rails (News, Sports, Movies ...) already carry under the same name. */
const GENRE_NAMES = new Set([
    "news", "sports", "movies", "kids", "music", "documentary", "lifestyle", "business", "entertainment", "general"
]);
/** Never offered as a rail: shopping and adult shelves. */
const UNLISTED = /\b(shop\w*|xxx|adult|erotic\w*|sinnlich\w*|telesales|18\+)\b/i;
function railsFor(channels, sourceId, sourceName, wanted = { countries: false, languages: false, categories: true }) {
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
            const name = languageName(code);
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
export const iptvOrgScraper = {
    id: "iptv-org",
    name: "iptv-org",
    version: "1.5.0",
    build
};
// -------------------------------------------------------------------------
// Manual test: `npx tsx scrapers/iptv-org.mts`
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
        console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails, ${(catalogue.pages || []).length} pages`);
        console.log(catalogue.channels[0] || "(none)");
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
