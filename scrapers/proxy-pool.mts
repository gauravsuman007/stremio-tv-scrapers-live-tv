/**
 * Proxy pool -- not a channel source. It supplies the host with working HTTP
 * proxies per COUNTRY, ranked by measured quality, for streams that are
 * geoblocked (`ScrapedStream.country`: "this stream must be fetched from
 * there"). The host (live-tv) knows no proxy list and runs no tests; it asks
 * this scraper's `proxies` provider, `pick("DE")`, and gets proxy addresses
 * best first. `build()` is the refresh job: it returns an empty catalogue and
 * rebuilds the pool, so the pool is as fresh as this scraper's schedule.
 *
 * WHERE CANDIDATES COME FROM (public lists; every one is untrusted)
 *   Per country: proxifly (jsDelivr), the proxyscrape/free-proxy-list repo,
 *   maximilianfeix/free-proxy-list, the ProxyScrape v4 API, the GeoNode API.
 *   Whole-world lists that LABEL each proxy with a country: monosans
 *   `proxies.json`, Thordata awesome-free-proxy-list `http.json`, spys.me,
 *   and the free-proxy-list.net family's HTML tables (scraped).
 *   Whole-world lists WITHOUT a country (TheSpeedX, monosans, clarketm,
 *   jetkai, vakhov, MuRongPIG, ...): geolocated in bulk through ip-api's
 *   batch endpoint (capped per rebuild), then used like the labeled ones.
 *   Discovery: gfpcom/free-proxy-list's `sources/http.txt` is itself a list of
 *   raw list URLs; those are fetched too (public hosts only, size-capped).
 *   `extraLists` takes more raw-list URLs. Reddit was tried: unauthenticated
 *   reads answer 403 "Blocked" (JSON, search and RSS alike), so it is not a
 *   source; the GitHub lists are where Reddit's lists are collected anyway.
 * Protocols: plain HTTP proxies (`http://ip:port`) and SOCKS5/SOCKS4
 * (`socks5://ip:port`), per the `protocols` setting. The host (live-tv 1.15.0)
 * speaks SOCKS itself and gives ffmpeg a loopback HTTP bridge; an older host
 * drops the SOCKS addresses and uses the HTTP ones. Every entry is validated
 * as `ipv4:port` and tested; a label is only a hint.
 *
 * HOW A CANDIDATE IS TESTED (a list's claims are never believed)
 *   1. EXIT COUNTRY: ask a geo endpoint THROUGH the proxy where the request
 *      came from; a proxy that exits elsewhere is rejected (lists lie).
 *   2. LATENCY/JITTER: `probes` sequential small requests through it. Latency
 *      is the median; jitter is the mean absolute difference of consecutive
 *      samples. A proxy that fails more than 20% of probes is rejected.
 *   3. SPEED + HTTPS: one ~1 MB download over HTTPS (a CONNECT tunnel, which
 *      is how most streams travel). A proxy that cannot do it, or is slower
 *      than `minMbps`, is rejected.
 * SCORE (0-100) = 35% speed + 25% latency + 20% jitter + 20% reliability, each
 * mapped linearly onto a band (see `SCORE`). Only proxies scoring at least
 * `minScore` are kept, the best `keepPerCountry` per country.
 *
 * Feedback: the host calls `report(proxy, ok)` after real use. A failure costs
 * score at once and two in a row remove the proxy until the next refresh.
 *
 * What returns nothing: no candidate list reachable for a country, or none
 * passing the tests -- `pick` then answers `[]` and the host fails that
 * stream closed (it never falls back to a direct fetch for a geoblocked
 * stream). The pool is cached in a file (`cacheFile`) so a restart keeps it.
 */

import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { lookup } from "node:dns/promises";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// -------------------------------------------------------------------------
// Shapes, copied from `src/scraper-types.ts` -- see docs/scraper-template.ts.
// -------------------------------------------------------------------------

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

interface ScrapedCatalogue {
    channels: never[];
}

interface ScraperBuildContext {
    config: Record<string, ScraperConfigValue>;
}

/** What the host shows for one proxy (VPN settings > proxies). */
interface ProxyInfo {
    /** `http://ip:port`, or `socks5://ip:port` / `socks4://ip:port` */
    url: string;
    /** ISO 3166-1 alpha-2, upper case: where it was MEASURED to exit. */
    country: string;
    /** 0-100, higher is better. */
    score: number;
    /** Median round trip of a small request, milliseconds. */
    latencyMs: number;
    /** Mean absolute difference of consecutive latencies, milliseconds. */
    jitterMs: number;
    /** Measured download over HTTPS, megabits per second. */
    mbps: number;
    /** 0-1: share of probes that succeeded. */
    successRate: number;
    /** Carried an HTTPS (CONNECT) download. Always true for a kept proxy. */
    https: boolean;
    /** Epoch milliseconds of the last test. */
    testedAt: number;
    /** Which list it came from. */
    source: string;
    /** Real-use failures since the last success. */
    failures: number;
}

interface ProxyProvider {
    /** Proxy addresses for a country, best first. `[]` when none is known. */
    pick(country: string): Promise<string[]>;
    /** Tell the pool how a proxy did when actually used. */
    report(proxy: string, ok: boolean): void;
    /** The whole pool, for the settings page. */
    list(): Promise<ProxyInfo[]>;
}

interface Scraper {
    id: string;
    name: string;
    version?: string;
    configSchema?: ScraperConfigField[];
    proxies?: ProxyProvider;
    build(context?: ScraperBuildContext): Promise<ScrapedCatalogue>;
}

const SCRAPER_ID = "proxy-pool";

// -------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------

const CONFIG_SCHEMA: ScraperConfigField[] = [
    {
        key: "channelsIntervalMinutes",
        label: "Rebuild the pool every (minutes)",
        type: "number",
        default: 360,
        min: 30,
        max: 10080,
        help: "Free proxies die within hours; six hours keeps the pool usable."
    },
    {
        key: "countries",
        label: "Countries to keep proxies for",
        type: "string",
        default: "US,GB,DE,FR,ES,IT,NL,CA,AU,IN,BR,MX,JP,KR,SG,PT,PL,SE,TR,AR",
        help: "Comma-separated ISO codes. A country a stream asks for that is not listed is built on first use."
    },
    {
        key: "protocols",
        label: "Proxy protocols to keep",
        type: "string",
        default: "http,socks5,socks4",
        help: "Any of http, socks5, socks4. SOCKS needs live-tv 1.15.0 or later; older hosts ignore those entries."
    },
    { key: "keepPerCountry", label: "Proxies kept per country", type: "number", default: 8, min: 1, max: 50 },
    { key: "minScore", label: "Lowest score kept (0-100)", type: "number", default: 40, min: 0, max: 100 },
    { key: "minMbps", label: "Slowest download kept (Mbit/s)", type: "number", default: 3, min: 0.5, max: 100 },
    { key: "candidates", label: "Candidates tested per country", type: "number", default: 150, min: 5, max: 1000 },
    { key: "geolocate", label: "Unlabeled proxies geolocated per rebuild", type: "number", default: 1500, min: 0, max: 20000, help: "0 skips lists that carry no country." },
    { key: "extraLists", label: "Extra raw proxy-list URLs (comma-separated)", type: "string", default: "", help: "Plain text, one ip:port per line." },
    { key: "concurrency", label: "Proxies tested at once", type: "number", default: 30, min: 1, max: 200 },
    { key: "probes", label: "Latency probes per proxy", type: "number", default: 5, min: 3, max: 20 },
    { key: "budgetSeconds", label: "Longest a rebuild may run (seconds)", type: "number", default: 480, min: 30, max: 3600 },
    { key: "latencyUrl", label: "Latency test URL", type: "string", default: "http://cp.cloudflare.com/generate_204" },
    { key: "speedUrl", label: "Speed test URL (https)", type: "string", default: "https://speed.cloudflare.com/__down?bytes=1000000" },
    {
        key: "geoUrls",
        label: "Exit-country test URLs (comma-separated)",
        type: "string",
        default: "http://ip-api.com/json?fields=status,countryCode,query,https://api.country.is/"
    }
];

interface Settings {
    countries: string[];
    /** Schemes kept: `http`, `socks5`, `socks4`. */
    protocols: string[];
    keep: number;
    minScore: number;
    minMbps: number;
    candidates: number;
    geolocate: number;
    extraLists: string[];
    concurrency: number;
    probes: number;
    budgetMs: number;
    latencyUrl: string;
    speedUrl: string;
    geoUrls: string[];
    cacheFile: string;
    /** Entries older than this are rebuilt on demand by `pick`. */
    maxAgeMs: number;
    /** Where candidates come from; replaceable by tests. */
    sources: Sources;
}

/** A list with one URL per country. */
interface CountrySource {
    name: string;
    url(country: string): string;
    parse(body: string, country: string): Found[];
}

/** One list for the whole world; entries may or may not carry a country. */
interface WorldSource {
    name: string;
    url: string;
    parse(body: string): Found[];
}

interface Sources {
    perCountry: CountrySource[];
    world: WorldSource[];
    /** A list whose lines are URLs of more raw lists (discovery). `""` for none. */
    index: string;
    /** ip-api style batch endpoint for unlabeled proxies; `""` for none. */
    geoBatch: string;
    /** Spacing between batch calls (ip-api allows 15 a minute). */
    geoPauseMs: number;
    /** Tests only: allow discovered lists on loopback/private hosts. */
    indexAllowsPrivate?: boolean;
}

interface Found {
    url: string;
    /** Upper-case ISO code when the list says, else undefined. */
    country?: string;
}

interface Candidate {
    url: string;
    source: string;
}

const RAW = "https://raw.githubusercontent.com";

const SOURCES: Sources = {
    perCountry: [
        {
            name: "proxifly",
            url: (country) => `https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/${country}/data.txt`,
            parse: (body, country) => labelled(parseList(body), country)
        },
        {
            name: "proxyscrape-repo",
            url: (country) => `${RAW}/proxyscrape/free-proxy-list/main/proxies/countries/${country.toLowerCase()}/http/data.txt`,
            parse: (body, country) => labelled(parseList(body), country)
        },
        {
            name: "maximilianfeix",
            url: (country) => `${RAW}/maximilianfeix/free-proxy-list/main/countries/${country.toLowerCase()}.txt`,
            parse: (body, country) => labelled(parseList(body), country)
        },
        {
            name: "proxyscrape-repo-socks5",
            url: (country) => `${RAW}/proxyscrape/free-proxy-list/main/proxies/countries/${country.toLowerCase()}/socks5/data.txt`,
            parse: (body, country) => labelled(parseList(body, "socks5"), country)
        },
        {
            name: "proxyscrape-api-socks5",
            url: (country) =>
                `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${country.toLowerCase()}&protocol=socks5&proxy_format=ipport&format=text&timeout=6000`,
            parse: (body, country) => labelled(parseList(body, "socks5"), country)
        },
        {
            name: "proxyscrape-api",
            url: (country) =>
                `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${country.toLowerCase()}&protocol=http&proxy_format=ipport&format=text&timeout=6000`,
            parse: (body, country) => labelled(parseList(body), country)
        },
        {
            name: "geonode",
            url: (country) =>
                `https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country=${country}&protocols=http`,
            parse: (body, country) => parseGeonode(body, country)
        }
    ],
    world: [
        { name: "monosans-json", url: `${RAW}/monosans/proxy-list/main/proxies.json`, parse: parseMonosans },
        { name: "thordata", url: `${RAW}/Thordata/awesome-free-proxy-list/main/docs/data/http.json`, parse: parseThordata },
        { name: "spys.me", url: "https://spys.me/proxy.txt", parse: parseSpys },
        { name: "free-proxy-list.net", url: "https://free-proxy-list.net/", parse: parseTable },
        { name: "sslproxies.org", url: "https://www.sslproxies.org/", parse: parseTable },
        { name: "us-proxy.org", url: "https://www.us-proxy.org/", parse: parseTable },
        { name: "free-proxy-list.net/uk", url: "https://free-proxy-list.net/uk-proxy.html", parse: parseTable },
        ...[
            ["TheSpeedX", "TheSpeedX/PROXY-List/master/http.txt"],
            ["monosans", "monosans/proxy-list/main/proxies/http.txt"],
            ["clarketm", "clarketm/proxy-list/master/proxy-list-raw.txt"],
            ["ShiftyTR", "ShiftyTR/Proxy-List/master/http.txt"],
            ["roosterkid", "roosterkid/openproxylist/main/HTTPS_RAW.txt"],
            ["MuRongPIG", "MuRongPIG/Proxy-Master/main/http.txt"],
            ["vakhov", "vakhov/fresh-proxy-list/master/http.txt"],
            ["Zaeem20", "Zaeem20/FREE_PROXIES_LIST/master/http.txt"],
            ["proxy4parsing", "proxy4parsing/proxy-list/main/http.txt"],
            ["jetkai", "jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt"],
            ["zloi-user", "zloi-user/hideip.me/main/http.txt"]
        ].map(([name, path]) => ({ name: name as string, url: `${RAW}/${path}`, parse: (body: string) => plain(body) })),
        ...[
            ["TheSpeedX-socks5", "TheSpeedX/PROXY-List/master/socks5.txt", "socks5"],
            ["TheSpeedX-socks4", "TheSpeedX/PROXY-List/master/socks4.txt", "socks4"],
            ["monosans-socks5", "monosans/proxy-list/main/proxies/socks5.txt", "socks5"],
            ["monosans-socks4", "monosans/proxy-list/main/proxies/socks4.txt", "socks4"],
            ["hookzof", "hookzof/socks5_list/master/proxy.txt", "socks5"],
            ["jetkai-socks5", "jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt", "socks5"],
            ["MuRongPIG-socks5", "MuRongPIG/Proxy-Master/main/socks5.txt", "socks5"]
        ].map(([name, path, scheme]) => ({ name: name as string, url: `${RAW}/${path}`, parse: (body: string) => plain(body, scheme as Scheme) }))
    ],
    index: `${RAW}/gfpcom/free-proxy-list/main/sources/http.txt`,
    geoBatch: "http://ip-api.com/batch?fields=query,countryCode",
    geoPauseMs: 4_200
};

function num(value: ScraperConfigValue | undefined, fallback: number, min: number, max: number): number {
    const n = typeof value === "number" ? value : Number(value);

    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function text(value: ScraperConfigValue | undefined, fallback: string): string {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** `geoUrls` is a comma-separated list, but a URL may itself contain commas
 *  (a `fields=a,b` query), so split only on a comma followed by a scheme. */
function splitUrls(value: string): string[] {
    return value
        .split(/,(?=https?:\/\/)/i)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function codes(value: string): string[] {
    const seen = new Set<string>();

    for (const raw of value.split(/[,\s]+/)) {
        const code = raw.trim().toUpperCase();

        if (/^[A-Z]{2}$/.test(code)) seen.add(code);
    }

    return [...seen];
}

function settingsOf(config: Record<string, ScraperConfigValue> = {}): Settings {
    const geo = splitUrls(text(config.geoUrls, String(CONFIG_SCHEMA.find((f) => f.key === "geoUrls")?.default)));

    return {
        countries: codes(text(config.countries, String(CONFIG_SCHEMA.find((f) => f.key === "countries")?.default))),
        protocols: text(config.protocols, "http,socks5,socks4")
            .toLowerCase()
            .split(/[,\s]+/)
            .filter((entry) => entry === "http" || entry === "socks5" || entry === "socks4"),
        keep: num(config.keepPerCountry, 8, 1, 50),
        minScore: num(config.minScore, 40, 0, 100),
        minMbps: num(config.minMbps, 3, 0.5, 100),
        candidates: num(config.candidates, 150, 5, 1000),
        geolocate: Math.round(num(config.geolocate, 1500, 0, 20000)),
        extraLists: splitUrls(text(config.extraLists, "")),
        concurrency: num(config.concurrency, 30, 1, 200),
        probes: Math.round(num(config.probes, 5, 3, 20)),
        budgetMs: num(config.budgetSeconds, 480, 30, 3600) * 1000,
        latencyUrl: text(config.latencyUrl, "http://cp.cloudflare.com/generate_204"),
        speedUrl: text(config.speedUrl, "https://speed.cloudflare.com/__down?bytes=1000000"),
        geoUrls: geo,
        cacheFile: process.env.PROXY_POOL_CACHE || join(tmpdir(), "live-tv-proxy-pool.json"),
        maxAgeMs: 36 * 60 * 60_000,
        sources: SOURCES
    };
}

let settings: Settings = settingsOf();

// -------------------------------------------------------------------------
// A request through an HTTP proxy (plain node:http; no dependency)
// -------------------------------------------------------------------------

/** TLS options for the tunnelled request; tests relax certificate checks. */
let tlsOptions: ConnectionOptions = {};

interface Through {
    status: number;
    /** Milliseconds until the response headers arrived. */
    ttfbMs: number;
    /** Milliseconds until the body ended (or `maxBytes` was reached). */
    totalMs: number;
    bytes: number;
    /** The first 4 KB of the body, as text. */
    head: string;
}

function isAddress(host: string): boolean {
    return /^[0-9.]+$/.test(host) || host.includes(":");
}

/** CONNECT through the proxy, then TLS over the socket. */
function tunnel(proxy: URL, target: URL, wait: number): Promise<import("node:net").Socket> {
    return new Promise((resolve, reject) => {
        const port = target.port || "443";
        const attempt = httpRequest({
            host: proxy.hostname,
            port: proxy.port || 80,
            method: "CONNECT",
            path: `${target.hostname}:${port}`,
            headers: { host: `${target.hostname}:${port}` },
            timeout: wait
        });

        attempt.on("connect", (answer, socket) => {
            if (answer.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`CONNECT refused: ${answer.statusCode}`));
                return;
            }

            try {
                const secured = tlsConnect({
                    socket,
                    ...(isAddress(target.hostname) ? {} : { servername: target.hostname }),
                    ...tlsOptions
                });

                secured.once("secureConnect", () => resolve(secured));
                secured.once("error", reject);
            } catch (cause) {
                socket.destroy();
                reject(cause instanceof Error ? cause : new Error(String(cause)));
            }
        });
        attempt.on("timeout", () => attempt.destroy(new Error("CONNECT timed out")));
        attempt.on("error", reject);
        attempt.end();
    });
}

/*
    SOCKS (RFC 1928 / SOCKS4), on plain node:net -- a copy of live-tv's
    `socksConnect` (a scraper is one standalone file and cannot import it),
    without the login methods: the lists carry open proxies only.
*/
function socksConnect(proxy: URL, host: string, port: number, wait: number): Promise<Socket> {
    const version = proxy.protocol === "socks4:" ? 4 : 5;
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) || 1080 });

    socket.setTimeout(wait, () => socket.destroy(new Error("the proxy did not answer")));

    return new Promise<Socket>((resolve, reject) => {
        let held = Buffer.alloc(0);
        let need = version === 5 ? 2 : 8;
        let stage = 0;
        const fail = (cause: unknown): void => {
            socket.destroy();
            reject(cause instanceof Error ? cause : new Error(String(cause)));
        };
        const bare = host.replace(/^\[|\]$/g, "");
        const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);

        const finish = (): void => {
            socket.off("data", onData);
            socket.setTimeout(0);
            if (held.length) socket.unshift(held);
            resolve(socket);
        };
        const onData = (chunk: Buffer): void => {
            held = Buffer.concat([held, chunk]);

            while (held.length >= need) {
                const got = held.subarray(0, need);

                held = held.subarray(need);

                if (version === 4) {
                    if (got[1] !== 0x5a) return fail(new Error(`SOCKS4 refused (${got[1]})`));
                    return finish();
                }

                if (stage === 0) {
                    if (got[0] !== 5 || got[1] !== 0) return fail(new Error("SOCKS5 wants a login"));

                    const address = literal ? Buffer.from(bare.split(".").map(Number)) : Buffer.concat([Buffer.from([Buffer.byteLength(bare)]), Buffer.from(bare)]);

                    socket.write(Buffer.concat([Buffer.from([5, 1, 0, literal ? 1 : 3]), address, Buffer.from([port >> 8, port & 255])]));
                    stage = 1;
                    need = 4;
                } else if (stage === 1) {
                    if (got[1] !== 0) return fail(new Error(`SOCKS5 refused (${got[1]})`));

                    stage = 2;
                    need = got[3] === 1 ? 6 : got[3] === 4 ? 18 : 1;
                    if (got[3] === 3) stage = 3;
                } else if (stage === 3) {
                    stage = 2;
                    need = (got[0] as number) + 2;
                } else {
                    return finish();
                }
            }
        };

        socket.on("data", onData);
        socket.once("error", fail);
        socket.once("close", () => fail(new Error("the proxy closed the connection")));
        socket.once("connect", async () => {
            try {
                if (version === 5) {
                    socket.write(Buffer.from([5, 1, 0]));
                } else {
                    const ip = (literal ? bare : (await lookup(bare, { family: 4 })).address).split(".").map(Number);

                    socket.write(Buffer.concat([Buffer.from([4, 1, port >> 8, port & 255, ...ip]), Buffer.from([0])]));
                }
            } catch (cause) {
                fail(cause);
            }
        });
    });
}

/** GET `url` through `proxyUrl`; never follows redirects (a probe is one hop). */
function through(proxyUrl: string, url: string, wait: number, maxBytes = 1_500_000): Promise<Through> {
    const proxy = new URL(proxyUrl);
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const began = Date.now();

    return new Promise<Through>((resolve, reject) => {
        let finished = false;
        let timer: NodeJS.Timeout | undefined;
        let destroy: () => void = () => undefined;
        const fail = (cause: unknown): void => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            destroy();
            reject(cause instanceof Error ? cause : new Error(String(cause)));
        };
        const done = (value: Through): void => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            resolve(value);
        };

        // One deadline for the whole probe, not just for idleness: a proxy
        // that dribbles a byte a second must not hold a test slot.
        timer = setTimeout(() => fail(new Error("timed out")), wait);

        const onResponse = (incoming: import("node:http").IncomingMessage): void => {
            const ttfbMs = Date.now() - began;
            let bytes = 0;
            let head = "";

            destroy = () => incoming.destroy();
            incoming.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (head.length < 4096) head += chunk.toString("utf8", 0, 4096 - head.length);
                if (bytes >= maxBytes) {
                    incoming.destroy();
                    done({ status: incoming.statusCode || 0, ttfbMs, totalMs: Date.now() - began, bytes, head });
                }
            });
            incoming.on("end", () => done({ status: incoming.statusCode || 0, ttfbMs, totalMs: Date.now() - began, bytes, head }));
            incoming.on("error", fail);
            incoming.on("close", () => {
                if (!finished && bytes > 0) done({ status: incoming.statusCode || 0, ttfbMs, totalMs: Date.now() - began, bytes, head });
            });
        };

        if (proxy.protocol.startsWith("socks")) {
            socksConnect(proxy, target.hostname, Number(target.port) || (secure ? 443 : 80), wait).then((raw) => {
                if (finished) {
                    raw.destroy();
                    return;
                }

                const socket = secure
                    ? tlsConnect({ socket: raw, ...(isAddress(target.hostname) ? {} : { servername: target.hostname }), ...tlsOptions })
                    : raw;
                const attempt = httpRequest(
                    {
                        agent: Object.assign(new HttpAgent(), { createConnection: () => socket }),
                        host: target.hostname,
                        path: target.pathname + target.search,
                        headers: { host: target.host, "user-agent": "Mozilla/5.0" }
                    },
                    onResponse
                );

                destroy = () => {
                    attempt.destroy();
                    socket.destroy();
                };
                attempt.on("error", fail);
                attempt.end();
            }, fail);
            return;
        }

        if (!secure) {
            const attempt = httpRequest(
                { host: proxy.hostname, port: proxy.port || 80, path: target.href, headers: { host: target.host, "user-agent": "Mozilla/5.0" } },
                onResponse
            );

            destroy = () => attempt.destroy();
            attempt.on("error", fail);
            attempt.end();
            return;
        }

        tunnel(proxy, target, wait).then((socket) => {
            if (finished) {
                socket.destroy();
                return;
            }

            const attempt = httpRequest(
                {
                    agent: Object.assign(new HttpAgent(), { createConnection: () => socket }),
                    host: target.hostname,
                    path: target.pathname + target.search,
                    headers: { host: target.host, "user-agent": "Mozilla/5.0" }
                },
                onResponse
            );

            destroy = () => {
                attempt.destroy();
                socket.destroy();
            };
            attempt.on("error", fail);
            attempt.end();
        }, fail);
    });
}

// -------------------------------------------------------------------------
// Scoring
// -------------------------------------------------------------------------

/** Each measure maps linearly from its `bad` end (0) to its `good` end (1). */
const SCORE = {
    speed: { weight: 0.35, bad: 1.5, good: 15 }, // Mbit/s
    latency: { weight: 0.25, bad: 2500, good: 200 }, // ms
    jitter: { weight: 0.2, bad: 800, good: 30 }, // ms
    reliability: { weight: 0.2, bad: 0.8, good: 1 } // share of probes
};

function band(value: number, bad: number, good: number): number {
    const t = (value - bad) / (good - bad);

    return Math.min(1, Math.max(0, t));
}

function scoreOf(measure: { mbps: number; latencyMs: number; jitterMs: number; successRate: number }): number {
    const total =
        SCORE.speed.weight * band(measure.mbps, SCORE.speed.bad, SCORE.speed.good) +
        SCORE.latency.weight * band(measure.latencyMs, SCORE.latency.bad, SCORE.latency.good) +
        SCORE.jitter.weight * band(measure.jitterMs, SCORE.jitter.bad, SCORE.jitter.good) +
        SCORE.reliability.weight * band(measure.successRate, SCORE.reliability.bad, SCORE.reliability.good);

    return Math.round(total * 100);
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function jitterOf(values: number[]): number {
    if (values.length < 2) return 0;

    let sum = 0;

    for (let i = 1; i < values.length; i += 1) sum += Math.abs((values[i] as number) - (values[i - 1] as number));

    return sum / (values.length - 1);
}

// -------------------------------------------------------------------------
// Testing one candidate
// -------------------------------------------------------------------------

const PROBE_MS = 8_000;
const SPEED_MS = 20_000;

/** The country a geo endpoint reports, or "" (JSON `countryCode`/`country`, or a bare code). */
function countryIn(body: string): string {
    const trimmed = body.trim();

    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const value = parsed.countryCode ?? parsed.country_code ?? parsed.country;

        if (typeof value === "string" && /^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
    } catch {
        /* not JSON */
    }

    return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : "";
}

type Verdict = { ok: true; info: ProxyInfo } | { ok: false; reason: string };

async function testProxy(url: string, country: string, source: string, cfg: Settings): Promise<Verdict> {
    // 1. Where does it really exit?
    let exit = "";

    for (const geo of cfg.geoUrls) {
        try {
            const got = await through(url, geo, PROBE_MS, 4096);

            if (got.status >= 200 && got.status < 300) {
                exit = countryIn(got.head);
                if (exit) break;
            }
        } catch {
            /* try the next endpoint */
        }
    }

    if (!exit) return { ok: false, reason: "no exit country" };
    if (exit !== country) return { ok: false, reason: `exits in ${exit}` };

    // 2. Latency and jitter over sequential probes.
    const samples: number[] = [];

    for (let i = 0; i < cfg.probes; i += 1) {
        try {
            const got = await through(url, cfg.latencyUrl, PROBE_MS, 4096);

            if (got.status >= 200 && got.status < 400) samples.push(got.ttfbMs);
        } catch {
            /* a failed probe counts against reliability */
        }
    }

    const successRate = samples.length / cfg.probes;

    if (successRate < 0.8) return { ok: false, reason: `only ${samples.length}/${cfg.probes} probes passed` };

    // 3. HTTPS speed.
    let mbps = 0;

    try {
        const got = await through(url, cfg.speedUrl, SPEED_MS, 1_500_000);

        if (got.status < 200 || got.status >= 300 || got.bytes < 50_000) return { ok: false, reason: "https download failed" };

        const seconds = Math.max(0.001, (got.totalMs - got.ttfbMs) / 1000);

        mbps = (got.bytes * 8) / 1_000_000 / seconds;
    } catch (cause) {
        return { ok: false, reason: `https: ${(cause as Error).message}` };
    }

    if (mbps < cfg.minMbps) return { ok: false, reason: `slow: ${mbps.toFixed(1)} Mbit/s` };

    const latencyMs = Math.round(median(samples));
    const jitterMs = Math.round(jitterOf(samples));
    const roundedMbps = Math.round(mbps * 10) / 10;

    return {
        ok: true,
        info: {
            url,
            country,
            score: scoreOf({ mbps, latencyMs, jitterMs, successRate }),
            latencyMs,
            jitterMs,
            mbps: roundedMbps,
            successRate: Math.round(successRate * 100) / 100,
            https: true,
            testedAt: Date.now(),
            source,
            failures: 0
        }
    };
}

// -------------------------------------------------------------------------
// Candidate lists
// -------------------------------------------------------------------------

const ENTRY = /^(?:(http|socks5h?|socks4a?):\/\/)?((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})(?::[A-Za-z][\w .'-]*)?$/i;

/** The kept protocols: socks5h is socks5 and socks4a is socks4 as far as a pool is concerned. */
type Scheme = "http" | "socks5" | "socks4";

function schemeOf(value: string | undefined): Scheme | null {
    const lower = (value || "").toLowerCase();

    return lower === "http" ? "http" : lower.startsWith("socks5") ? "socks5" : lower.startsWith("socks4") ? "socks4" : null;
}

/** An address and port that could be a proxy, as `scheme://ip:port`, or null. */
function proxyUrl(ip: string, port: string | number, scheme: Scheme = "http"): string | null {
    const octets = ip.split(".").map(Number);
    const number = Number(port);

    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return null;
    if (!Number.isInteger(number) || number < 1 || number > 65535) return null;

    return `${scheme}://${ip}:${number}`;
}

/**
 * `scheme://ip:port` for each acceptable line of a list. A line with a scheme
 * keeps it (http, socks5, socks4); a bare `ip:port` gets `scheme`. HTTPS
 * proxies (TLS to the proxy itself) and junk are dropped.
 */
function parseList(body: string, scheme: Scheme = "http"): string[] {
    const found: string[] = [];

    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();

        // Some other scheme (https, ftp ...) is not a proxy the host can use.
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) && !/^(?:http|socks[45][ah]?):\/\//i.test(line)) continue;

        const match = ENTRY.exec(line);
        const url = match ? proxyUrl(match[2] as string, match[3] as string, schemeOf(match[1]) ?? scheme) : null;

        if (url) found.push(url);
    }

    return found;
}

function plain(body: string, scheme: Scheme = "http"): Found[] {
    return parseList(body, scheme).map((url) => ({ url }));
}

function labelled(urls: string[], country: string): Found[] {
    return urls.map((url) => ({ url, country }));
}

function json(body: string): unknown {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

function code(value: unknown): string | undefined {
    return typeof value === "string" && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : undefined;
}

/** GeoNode: `{ data: [{ ip, port, country, protocols }] }`. */
function parseGeonode(body: string, country: string): Found[] {
    const parsed = json(body) as { data?: { ip?: string; port?: string | number; country?: string; protocols?: string[] }[] } | null;
    const found: Found[] = [];

    for (const entry of parsed?.data || []) {
        const scheme = (["http", "socks5", "socks4"] as Scheme[]).find((candidate) => (entry.protocols || []).includes(candidate));
        const url = entry.ip && entry.port && scheme ? proxyUrl(entry.ip, entry.port, scheme) : null;

        if (url) found.push({ url, country: code(entry.country) ?? country });
    }

    return found;
}

/** monosans `proxies.json`: `[{ protocol, host, port, username, geolocation: { country: { iso_code } } }]`. */
function parseMonosans(body: string): Found[] {
    const parsed = json(body);
    const found: Found[] = [];

    if (!Array.isArray(parsed)) return found;

    for (const entry of parsed as { protocol?: string; host?: string; port?: number; username?: string | null; geolocation?: { country?: { iso_code?: string } } }[]) {
        const scheme = schemeOf(entry?.protocol);

        if (!scheme || entry.username) continue;

        const url = entry.host && entry.port ? proxyUrl(entry.host, entry.port, scheme) : null;

        if (url) found.push({ url, country: code(entry.geolocation?.country?.iso_code) });
    }

    return found;
}

/** Thordata `http.json`: `[{ ip, port, type, country_code }]`. */
function parseThordata(body: string): Found[] {
    const parsed = json(body);
    const found: Found[] = [];

    if (!Array.isArray(parsed)) return found;

    for (const entry of parsed as { ip?: string; port?: number; type?: string; country_code?: string }[]) {
        const scheme = schemeOf(entry?.type);

        if (!scheme) continue;

        const url = entry.ip && entry.port ? proxyUrl(entry.ip, entry.port, scheme) : null;

        if (url) found.push({ url, country: code(entry.country_code) });
    }

    return found;
}

/** spys.me: `ip:port CC-N!-S +` per line. */
function parseSpys(body: string): Found[] {
    const found: Found[] = [];

    for (const line of body.split(/\r?\n/)) {
        const match = /^((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\s+([A-Z]{2})-/.exec(line.trim());
        const url = match ? proxyUrl(match[1] as string, match[2] as string) : null;

        if (url) found.push({ url, country: match?.[3] });
    }

    return found;
}

/** The free-proxy-list.net family's tables: `<tr><td>ip</td><td>port</td><td>CC</td>...`. */
function parseTable(html: string): Found[] {
    const found: Found[] = [];

    for (const match of html.matchAll(/<tr><td>((?:\d{1,3}\.){3}\d{1,3})<\/td><td>(\d{2,5})<\/td><td>([A-Z]{2})<\/td>/g)) {
        const url = proxyUrl(match[1] as string, match[2] as string);

        if (url) found.push({ url, country: match[3] });
    }

    return found;
}

/** A public http(s) address: nothing loopback, private or link-local, so a discovered list cannot aim the scraper inward. */
function publicUrl(value: string): boolean {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        return false;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();

    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":")) return false;

    const octets = host.split(".").map(Number);

    if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet))) {
        const [a, b] = octets as [number, number, number, number];

        if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }

    return true;
}

async function get(url: string, limit = 6 * 1024 * 1024): Promise<string> {
    try {
        const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25_000) });

        if (!response.ok) return "";

        return (await response.text()).slice(0, limit);
    } catch {
        return "";
    }
}

/** A short name for a list: host plus the first two path segments (GitHub's owner/repo). */
function listName(url: string): string {
    const parsed = new URL(url);

    return `${parsed.hostname.replace(/^raw\.githubusercontent\.com$/, "github")}/${parsed.pathname.split("/").filter(Boolean).slice(0, 2).join("/")}`;
}

/** At most `limit` of `items` at once. */
async function each<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;

    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const item = items[next] as T;

                next += 1;
                await work(item);
            }
        })
    );
}

/** Country codes for addresses nobody labelled, `geolocate` of them at most, in batches of 100. */
async function geolocate(ips: string[], cfg: Settings, deadline: number): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const { geoBatch, geoPauseMs } = cfg.sources;

    if (!geoBatch || cfg.geolocate < 1) return found;

    const sample = shuffled(ips).slice(0, cfg.geolocate);

    for (let at = 0; at < sample.length && Date.now() < deadline; at += 100) {
        if (at > 0) await new Promise((resolve) => setTimeout(resolve, geoPauseMs));

        try {
            const response = await fetch(geoBatch, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(sample.slice(at, at + 100)),
                signal: AbortSignal.timeout(20_000)
            });

            // 429 means the allowance is spent: what was learned so far is what there is.
            if (!response.ok) break;

            const rows = json(await response.text());

            if (!Array.isArray(rows)) break;

            for (const row of rows as { query?: string; countryCode?: string }[]) {
                const where = code(row?.countryCode);

                if (row?.query && where) found.set(row.query, where);
            }
        } catch {
            break;
        }
    }

    return found;
}

/**
 * Candidates for `countries`, from every source, deduplicated, each with the
 * list that named it. One pass fetches the world lists once, however many
 * countries want them.
 */
async function gather(countries: string[], cfg: Settings, deadline: number): Promise<Map<string, Candidate[]>> {
    const wanted = new Set(countries);
    const result = new Map<string, Map<string, string>>(countries.map((country) => [country, new Map()]));
    const unlabeled = new Map<string, string>();
    const labeledAnywhere = new Set<string>();
    const add = (found: Found, source: string): void => {
        if (!cfg.protocols.includes(schemeOf(/^([a-z0-9]+):/i.exec(found.url)?.[1]) ?? "")) return;

        if (!found.country) {
            if (!unlabeled.has(found.url)) unlabeled.set(found.url, source);
            return;
        }

        labeledAnywhere.add(found.url);

        const into = result.get(found.country);

        if (into && wanted.has(found.country) && !into.has(found.url)) into.set(found.url, source);
    };

    const jobs: (() => Promise<void>)[] = [];

    for (const country of countries) {
        for (const source of cfg.sources.perCountry) {
            jobs.push(async () => {
                if (Date.now() > deadline) return;
                for (const found of source.parse(await get(source.url(country)), country)) add(found, source.name);
            });
        }
    }

    const world: WorldSource[] = [...cfg.sources.world];

    for (const url of cfg.extraLists) world.push({ name: listName(url), url, parse: plain });

    // Discovery: a list of lists. Each becomes one more unlabeled source.
    if (cfg.sources.index) {
        const known = new Set(world.map((source) => source.url));
        const listed = (await get(cfg.sources.index, 256 * 1024))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^https?:\/\//i.test(line) && !known.has(line) && (cfg.sources.indexAllowsPrivate || publicUrl(line)));

        for (const url of shuffled(listed).slice(0, 40)) world.push({ name: listName(url), url, parse: plain });
    }

    for (const source of world) {
        jobs.push(async () => {
            if (Date.now() > deadline) return;
            for (const found of source.parse(await get(source.url))) add(found, source.name);
        });
    }

    await each(jobs, 8, (job) => job());

    // Addresses that no list labelled: ask where they are, then treat them like the rest.
    const pending = [...unlabeled.keys()].filter((url) => !labeledAnywhere.has(url));
    const where = await geolocate(pending.map((url) => new URL(url).hostname), cfg, deadline);

    for (const url of pending) {
        const country = where.get(new URL(url).hostname);
        const into = country ? result.get(country) : undefined;

        if (into && !into.has(url)) into.set(url, unlabeled.get(url) as string);
    }

    return new Map([...result].map(([country, urls]) => [country, [...urls].map(([url, source]) => ({ url, source }))]));
}

function shuffled<T>(items: T[]): T[] {
    const copy = [...items];

    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));

        [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }

    return copy;
}

// -------------------------------------------------------------------------
// The pool
// -------------------------------------------------------------------------

/** Country -> proxies, best first. */
let pool = new Map<string, ProxyInfo[]>();
let loaded = false;
const flights = new Map<string, Promise<void>>();

function rank(entries: ProxyInfo[]): ProxyInfo[] {
    return [...entries].sort((a, b) => b.score - a.score || a.latencyMs - b.latencyMs);
}

function load(): void {
    if (loaded) return;
    loaded = true;

    try {
        const stored = JSON.parse(readFileSync(settings.cacheFile, "utf8")) as Record<string, unknown>;

        for (const [country, entries] of Object.entries(stored)) {
            if (!/^[A-Z]{2}$/.test(country) || !Array.isArray(entries)) continue;

            const valid = (entries as ProxyInfo[]).filter(
                (entry) => entry && typeof entry.url === "string" && ENTRY.test(entry.url) && /^(?:http|socks[45]):/.test(entry.url) && typeof entry.score === "number"
            );

            if (valid.length) pool.set(country, rank(valid));
        }
    } catch {
        /* no cache yet */
    }
}

function save(): void {
    try {
        mkdirSync(dirname(settings.cacheFile), { recursive: true });

        const temporary = `${settings.cacheFile}.tmp`;

        writeFileSync(temporary, JSON.stringify(Object.fromEntries(pool)), { mode: 0o600 });
        renameSync(temporary, settings.cacheFile);
    } catch {
        /* a cache that cannot be written only costs a rebuild after a restart */
    }
}

/** Run `work` over `items`, `limit` at a time, until `stop()` says so. */
async function limited<T>(items: T[], limit: number, stop: () => boolean, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;

    async function lane(): Promise<void> {
        while (next < items.length && !stop()) {
            const item = items[next] as T;

            next += 1;
            await work(item);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** Rebuild one country: re-test what is kept, then try fresh candidates. */
async function refreshCountry(country: string, deadline: number, gathered?: Candidate[]): Promise<void> {
    const cfg = settings;
    const results = new Map<string, ProxyInfo>();
    const timeUp = (): boolean => Date.now() > deadline;

    // What we already hold is tested first: it was good, and it costs nothing to find.
    const held = pool.get(country) || [];

    await limited(held, cfg.concurrency, timeUp, async (entry) => {
        const verdict = await testProxy(entry.url, country, entry.source, cfg);

        if (verdict.ok) results.set(entry.url, verdict.info);
    });

    const good = (): number => [...results.values()].filter((entry) => entry.score >= 70).length;

    if (good() < cfg.keep && !timeUp()) {
        const seen = new Set(held.map((entry) => entry.url));
        const fresh = (gathered ?? (await gather([country], cfg, deadline)).get(country) ?? []).filter((candidate) => !seen.has(candidate.url));
        const picked = shuffled(fresh).slice(0, cfg.candidates);

        await limited(picked, cfg.concurrency, () => timeUp() || good() >= cfg.keep, async (candidate) => {
            const verdict = await testProxy(candidate.url, country, candidate.source, cfg);

            if (verdict.ok) results.set(candidate.url, verdict.info);
        });
    }

    const kept = rank([...results.values()].filter((entry) => entry.score >= cfg.minScore)).slice(0, cfg.keep);

    if (kept.length) pool.set(country, kept);
    // A country where nothing passed keeps what it had only if the time ran out
    // before testing finished; a completed run that found nothing empties it.
    else if (!timeUp()) pool.delete(country);

    save();
}

function refreshOne(country: string, budgetMs: number, gathered?: Candidate[]): Promise<void> {
    const running = flights.get(country);

    if (running) return running;

    const work = refreshCountry(country, Date.now() + budgetMs, gathered)
        .catch((cause) => console.error(`proxy-pool: refresh of ${country} failed`, cause))
        .finally(() => flights.delete(country));

    flights.set(country, work);

    return work;
}

/** Every configured country (and any other already held), oldest first, inside the budget. */
async function refreshAll(): Promise<void> {
    load();

    const deadline = Date.now() + settings.budgetMs;
    const wanted = new Set([...settings.countries, ...pool.keys()]);
    const age = (country: string): number => {
        const stamps = (pool.get(country) || []).map((entry) => entry.testedAt);

        return stamps.length ? Math.min(...stamps) : 0;
    };
    const order = [...wanted].sort((a, b) => age(a) - age(b));

    // Lists are read once for every country, within a third of the budget; testing gets the rest.
    const candidates = await gather(order, settings, Date.now() + settings.budgetMs / 3);

    // A few countries at once; each already runs `concurrency` tests, so the
    // bound that matters is the one inside the country.
    let next = 0;

    async function lane(): Promise<void> {
        while (next < order.length && Date.now() < deadline) {
            const country = order[next] as string;

            next += 1;
            await refreshOne(country, Math.max(1_000, deadline - Date.now()), candidates.get(country) ?? []);
        }
    }

    await Promise.all(Array.from({ length: Math.min(3, order.length) }, lane));
}

// -------------------------------------------------------------------------
// The provider the host asks
// -------------------------------------------------------------------------

const ON_DEMAND_MS = 60_000;

const provider: ProxyProvider = {
    async pick(country) {
        load();

        const code = String(country || "").toUpperCase();

        if (!/^[A-Z]{2}$/.test(code)) return [];

        const entries = pool.get(code);
        const stale = !entries || !entries.length || Date.now() - Math.max(...entries.map((entry) => entry.testedAt)) > settings.maxAgeMs;

        if (stale) await refreshOne(code, ON_DEMAND_MS);

        return rank(pool.get(code) || []).map((entry) => entry.url);
    },

    report(proxy, ok) {
        load();

        for (const [country, entries] of pool) {
            const entry = entries.find((candidate) => candidate.url === proxy);

            if (!entry) continue;

            if (ok) {
                entry.failures = 0;
            } else {
                entry.failures += 1;
                entry.score = Math.max(0, entry.score - 15);
            }

            const remaining = rank(entries.filter((candidate) => candidate.failures < 2));

            if (remaining.length) pool.set(country, remaining);
            else pool.delete(country);

            save();
            return;
        }
    },

    async list() {
        load();

        return [...pool.values()].flat().map((entry) => ({ ...entry }));
    }
};

// -------------------------------------------------------------------------
// The scraper: build() is the refresh job
// -------------------------------------------------------------------------

async function build(context?: ScraperBuildContext): Promise<ScrapedCatalogue> {
    settings = { ...settingsOf(context?.config), sources: settings.sources, cacheFile: settings.cacheFile };
    await refreshAll();

    return { channels: [] };
}

export const proxyPoolScraper: Scraper = {
    id: SCRAPER_ID,
    name: "Proxy pool (per-country HTTP proxies)",
    version: "1.1.0",
    configSchema: CONFIG_SCHEMA,
    proxies: provider,
    build
};

/** For tests: the internals, and a way to replace the settings. */
export const __test = {
    parseList,
    parseGeonode,
    parseMonosans,
    parseThordata,
    parseSpys,
    parseTable,
    publicUrl,
    gather,
    geolocate,
    countryIn,
    scoreOf,
    jitterOf,
    median,
    splitUrls,
    testProxy,
    through,
    refreshOne,
    reset(next: Partial<Settings> = {}, tls: ConnectionOptions = {}): void {
        pool = new Map();
        loaded = true;
        flights.clear();
        settings = { ...settingsOf(), ...next };
        tlsOptions = tls;
    },
    /** Forget memory and re-read the cache file on next use. */
    unload(): void {
        pool = new Map();
        loaded = false;
    },
    settings: (): Settings => settings,
    pool: (): Map<string, ProxyInfo[]> => pool
};

// -------------------------------------------------------------------------
// `npx tsx scrapers/proxy-pool.mts [CC ...]` -- rebuilds the pool for the
// given countries (default DE) against the real lists and prints the result.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const wanted = process.argv.slice(2).map((entry) => entry.toUpperCase());

    build({ config: { countries: (wanted.length ? wanted : ["DE"]).join(",") } })
        .then(async () => {
            const all = await provider.list();

            console.log(`${all.length} proxies kept`);
            for (const entry of rank(all)) {
                console.log(
                    `${entry.country} ${String(entry.score).padStart(3)} ${entry.url.padEnd(28)} ` +
                        `${entry.latencyMs}ms jitter ${entry.jitterMs}ms ${entry.mbps} Mbit/s ok ${entry.successRate} (${entry.source})`
                );
            }
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
