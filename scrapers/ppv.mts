/**
 * PPV.ST (and its fronts: SportOnTV, 90minutes, DamiTV's PPV half, SportsBite's
 * PPV half) -- live US sport (NFL/NCAA, MLB, NHL, NBA, boxing/UFC, F1...) plus
 * a handful of 24/7 sports channels (NFL Network, Fox Footy...). The same
 * player and the same stream backend as `streamed.mts`; retried on 2026-10-03
 * with what that scraper found, and it works.
 *
 * THE CHAIN (verified 2026-10-03)
 * -------------------------------
 *   1. `GET https://api.ppv.st/api/streams` -> `{ streams: [{ category,
 *      streams: [{ id, name, tag, source_tag, poster, uri_name, starts_at,
 *      ends_at, always_live, iframe, substreams: [{ name, uri_name, source_tag
 *      }] }] }] }`. Plain JSON, no key. `starts_at`/`ends_at` are epoch
 *      SECONDS (0/negative for a 24/7 channel); upcoming events are listed
 *      too, so only those within their window are offered. `uri_name` is a
 *      path (`nfl-network`, `mlb/2026-10-03/atl-lad`, `cfb/.../skycast`) and
 *      `iframe` is `https://embedindia.st/embed/<uri_name>`.
 *   2. The embed is the Streamed player (`/js/bundle-jw.js` + a wasm-bindgen
 *      module, here `/js/wasm/gasm.wasm`), and its handshake is the one in
 *      `streamed.mts`, with two differences found by watching the page:
 *        POST https://embedindia.st/fetch
 *          Referer: https://embedindia.st/embed/<uri_name>
 *          body (protobuf): 1:<uri_name>             (ONE string, not three)
 *      and the key's response header is `island`, not `goat` (still 32
 *      letters; every header of that shape is tried). The answer's text
 *      alphabet, ChaCha20 (counter 1, nonce = first 12 bytes) and layout are
 *      identical -- the SAME decoder, not a lookalike -- and the plaintext is
 *      `https://<edge>.indianservers.st/secure/<32 letters>/0/<expiry>/<tag>/
 *      index.m3u8`. Run none of the site's code.
 *   3. The playlist needs `Referer: https://embedindia.st/` (403 without). It
 *      is a master with one 1080p variant whose media playlist lists
 *      `https://p16-common-sign.tiktokcdn-eu.com/...~tplv-tiktokx-origin.image`
 *      segments: WebP images with the MPEG-TS in an `EXIF` chunk (~5 MB per
 *      5 s). Same disguise as Streamed's `admin` source, same decoder.
 *   4. Like Streamed's CDN, the edge may 403 Node's TLS 1.3 handshake; live-tv
 *      >= 1.10.0 retries such a 403 at TLS 1.2.
 *
 * The token is minted per request and expires, so each stream's `url` is a
 * HANDLE (`https://ppv.invalid/<uri_name, URL-encoded>`) resolved at play time
 * by `resolvers.ppv`. Needs live-tv >= 1.10.0.
 *
 * What returns nothing: `/fetch` answering anything but 200 or text that does
 * not decode to an `https://.../secure/...m3u8` (a changed key header, alphabet
 * or cipher), a listed event that is not on air yet -- all `null`, never a throw.
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
    swaziland: "eswatini",
    denamrk: "denmark"
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

const SCRAPER_ID = "ppv";
const DECODER = "webpexif";
const RESOLVER = "ppv";
const API = "https://api.ppv.st/api/streams";
const EMBED = "https://embedindia.st";
const HANDLE_HOST = "ppv.invalid";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** `live:<scraper id>:<whatever>` -- the id space every non-built-in scraper must use. */
function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

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

// ---- the embed's handshake (see streamed.mts, which this repeats) ---------

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

/** protobuf: field 1 = the embed's path, a string. */
function requestBody(path: string): Buffer {
    const bytes = Buffer.from(path, "utf8");
    return Buffer.from([0x0a, ...varint(bytes.length), ...bytes]);
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
export function decodeAnswer(body: Buffer, key: string): string | null {
    const text = field1(body);
    if (!text || key.length !== 32) return null;

    const raw = unalphabet(text.toString("latin1"));
    if (raw.length < 12 + 16 + 8) return null;

    const nonce = raw.subarray(0, 12);
    const sealed = raw.subarray(12, raw.length - 16); // the last 16 bytes are a Poly1305 tag, not checked
    const iv = Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]); // RFC 8439: block counter starts at 1
    const cipher = createDecipheriv("chacha20", Buffer.from(key, "latin1"), iv);
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

async function postFetch(path: string): Promise<Response> {
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
                    referer: `${EMBED}/embed/${path.split("/").map(encodeURIComponent).join("/")}`
                },
                body: new Uint8Array(requestBody(path))
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

    const path = decodeURIComponent(url.pathname.slice(1));
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(path)) return null;

    const response = await postFetch(path);
    if (!response.ok) return null;

    const playlist = decodeResponse(Buffer.from(await response.arrayBuffer()), response.headers);
    if (!playlist) return null;
    if (!(await onAir(playlist, `${EMBED}/`))) return null;

    return { url: playlist, referrer: `${EMBED}/`, userAgent: "" };
}

// ---- is the feed really on air? -----------------------------------------

/**
 * A listed stream is not always a live one (copied from streamed.mts, which has the measurements). `delta` will hand
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

interface ApiStream {
    id: number;
    name: string;
    tag?: string;
    source_tag?: string;
    poster?: string;
    uri_name: string;
    starts_at?: number;
    ends_at?: number;
    always_live?: number;
    category_name?: string;
    substreams?: Array<{ name?: string; tag?: string; uri_name: string; source_tag?: string }>;
    viewers?: string;
}

interface ApiCategory {
    category: string;
    streams: ApiStream[];
}

/** An event is offered from this long before it starts until it ends. */
const LEAD_MS = 15 * 60 * 1000;

/** "A at B", "A vs. B", "A v B" -> the two sides (order does not matter to the host), or none. */
function sidesOf(name: string): string[] {
    const parts = name.split(/\s+(?:at|vs\.?|v)\s+/i).map((part) => part.trim());
    return parts.length === 2 && parts.every((part) => part.length >= 2 && part.length <= 60) ? parts : [];
}

function handleFor(path: string): string {
    return `https://${HANDLE_HOST}/${encodeURIComponent(path)}`;
}

function streamFor(path: string, label: string): ScrapedStream {
    return {
        url: handleFor(path),
        quality: label,
        labels: [],
        referrer: `${EMBED}/`,
        userAgent: "",
        resolver: RESOLVER,
        decoder: DECODER
    };
}

function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "other";
}

async function fetchCatalogue(want: "events" | "channels"): Promise<ScrapedCatalogue> {
    const body = await withTimeout(async (signal) => {
        const response = await fetch(API, { signal, headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
        if (!response.ok) throw new Error(`${API} -> ${response.status}`);
        return (await response.json()) as { streams?: ApiCategory[] };
    });

    if (!Array.isArray(body.streams)) throw new Error("ppv: the stream list is not in the expected shape");

    const now = Date.now();
    const channels: ScrapedChannel[] = [];
    const events: string[] = [];
    const always: string[] = [];
    const byCategory = new Map<string, { label: string; ids: string[] }>();

    for (const group of body.streams) {
        for (const item of group.streams || []) {
            if (!item.uri_name || !item.name) continue;

            const category = item.category_name || group.category || "Sports";
            const isAlways = Boolean(item.always_live);
            if (isAlways !== (want === "channels")) continue;
            const start = (item.starts_at || 0) * 1000;
            const end = (item.ends_at || 0) * 1000;
            if (!isAlways && !(start - LEAD_MS <= now && now <= end)) continue;

            const feeds = [streamFor(item.uri_name, item.source_tag || item.tag || "HD")];
            for (const sub of item.substreams || []) {
                if (sub.uri_name) feeds.push(streamFor(sub.uri_name, sub.source_tag || sub.name || "Alt"));
            }

            const id = idFor(String(item.id));
            const sides = isAlways ? [] : sidesOf(item.name);
            const described = isAlways
                ? null
                : eventFor(item.name.trim(), { ...(sides.length ? { sides } : {}), competition: item.tag || "", sport: category.toLowerCase(), start });

            channels.push({
                id,
                name: described ? described.name : item.name.trim(),
                country: "",
                countryName: "",
                countryFlag: "",
                categories: ["sports", slug(category)],
                languages: [],
                logo: item.poster || "",
                ...(described ? { event: described.event } : {}),
                website: `https://ppv.st/live/${item.uri_name}`,
                network: "",
                streams: feeds
            });

            if (isAlways) {
                always.push(id);
            } else {
                events.push(id);
                const held = byCategory.get(slug(category)) || { label: category, ids: [] };
                held.ids.push(id);
                byCategory.set(slug(category), held);
            }
        }
    }


    const rails: ScrapedRail[] = [
        ...(events.length ? [{ id: "live-events", heading: "Live Events", channelIds: events, group: "Live events" }] : []),
        ...[...byCategory.entries()].map(([key, held]) => ({ id: `live-${key}`, heading: `Live ${held.label}`, channelIds: held.ids, group: "Live events" })),
        ...(always.length ? [{ id: "ppv-247", heading: "24/7 Sports", channelIds: always }] : [])
    ];

    return { channels, rails };
}

const configSchema: ScraperConfigField[] = [
    {
        key: "eventsIntervalMinutes",
        label: "Events refresh interval (minutes)",
        type: "number",
        default: 20,
        min: 5,
        help: "How often the list of live events is re-read. Each stream is resolved when someone plays it, not here."
    }
];

/*
    TWO JOBS, run and scheduled separately by the host: the 24/7 sports
    channels change rarely (`build()`), the live events by the minute
    (`buildEvents()`). Both read the same small JSON list.
*/
function build(): Promise<ScrapedCatalogue> {
    return fetchCatalogue("channels");
}

function buildEvents(): Promise<ScrapedCatalogue> {
    return fetchCatalogue("events");
}

export const ppvScraper: Scraper = {
    id: SCRAPER_ID,
    name: "PPV.ST",
    version: "1.2.1",
    configSchema,
    decoders: { [DECODER]: (segment) => unwrapSegment(segment) },
    resolvers: { [RESOLVER]: resolveStream },
    build,
    buildEvents
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/ppv.mts` -- prints a channel count, the first channel
// found, and resolves its first stream.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    Promise.all([build(), buildEvents()])
        .then(([base, live]) => ({ channels: [...live.channels, ...base.channels], rails: [...(live.rails || []), ...(base.rails || [])] }))
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
