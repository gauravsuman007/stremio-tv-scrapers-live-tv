/**
 * Streamed (streamed.pk and its mirrors) -- the biggest free live-sports
 * catalogue there is: every major league, boxing/UFC/PPV cards, motorsport,
 * ~150-200 events live at any hour. Also the backend behind reedstreams,
 * SportsBite, Fantastic Soda and (by way of `embed.st`) the Streamed rows of
 * crichd, so one working resolver here covers all of them.
 *
 * THE CHAIN (all verified 2026-10-03, football + PPV boxing + NFL)
 * -----------------------------------------------------------------
 *   1. `GET <api>/api/matches/live` -> `[{ id, title, category, popular,
 *      poster, teams: {home, away: {name, badge}}, sources: [{source, id}] }]`.
 *      `<api>` is `streamed.pk`, `streamed.st`... -- several of them are
 *      blocked by DNS in some countries (a German ISP's CUII list, for one),
 *      so a few mirrors are tried in turn.
 *   2. `GET <api>/api/stream/<source>/<id>` -> `[{ streamNo, language, hd,
 *      embedUrl, viewers }]`. Sources seen: `admin` (PPV), `delta`,
 *      `foxtrot`, `golf`, `hotel`...
 *   3. THE EMBED'S OWN HANDSHAKE, which is what the Rust player in
 *      `embed.st` (`lock.wasm`, ~190 KB, a wasm-bindgen module that also
 *      drives the DOM and `eval`s) does; none of that is needed:
 *        POST https://embed.st/fetch
 *          Referer: https://embed.st/embed/<source>/<id>/<n>
 *          Origin:  https://embed.st
 *          body (protobuf): 1:<source> 2:<id> 3:"<n>"   (strings)
 *      The answer is a protobuf `{1: bytes}` and a response header `goat`
 *      (32 letters, `NOSCRPS` + 25 random). The bytes are TEXT in a fixed
 *      64-symbol alphabet (`ALPHABET`, pad `T`), which decodes to
 *      `nonce[12] || ciphertext || tag[16]`; the ciphertext is **ChaCha20,
 *      key = the `goat` header as ASCII, counter starting at 1** (RFC 8439
 *      AEAD layout; the tag is not checked). Plaintext = the playlist URL:
 *      `https://lbN.strmd.st/secure/<32 random letters>/<source>/stream/<id>/<n>/playlist.m3u8`
 *      (admin's has an `rtmp/stream/<opaque>` path). Found by snapshotting
 *      the module's linear memory around the decode (the 8-char prefix of
 *      the text is the nonce's first bytes, and the plaintext sits beside
 *      the ciphertext), then confirming the key by XORing the known URL
 *      against the keystream. Alphabet recovered from five runs, no
 *      conflicts. This runs none of the site's code.
 *   4. The playlist wants `Referer: https://embed.st/` and nothing else.
 *      It is a 2-rendition master (`high/mono.m3u8` 1080p, `low/mono.m3u8`
 *      540p, relative URIs under the token path); variants are live media
 *      playlists of `https://p16-common-sign.tiktokcdn-eu.com/...image`
 *      URLs. The token is NOT single use (an earlier "403" was TLS, below).
 *   5. THE SEGMENTS ARE WEBP IMAGES (or plain TS, per source): `RIFF....WEBP`
 *      + a small VP8L stub, then the MPEG-TS -- inside an `EXIF` chunk
 *      (`admin`, ~6 MB, sync byte at file offset 42) or straight after the
 *      stub (`hotel`, offset 36); `delta` serves bare TS. A playlist is
 *      either a 2-rendition master (`admin`: `high/mono.m3u8` 1080p,
 *      `low/mono.m3u8` 540p) or a single media playlist (`delta`, `hotel`:
 *      `/m/<token>` segment URLs on the same `lbN` host). `decoders.webpexif`
 *      handles all three.
 *
 * THE CDN FINGERPRINTS TLS. `lbN.strmd.st` answers 403 to Node's default
 * TLS 1.3 ClientHello -- from `fetch`, `https.request`, with any header set,
 * any UA, ALPN or none -- and 200 to curl, ffmpeg, a browser, and **Node
 * restricted to TLS 1.2** (`maxVersion: "TLSv1.2"`), the same request. An
 * early "single-use token" theory came from a race with the browser. The
 * host therefore has to retry a 403 over TLS 1.2 (live-tv >= 1.10, in
 * `fetchvia.ts`); this scraper's own requests (the `/fetch` POST, the API)
 * need nothing special.
 *
 * Handles, not URLs: the playlist's `secure/<token>` is minted per request
 * and short-lived, so each stream's `url` is a handle
 * (`https://streamed.invalid/<source>/<id>/<n>`) resolved at play time by
 * `resolvers.streamed`. Needs live-tv >= 1.10.
 *
 * A feed whose playlist answers but whose newest segment is 404 (delta, for a
 * finished game: the segments redirect to a broadcaster CDN that has deleted
 * them) resolves to `null` -- see `onAir`.
 *
 * What returns nothing: a source whose embed answers `Not Found` for the
 * playlist (a listed stream that is not actually on air), `/fetch`
 * answering anything but 200, a changed alphabet/key derivation (the decoded
 * text will not start with `https://`), all of which make the resolver
 * return `null` -- never throw, never guess.
 */

// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------

import { createDecipheriv } from "node:crypto";
import { request } from "node:https";

interface ScrapedStream {
    url: string;
    quality: string;
    labels: string[];
    referrer: string;
    userAgent: string;
    headers?: Record<string, string>;
    decoder?: string;
    resolver?: string;
}

/** Who is in a live event and when, so the host can merge it with the same fixture from other sources. */
interface ScrapedEvent {
    sides?: string[];
    /** What the host merges on -- see `eventFor`. */
    key?: string;
    /** Further keys the same event goes by. */
    keys?: string[];
    title?: string;
    competition?: string;
    sport?: string;
    /** Epoch milliseconds; omitted when unknown. */
    start?: number;
}

// BEGIN event-key -- identical in every scraper that lists live events. scripts/sync-event-key.mjs keeps the copies in step.

/** Flags (regional indicators), tag characters, variation selectors, joiners. */
const EVENT_DECORATION = /[\u{1F1E6}-\u{1F1FF}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{1F3F4}]/gu;

/** Words some lists put on a club's name and others leave off. */
const EVENT_GENERIC = new Set(["fc", "cf", "afc", "sc", "fk", "sk", "cd", "ud", "club", "the", "de", "calcio"]);

/** Whole-name spellings that are one team. Keys are already folded. */
const EVENT_ALIASES: Record<string, string> = {
    "czech republic": "czechia",
    czech: "czechia",
    "united states": "usa",
    "united states of america": "usa",
    us: "usa",
    "korea republic": "south korea",
    "republic of korea": "south korea",
    "cote d ivoire": "ivory coast",
    turkiye: "turkey",
    holland: "netherlands",
    "bosnia and herzegovina": "bosnia",
    "bosnia herzegovina": "bosnia",
    uae: "united arab emirates",
    macedonia: "north macedonia",
    "republic of ireland": "ireland",
    "man utd": "manchester united",
    "man united": "manchester united",
    "man city": "manchester city",
    spurs: "tottenham",
    "tottenham hotspur": "tottenham",
    "wolverhampton wanderers": "wolves",
    "paris saint germain": "psg",
    "paris sg": "psg",
    "inter milan": "inter",
    internazionale: "inter",
    "bayern munich": "bayern",
    "bayern munchen": "bayern",
    "dr congo": "congo dr",
    "china pr": "china",
    "ir iran": "iran",
    "russian federation": "russia",
    "cabo verde": "cape verde",
    swaziland: "eswatini"
};

/** A team's identity: folded, with the noise words and spellings that differ between sources taken out. */
function teamKey(name: string): string {
    const folded = name
        .replace(EVENT_DECORATION, " ")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\bwomen'?s?\b|[[(]\s*w\s*[\])]|\bfem(?:inino|enino|inine)?\b/g, " women ")
        .replace(/\bunder[\s-]?(\d{2})\b/g, " u$1 ")
        .replace(/\bno\.?\s*\d{1,2}\b(?=\s+[a-z])/g, " ")
        .replace(/\bst\b\.?/g, "saint")
        .replace(/['`’]/g, "")
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
    const alias = EVENT_ALIASES[folded] || folded;
    const tokens = alias.split(" ").filter((token) => token && !EVENT_GENERIC.has(token));

    return (tokens.length ? tokens : alias.split(" ").filter(Boolean)).join(" ");
}

/**
 * "UEFA Nations League : Scotland vs North Macedonia", "UFC 332: Silva vs
 * Wang", "Croatia vs England - UEFA Nations League" -> the sides and the
 * competition, or null when the text is not a fixture.
 */
function readFixture(raw: string): { sides: string[]; competition: string } | null {
    const versus = /\s+(?:vs\.?|v\.?|versus|@)\s+/i;
    let name = raw.replace(EVENT_DECORATION, "").replace(/\s+/g, " ").trim();
    const first = name.search(versus);
    if (first < 0) return null;

    let competition = "";
    const head = name.slice(0, first);
    const cut = Math.max(head.lastIndexOf(" : "), head.lastIndexOf(": "), head.lastIndexOf(" | "));
    if (cut > 0) {
        competition = head.slice(0, cut).trim();
        name = name.slice(cut).replace(/^\s*[:|]\s*/, "").trim();
    }

    const tail = /^(.*?)(?:\s+[-–|]\s+|\s+\()([^)]{3,60})\)?$/.exec(name);
    if (tail && versus.test(tail[1] || "")) {
        competition = competition || (tail[2] || "").trim();
        name = (tail[1] || "").trim();
    }

    const sides = name.split(versus).map((side) => side.trim()).filter(Boolean);
    if (sides.length < 2 || sides.length > 8) return null;
    if (sides.some((side) => side.length < 2 || side.length > 60 || /^(?:simulcast|tba|tbd|tbc|live|hd|fhd|uhd|sd|4k|tv|\d+)$/i.test(side))) return null;

    return { sides, competition };
}

/** A name that is one of these words is a different team when it is the extra one -- never trimmed away. */
const EVENT_MARKER = /^(?:u\d\d|women|ii|iii|b|reserves?|youth|jr|junior|academy|castilla|amateur)$/;

/** Too common on their own to stand for a team ("State", "New"). */
const EVENT_COMMON = new Set(["city", "united", "town", "county", "athletic", "sporting", "real", "club", "national", "state", "college", "university", "new", "north", "south", "east", "west", "saint", "los", "san", "las", "fort", "sint"]);

/**
 * The other names one team goes by: its identity with trailing words dropped
 * ("Ohio State Buckeyes" is also "Ohio State", "UNLV Rebels" is also "UNLV"),
 * longest first, starting with the full identity. A team carrying a women's,
 * youth or reserve word has none -- dropping it would turn one team into another.
 */
function teamNames(name: string): string[] {
    const full = teamKey(name);
    const tokens = full.split(" ").filter(Boolean);

    if (tokens.some((token) => EVENT_MARKER.test(token))) return [full];

    const names = [full];
    let head = tokens;

    /* Drop trailing words one at a time, but never a word like "United" or "State": that is part of the name. */
    while (head.length > 1 && !EVENT_COMMON.has(head[head.length - 1] || "")) {
        head = head.slice(0, -1);

        if (head.length === 1 && ((head[0] || "").length < 4 || EVENT_COMMON.has(head[0] || ""))) break;
        names.push(head.join(" "));
    }

    return names;
}

/** Every combination of the sides' names, as sorted keys: the exact one first, at most 16. */
function eventKeys(sides: string[]): string[] {
    let keys: string[][] = [[]];

    for (const side of sides) {
        const names = teamNames(side);

        keys = keys.flatMap((held) => names.map((name) => [...held, name]));
        if (keys.length > 64) keys = keys.slice(0, 64);
    }

    return [...new Set(keys.map((parts) => `v:${[...parts].sort().join("|")}`))].slice(0, 16);
}

/**
 * The card's `event` and display name. `key` is what the host merges on: the
 * sides' identities, sorted (so order does not matter), or for an event with
 * no opponents its folded title without the year. Two sources that compute
 * the same key for an event are the same event -- the host compares nothing else
 * but the start time. `keys` are further keys the same event goes by (a
 * name with its trailing words dropped), for a source that spells a team
 * shorter: two cards are one event when ANY of their keys is shared.
 */
function eventFor(
    title: string,
    extra: { sides?: string[]; sport?: string; competition?: string; start?: number } = {}
): { name: string; event: ScrapedEvent } {
    const fixture = extra.sides && extra.sides.length >= 2 ? { sides: extra.sides, competition: "" } : readFixture(title);
    const competition = fixture?.competition || extra.competition || "";
    const titleKey = title
        .replace(EVENT_DECORATION, " ")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\b20\d\d(?:\/\d\d)?\b/g, " ")
        .replace(/\b(?:live|stream|hd|fhd|full\s+event)\b/g, " ")
        .replace(/[^a-z0-9]+/g, "");
    const keys = fixture ? eventKeys(fixture.sides) : [];
    const key = fixture ? `v:${fixture.sides.map(teamKey).sort().join("|")}` : titleKey.length >= 6 ? `t:${titleKey}` : "";

    return {
        name: fixture ? fixture.sides.join(" vs ") : title,
        event: {
            ...(fixture ? { sides: fixture.sides } : { title }),
            ...(key ? { key } : {}),
            ...(keys.length > 1 ? { keys: keys.filter((other) => other !== key) } : {}),
            ...(competition ? { competition } : {}),
            ...(extra.sport ? { sport: extra.sport } : {}),
            ...(extra.start && extra.start > 0 ? { start: extra.start } : {})
        }
    };
}

// END event-key

interface ScrapedChannel {
    id: string;
    name: string;
    country: string;
    countryName: string;
    countryFlag: string;
    categories: string[];
    languages: string[];
    logo: string;
    logos?: string[];
    event?: ScrapedEvent;
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
    intervalConfigKey: string;
    run(context: ScraperTaskContext): Promise<void>;
}

interface ResolvedStream {
    url: string;
    referrer?: string;
    userAgent?: string;
    headers?: Record<string, string>;
}

type StreamResolver = (handle: string) => Promise<ResolvedStream | null>;
type SegmentDecoder = (segment: Uint8Array, url: string) => Uint8Array | Promise<Uint8Array>;

interface Scraper {
    id: string;
    name: string;
    version?: string;
    configSchema?: ScraperConfigField[];
    buildEvents?(): Promise<ScrapedCatalogue>;
    decoders?: Record<string, SegmentDecoder>;
    resolvers?: Record<string, StreamResolver>;
    build(): Promise<ScrapedCatalogue>;
}

// -------------------------------------------------------------------------
// The scraper
// -------------------------------------------------------------------------

const SCRAPER_ID = "streamed";
const DECODER = "webpexif";
const RESOLVER = "streamed";

/** `live:<scraper id>:<whatever>` -- the id space every non-built-in scraper must use. */
function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

/** Mirrors of the API, tried in turn (some are DNS-blocked in some countries). */
const API_BASES = ["https://streamed.pk", "https://streamed.st", "https://streamed.su"];
const EMBED = "https://embed.st";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HANDLE_HOST = "streamed.invalid";

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 15_000): Promise<T> {
    const controller = new AbortController();
    // Not cleared on success: the body read that follows is still tied to this signal.
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();

    try {
        return await work(controller.signal);
    } catch (cause) {
        clearTimeout(timer);
        throw cause;
    }
}

let apiBase = API_BASES[0] as string;

async function api<T>(path: string): Promise<T> {
    const order = [apiBase, ...API_BASES.filter((base) => base !== apiBase)];
    let last: unknown;

    for (const base of order) {
        try {
            const response = await withTimeout((signal) => fetch(`${base}${path}`, { signal, headers: { "user-agent": BROWSER_UA, accept: "application/json" } }));
            if (!response.ok) throw new Error(`${base}${path} -> ${response.status}`);
            const body = (await response.json()) as T;
            apiBase = base;
            return body;
        } catch (cause) {
            last = cause;
        }
    }

    throw last instanceof Error ? last : new Error(String(last));
}

// ---- the embed's handshake ----------------------------------------------

/** The 64 symbols, in value order, of the text the embed answers with. Pad is `T`. */
const ALPHABET = "XYZ[\\]^_`abcdefghijklmnopqxyz{|}~!\"#$%&'()*+,-./0123GHIJKLMNOPBF";
const SYMBOL = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));

function unalphabet(text: string): Buffer {
    const out: number[] = [];
    let acc = 0;
    let bits = 0;

    for (const char of text) {
        if (char === "T") break;
        const value = SYMBOL.get(char);
        if (value === undefined) throw new Error(`symbol ${JSON.stringify(char)} outside the alphabet`);
        acc = (acc << 6) | value;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
            acc &= (1 << bits) - 1;
        }
    }

    return Buffer.from(out);
}

function varint(value: number): number[] {
    const out: number[] = [];
    let rest = value;

    while (rest >= 0x80) {
        out.push((rest & 0x7f) | 0x80);
        rest >>>= 7;
    }

    out.push(rest);
    return out;
}

/** protobuf: field 1 = source, 2 = id, 3 = stream number, all strings. */
function requestBody(source: string, id: string, streamNo: string): Buffer {
    const parts: number[] = [];

    [source, id, streamNo].forEach((value, index) => {
        const bytes = Buffer.from(value, "utf8");
        parts.push(((index + 1) << 3) | 2, ...varint(bytes.length), ...bytes);
    });

    return Buffer.from(parts);
}

/** `{1: bytes}` -> the bytes, or null. */
function field1(body: Buffer): Buffer | null {
    if (body[0] !== 0x0a) return null;
    let at = 1;
    let length = 0;
    let shift = 0;

    for (;;) {
        const byte = body[at++];
        if (byte === undefined) return null;
        length |= (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80)) break;
    }

    return body.subarray(at, at + length);
}

/** The `/fetch` answer -> the playlist URL, or null. */
export function decodeAnswer(body: Buffer, goat: string): string | null {
    const text = field1(body);
    if (!text || goat.length !== 32) return null;

    const raw = unalphabet(text.toString("latin1"));
    if (raw.length < 12 + 16 + 8) return null;

    const nonce = raw.subarray(0, 12);
    const sealed = raw.subarray(12, raw.length - 16); // the last 16 bytes are a Poly1305 tag, not checked
    const iv = Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]); // RFC 8439: block counter starts at 1
    const cipher = createDecipheriv("chacha20", Buffer.from(goat, "latin1"), iv);
    const plain = Buffer.concat([cipher.update(sealed), cipher.final()]).toString("latin1");

    return /^https:\/\/[a-z0-9.-]+\/secure\/[A-Za-z0-9/_.=~-]+\.m3u8$/.test(plain) ? plain : null;
}

/**
 * The key's header is not always called `goat`: embedindia.st (PPV.ST) sends
 * it as `island`, and the name is the embed's own. What never changes is its
 * shape, 32 letters/digits, so every header of that shape is tried.
 */
export function decodeResponse(body: Buffer, headers: Headers): string | null {
    for (const [, value] of headers) {
        if (!/^[A-Za-z0-9]{32}$/.test(value)) continue;

        const playlist = decodeAnswer(body, value);
        if (playlist) return playlist;
    }

    return null;
}

/**
 * `/fetch` answers 429 beyond roughly 40 calls in a burst or ~10 a second
 * sustained (measured: 60 sequential calls 0.7 s apart, no 429), and a sweep
 * of every stream's health asks for all of them at once. A token bucket
 * (15 burst, 4 a second) keeps a viewer's press of Play from queueing behind
 * more than a moment of that, and a 429 is waited out once.
 */
const BUCKET = 15;
const REFILL_PER_SECOND = 4;
let tokens = BUCKET;
let refilledAt = Date.now();
let turn: Promise<void> = Promise.resolve();

function takeToken(): Promise<void> {
    const mine = turn.then(async () => {
        for (;;) {
            const now = Date.now();
            tokens = Math.min(BUCKET, tokens + ((now - refilledAt) / 1000) * REFILL_PER_SECOND);
            refilledAt = now;

            if (tokens >= 1) {
                tokens -= 1;
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, Math.ceil(((1 - tokens) / REFILL_PER_SECOND) * 1000)));
        }
    });

    turn = mine;
    return mine;
}

async function postFetch(source: string, id: string, streamNo: string): Promise<Response> {
    const once = async (): Promise<Response> => {
        await takeToken();

        return withTimeout((signal) =>
            fetch(`${EMBED}/fetch`, {
                method: "POST",
                signal,
                headers: {
                    "content-type": "application/octet-stream",
                    "user-agent": BROWSER_UA,
                    origin: EMBED,
                    referer: `${EMBED}/embed/${encodeURIComponent(source)}/${encodeURIComponent(id)}/${encodeURIComponent(streamNo)}`
                },
                body: new Uint8Array(requestBody(source, id, streamNo))
            })
        );
    };

    const first = await once();
    if (first.status !== 429) return first;

    await first.arrayBuffer().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return once();
}

async function resolveStream(handle: string): Promise<ResolvedStream | null> {
    let url: URL;

    try {
        url = new URL(handle);
    } catch {
        return null;
    }

    if (url.host !== HANDLE_HOST) return null;

    const [source, id, streamNo] = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (!source || !id || !streamNo) return null;

    const response = await postFetch(source, id, streamNo);
    if (!response.ok) return null;

    const playlist = decodeResponse(Buffer.from(await response.arrayBuffer()), response.headers);
    if (!playlist) return null;
    if (!(await onAir(playlist, `${EMBED}/`))) return null;

    return { url: playlist, referrer: `${EMBED}/`, userAgent: "" };
}

// ---- is the feed really on air? -----------------------------------------

/**
 * A listed stream is not always a live one. `delta` in particular will hand
 * out a perfectly good master/media playlist for a game that is over or a
 * relay that stalled, whose segments are `/m/<opaque>` links that redirect to
 * the broadcaster's own CDN (`*.lura.live`, `fsy.nfl.com`) and 404 there --
 * the playlist looks alive, every segment is gone (measured 2026-10-04: the
 * latest segment of 7 of 10 NFL feeds 404'd while their playlists answered
 * 200). The host only checks as far as the playlist, so the resolver looks at
 * the newest segment itself and answers `null` for a feed whose segments are
 * gone, instead of offering it.
 *
 * Done over TLS 1.2 because the CDN 403s Node's default handshake (see the
 * header). Dead is a 404/410, or a 403 from the broadcaster's CDN (not the lb
 * node's, whose 403s are rate limits, nor a timeout): the segments redirect to
 * an Akamai edge that answers "Access Denied" to some callers' addresses, and
 * the resolver runs on the very address that would play it.
 */
interface Probed {
    status: number;
    text: string;
    /** The host that finally answered, after redirects. */
    host: string;
}

function probe(url: string, referrer: string, wantBody: boolean, hops = 0): Promise<Probed> {
    return new Promise((resolve, reject) => {
        const attempt = request(
            url,
            { method: "GET", headers: { "user-agent": BROWSER_UA, referer: referrer }, maxVersion: "TLSv1.2", timeout: 6_000 },
            (incoming) => {
                const status = incoming.statusCode || 0;
                const location = incoming.headers.location;

                if (status >= 300 && status < 400 && location && hops < 3) {
                    incoming.resume();
                    probe(new URL(location, url).href, referrer, wantBody, hops + 1).then(resolve, reject);
                    return;
                }

                if (!wantBody) {
                    incoming.destroy();
                    resolve({ status, text: "", host: new URL(url).host });
                    return;
                }

                const chunks: Buffer[] = [];
                let size = 0;
                incoming.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size <= 512 * 1024) chunks.push(chunk);
                });
                incoming.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8"), host: new URL(url).host }));
                incoming.on("error", reject);
            }
        );

        attempt.on("timeout", () => attempt.destroy(new Error("probe timed out")));
        attempt.on("error", reject);
        attempt.end();
    });
}

function uris(playlist: string): string[] {
    return playlist
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
}

/** False only when the playlist or its newest segment is positively gone. */
export async function onAir(playlist: string, referrer: string): Promise<boolean> {
    try {
        let base = playlist;
        let page = await probe(base, referrer, true);
        if (page.status === 404 || page.status === 410) return false;
        if (page.status !== 200) return true;

        if (page.text.includes("#EXT-X-STREAM-INF")) {
            const first = uris(page.text)[0];
            if (!first) return true;

            base = new URL(first, base).href;
            page = await probe(base, referrer, true);
            if (page.status === 404 || page.status === 410) return false;
            if (page.status !== 200) return true;
        }

        const newest = uris(page.text).pop();
        if (!newest) return true;

        const segment = await probe(new URL(newest, base).href, referrer, false);
        if (segment.status === 404 || segment.status === 410) return false;

        // Refused by a DIFFERENT host than the playlist's: the broadcaster's CDN
        // (Akamai's "Access Denied" for NFL feeds, by the caller's address)
        // is turning this machine away -- the lb node's own 403s are rate limits.
        return !(segment.status === 403 && segment.host !== new URL(base).host);
    } catch {
        return true;
    }
}

// ---- the segment disguise -----------------------------------------------

/** 0x47 every 188 bytes from `at`, three times over. */
function syncedAt(view: Buffer, at: number): boolean {
    return view[at] === 0x47 && view[at + 188] === 0x47 && view[at + 376] === 0x47;
}

/**
 * What a segment is, by source (all measured 2026-10-03):
 *   - `delta`: plain MPEG-TS, no disguise (`video/mp2t`).
 *   - `admin`: a WebP whose `EXIF` chunk holds the TS (sync byte at offset 42).
 *   - `hotel`: a WebP whose RIFF `size` field lies and whose one `VP8L` chunk
 *     is followed directly by the TS (sync byte at offset 36), no EXIF header.
 * So: TS already -> as is; otherwise walk the RIFF chunks and take the TS the
 * moment it starts, either at a sync byte or inside an `EXIF` chunk.
 */
export function unwrapSegment(segment: Uint8Array): Uint8Array {
    const view = Buffer.from(segment.buffer, segment.byteOffset, segment.length);

    if (syncedAt(view, 0)) return segment;

    if (view.length < 20 || view.toString("latin1", 0, 4) !== "RIFF" || view.toString("latin1", 8, 12) !== "WEBP") {
        throw new Error("neither MPEG-TS nor a WebP");
    }

    let at = 12;

    while (at + 8 <= view.length) {
        if (syncedAt(view, at)) return view.subarray(at);

        const type = view.toString("latin1", at, at + 4);
        const size = view.readUInt32LE(at + 4);

        if (type === "EXIF") {
            const body = view.subarray(at + 8, Math.min(view.length, at + 8 + size));
            if (body[0] !== 0x47) throw new Error("EXIF chunk is not MPEG-TS");
            return body;
        }

        at += 8 + size + (size & 1);
    }

    throw new Error("no MPEG-TS inside the WebP");
}

// ---- the catalogue -------------------------------------------------------

interface ApiMatch {
    id: string;
    title: string;
    category: string;
    date?: number;
    popular?: boolean;
    poster?: string;
    teams?: { home?: { name?: string; badge?: string }; away?: { name?: string; badge?: string } };
    sources?: Array<{ source: string; id: string }>;
}

interface ApiStream {
    id: string;
    streamNo: number;
    language?: string;
    hd?: boolean;
    embedUrl?: string;
    source: string;
    viewers?: number;
}

const CATEGORY_LABELS: Record<string, string> = {
    football: "Football",
    basketball: "Basketball",
    "american-football": "American Football",
    hockey: "Hockey",
    baseball: "Baseball",
    tennis: "Tennis",
    motor_sports: "Motorsport",
    "motor-sports": "Motorsport",
    fight: "Fighting",
    rugby: "Rugby",
    cricket: "Cricket",
    golf: "Golf",
    darts: "Darts",
    billiards: "Billiards",
    afl: "AFL",
    other: "Other sports"
};

function labelOf(category: string): string {
    return CATEGORY_LABELS[category] || category.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function badge(id: string | undefined): string {
    return id ? `${apiBase}/api/images/badge/${id}.webp` : "";
}

/** Run `work` over `items`, `size` at a time. */
async function pooled<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;

    await Promise.all(
        Array.from({ length: Math.min(size, items.length) }, async () => {
            while (next < items.length) {
                const index = next++;
                out[index] = await work(items[index] as T);
            }
        })
    );

    return out;
}

async function fetchEvents(): Promise<ScrapedCatalogue> {
    const matches = await api<ApiMatch[]>("/api/matches/live");

    const lists = await pooled(matches, 8, async (match) => {
        const found: ApiStream[] = [];

        for (const source of match.sources || []) {
            try {
                found.push(...(await api<ApiStream[]>(`/api/stream/${encodeURIComponent(source.source)}/${encodeURIComponent(source.id)}`)));
            } catch {
                /* that source is skipped, the match keeps the others */
            }
        }

        return found;
    });

    const channels: ScrapedChannel[] = [];
    const byCategory = new Map<string, string[]>();

    matches.forEach((match, index) => {
        const streams: ScrapedStream[] = (lists[index] || [])
            .sort((a, b) => Number(b.hd) - Number(a.hd) || (b.viewers || 0) - (a.viewers || 0))
            .map((stream) => ({
                url: `https://${HANDLE_HOST}/${encodeURIComponent(stream.source)}/${encodeURIComponent(stream.id)}/${stream.streamNo}`,
                quality: `${stream.hd ? "HD" : "SD"}${stream.language ? ` · ${stream.language}` : ""}`,
                labels: [],
                referrer: `${EMBED}/`,
                userAgent: "",
                resolver: RESOLVER,
                decoder: DECODER
            }));

        if (!streams.length) return;

        const home = badge(match.teams?.home?.badge);
        const away = badge(match.teams?.away?.badge);
        const poster = match.poster ? `${apiBase}${match.poster}` : "";
        const category = match.category || "other";
        const id = idFor(match.id);
        const homeName = match.teams?.home?.name?.trim() || "";
        const awayName = match.teams?.away?.name?.trim() || "";
        const sides = homeName && awayName ? [homeName, awayName] : [];
        const described = eventFor(match.title.trim(), { ...(sides.length ? { sides } : {}), sport: category, start: match.date });

        channels.push({
            id,
            name: described.name,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", category],
            languages: [],
            logo: home || poster,
            ...(home && away ? { logos: [home, away] } : {}),
            event: described.event,
            website: `${apiBase}/watch/${match.id}`,
            network: "",
            streams
        });

        byCategory.set(category, [...(byCategory.get(category) || []), id]);
    });

    if (!matches.length) throw new Error("streamed: the live list is empty");

    const rails: ScrapedRail[] = channels.length
        ? [
              { id: "live-events", heading: "Live Events", channelIds: channels.map((channel) => channel.id), group: "Live events" },
              ...[...byCategory.entries()]
                  .filter(([, ids]) => ids.length)
                  .map(([category, ids]) => ({ id: `live-${category.replace(/[^a-z0-9-]/g, "-").slice(0, 30)}`, heading: `Live ${labelOf(category)}`, channelIds: ids, group: "Live events" }))
          ]
        : [];

    return { channels, rails };
}

const configSchema: ScraperConfigField[] = [
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 20,
        min: 5,
        help: "How often the list of live events is re-read. Each event's streams are resolved when someone plays them, not here."
    }
];

/** Single-flight cache, same reasoning as futbolx.mts's. */
/*
    EVENTS ONLY: this source has no channel list, so `build()` is empty and
    `buildEvents()` is the whole scraper -- the host runs it on
    `eventsIntervalMinutes`.
*/
async function build(): Promise<ScrapedCatalogue> {
    return { channels: [] };
}

function buildEvents(): Promise<ScrapedCatalogue> {
    return fetchEvents();
}

export const streamedScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Streamed",
    version: "1.3.0",
    configSchema,
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    resolvers: { [RESOLVER]: resolveStream },
    build,
    buildEvents
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/streamed.mts` -- prints a channel count, the first
// channel found, and resolves its first stream.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    buildEvents()
        .then(async (catalogue) => {
            console.log(`${catalogue.channels.length} channels, rails: ${(catalogue.rails || []).map((rail) => `${rail.heading}(${rail.channelIds.length})`).join(", ")}`);
            const first = catalogue.channels[0];
            console.log(first || "(none)");
            if (first?.streams[0]) console.log(await resolveStream(first.streams[0].url));
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
