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
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
const SCRAPER_ID = "proxy-pool";
// -------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------
const CONFIG_SCHEMA = [
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
    { key: "candidates", label: "Candidates tested per country", type: "number", default: 4000, min: 5, max: 10000, help: "Most list entries are dead and cost a 2.5 s connect check; about one in 400 survives every test." },
    { key: "geolocate", label: "Unlabeled proxies geolocated per rebuild", type: "number", default: 1500, min: 0, max: 20000, help: "0 skips lists that carry no country." },
    { key: "extraLists", label: "Extra raw proxy-list URLs (comma-separated)", type: "string", default: "", help: "Plain text, one ip:port per line." },
    { key: "concurrency", label: "Proxies tested at once", type: "number", default: 150, min: 1, max: 400 },
    { key: "probes", label: "Latency probes per proxy", type: "number", default: 5, min: 3, max: 20 },
    { key: "budgetSeconds", label: "Longest a rebuild may run (seconds)", type: "number", default: 1500, min: 30, max: 3600 },
    { key: "latencyUrl", label: "Latency test URL", type: "string", default: "http://cp.cloudflare.com/generate_204" },
    { key: "speedUrl", label: "Speed test URL (https)", type: "string", default: "https://speed.cloudflare.com/__down?bytes=1000000" },
    {
        key: "geoUrls",
        label: "Exit-country test URLs (comma-separated)",
        type: "string",
        default: "http://ip-api.com/json?fields=status,countryCode,query,https://api.country.is/"
    }
];
const RAW = "https://raw.githubusercontent.com";
const SOURCES = {
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
            url: (country) => `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${country.toLowerCase()}&protocol=socks5&proxy_format=ipport&format=text&timeout=6000`,
            parse: (body, country) => labelled(parseList(body, "socks5"), country)
        },
        {
            name: "proxyscrape-api",
            url: (country) => `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${country.toLowerCase()}&protocol=http&proxy_format=ipport&format=text&timeout=6000`,
            parse: (body, country) => labelled(parseList(body), country)
        },
        {
            name: "geonode",
            url: (country) => `https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country=${country}&protocols=http`,
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
            ["zloi-user", "zloi-user/hideip.me/main/http.txt"],
            ["ErcinDedeoglu", "ErcinDedeoglu/proxies/main/proxies/http.txt"],
            ["Anonym0usWork1221", "Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt"],
            ["sunny9577", "sunny9577/proxy-scraper/master/generated/http_proxies.txt"],
            ["mmpx12", "mmpx12/proxy-list/master/http.txt"],
            ["rdavydov", "rdavydov/proxy-list/main/proxies/http.txt"],
            ["prxchk", "prxchk/proxy-list/main/http.txt"],
            ["elliottophellia", "elliottophellia/proxylist/master/results/pmix_checked.txt"]
        ].map(([name, path]) => ({ name: name, url: `${RAW}/${path}`, parse: (body) => plain(body) })),
        ...[
            ["TheSpeedX-socks5", "TheSpeedX/PROXY-List/master/socks5.txt", "socks5"],
            ["TheSpeedX-socks4", "TheSpeedX/PROXY-List/master/socks4.txt", "socks4"],
            ["monosans-socks5", "monosans/proxy-list/main/proxies/socks5.txt", "socks5"],
            ["monosans-socks4", "monosans/proxy-list/main/proxies/socks4.txt", "socks4"],
            ["hookzof", "hookzof/socks5_list/master/proxy.txt", "socks5"],
            ["jetkai-socks5", "jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt", "socks5"],
            ["MuRongPIG-socks5", "MuRongPIG/Proxy-Master/main/socks5.txt", "socks5"],
            ["ShiftyTR-socks5", "ShiftyTR/Proxy-List/master/socks5.txt", "socks5"],
            ["ShiftyTR-socks4", "ShiftyTR/Proxy-List/master/socks4.txt", "socks4"],
            ["roosterkid-socks5", "roosterkid/openproxylist/main/SOCKS5_RAW.txt", "socks5"],
            ["roosterkid-socks4", "roosterkid/openproxylist/main/SOCKS4_RAW.txt", "socks4"],
            ["vakhov-socks5", "vakhov/fresh-proxy-list/master/socks5.txt", "socks5"],
            ["Zaeem20-socks5", "Zaeem20/FREE_PROXIES_LIST/master/socks5.txt", "socks5"],
            ["zloi-user-socks5", "zloi-user/hideip.me/main/socks5.txt", "socks5"],
            ["ErcinDedeoglu-socks5", "ErcinDedeoglu/proxies/main/proxies/socks5.txt", "socks5"],
            ["Anonym0usWork1221-socks5", "Anonym0usWork1221/Free-Proxies/main/proxy_files/socks5_proxies.txt", "socks5"],
            ["mmpx12-socks5", "mmpx12/proxy-list/master/socks5.txt", "socks5"]
        ].map(([name, path, scheme]) => ({ name: name, url: `${RAW}/${path}`, parse: (body) => plain(body, scheme) }))
    ],
    index: `${RAW}/gfpcom/free-proxy-list/main/sources/http.txt`,
    geoBatch: "http://ip-api.com/batch?fields=query,countryCode",
    geoPauseMs: 4_200
};
function num(value, fallback, min, max) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function text(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
/** `geoUrls` is a comma-separated list, but a URL may itself contain commas
 *  (a `fields=a,b` query), so split only on a comma followed by a scheme. */
function splitUrls(value) {
    return value
        .split(/,(?=https?:\/\/)/i)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function codes(value) {
    const seen = new Set();
    for (const raw of value.split(/[,\s]+/)) {
        const code = raw.trim().toUpperCase();
        if (/^[A-Z]{2}$/.test(code))
            seen.add(code);
    }
    return [...seen];
}
function settingsOf(config = {}) {
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
        candidates: num(config.candidates, 4000, 5, 10000),
        geolocate: Math.round(num(config.geolocate, 1500, 0, 20000)),
        extraLists: splitUrls(text(config.extraLists, "")),
        concurrency: num(config.concurrency, 150, 1, 400),
        probes: Math.round(num(config.probes, 5, 3, 20)),
        budgetMs: num(config.budgetSeconds, 1500, 30, 3600) * 1000,
        latencyUrl: text(config.latencyUrl, "http://cp.cloudflare.com/generate_204"),
        speedUrl: text(config.speedUrl, "https://speed.cloudflare.com/__down?bytes=1000000"),
        geoUrls: geo,
        cacheFile: process.env.PROXY_POOL_CACHE || join(tmpdir(), "live-tv-proxy-pool.json"),
        maxAgeMs: 36 * 60 * 60_000,
        sources: SOURCES
    };
}
let settings = settingsOf();
// -------------------------------------------------------------------------
// A request through an HTTP proxy (plain node:http; no dependency)
// -------------------------------------------------------------------------
/** TLS options for the tunnelled request; tests relax certificate checks. */
let tlsOptions = {};
function isAddress(host) {
    return /^[0-9.]+$/.test(host) || host.includes(":");
}
/** CONNECT through the proxy, then TLS over the socket. */
function tunnel(proxy, target, wait) {
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
            }
            catch (cause) {
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
function socksConnect(proxy, host, port, wait) {
    const version = proxy.protocol === "socks4:" ? 4 : 5;
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) || 1080 });
    socket.setTimeout(wait, () => socket.destroy(new Error("the proxy did not answer")));
    return new Promise((resolve, reject) => {
        let held = Buffer.alloc(0);
        let need = version === 5 ? 2 : 8;
        let stage = 0;
        const fail = (cause) => {
            socket.destroy();
            reject(cause instanceof Error ? cause : new Error(String(cause)));
        };
        const bare = host.replace(/^\[|\]$/g, "");
        const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
        const finish = () => {
            socket.off("data", onData);
            socket.setTimeout(0);
            if (held.length)
                socket.unshift(held);
            resolve(socket);
        };
        const onData = (chunk) => {
            held = Buffer.concat([held, chunk]);
            while (held.length >= need) {
                const got = held.subarray(0, need);
                held = held.subarray(need);
                if (version === 4) {
                    if (got[1] !== 0x5a)
                        return fail(new Error(`SOCKS4 refused (${got[1]})`));
                    return finish();
                }
                if (stage === 0) {
                    if (got[0] !== 5 || got[1] !== 0)
                        return fail(new Error("SOCKS5 wants a login"));
                    const address = literal ? Buffer.from(bare.split(".").map(Number)) : Buffer.concat([Buffer.from([Buffer.byteLength(bare)]), Buffer.from(bare)]);
                    socket.write(Buffer.concat([Buffer.from([5, 1, 0, literal ? 1 : 3]), address, Buffer.from([port >> 8, port & 255])]));
                    stage = 1;
                    need = 4;
                }
                else if (stage === 1) {
                    if (got[1] !== 0)
                        return fail(new Error(`SOCKS5 refused (${got[1]})`));
                    stage = 2;
                    need = got[3] === 1 ? 6 : got[3] === 4 ? 18 : 1;
                    if (got[3] === 3)
                        stage = 3;
                }
                else if (stage === 3) {
                    stage = 2;
                    need = got[0] + 2;
                }
                else {
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
                }
                else {
                    const ip = (literal ? bare : (await lookup(bare, { family: 4 })).address).split(".").map(Number);
                    socket.write(Buffer.concat([Buffer.from([4, 1, port >> 8, port & 255, ...ip]), Buffer.from([0])]));
                }
            }
            catch (cause) {
                fail(cause);
            }
        });
    });
}
/** GET `url` through `proxyUrl`; never follows redirects (a probe is one hop). */
function through(proxyUrl, url, wait, maxBytes = 1_500_000) {
    const proxy = new URL(proxyUrl);
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const began = Date.now();
    return new Promise((resolve, reject) => {
        let finished = false;
        let timer;
        let destroy = () => undefined;
        const fail = (cause) => {
            if (finished)
                return;
            finished = true;
            if (timer)
                clearTimeout(timer);
            destroy();
            reject(cause instanceof Error ? cause : new Error(String(cause)));
        };
        const done = (value) => {
            if (finished)
                return;
            finished = true;
            if (timer)
                clearTimeout(timer);
            resolve(value);
        };
        // One deadline for the whole probe, not just for idleness: a proxy
        // that dribbles a byte a second must not hold a test slot.
        timer = setTimeout(() => fail(new Error("timed out")), wait);
        const onResponse = (incoming) => {
            const ttfbMs = Date.now() - began;
            let bytes = 0;
            let head = "";
            destroy = () => incoming.destroy();
            incoming.on("data", (chunk) => {
                bytes += chunk.length;
                if (head.length < 4096)
                    head += chunk.toString("utf8", 0, 4096 - head.length);
                if (bytes >= maxBytes) {
                    incoming.destroy();
                    done({ status: incoming.statusCode || 0, ttfbMs, totalMs: Date.now() - began, bytes, head });
                }
            });
            incoming.on("end", () => done({ status: incoming.statusCode || 0, ttfbMs, totalMs: Date.now() - began, bytes, head }));
            incoming.on("error", fail);
            incoming.on("close", () => {
                if (!finished && bytes > 0)
                    done({ status: incoming.statusCode || 0, ttfbMs, totalMs: Date.now() - began, bytes, head });
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
                const attempt = httpRequest({
                    agent: Object.assign(new HttpAgent(), { createConnection: () => socket }),
                    host: target.hostname,
                    path: target.pathname + target.search,
                    headers: { host: target.host, "user-agent": "Mozilla/5.0" }
                }, onResponse);
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
            const attempt = httpRequest({ host: proxy.hostname, port: proxy.port || 80, path: target.href, headers: { host: target.host, "user-agent": "Mozilla/5.0" } }, onResponse);
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
            const attempt = httpRequest({
                agent: Object.assign(new HttpAgent(), { createConnection: () => socket }),
                host: target.hostname,
                path: target.pathname + target.search,
                headers: { host: target.host, "user-agent": "Mozilla/5.0" }
            }, onResponse);
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
function band(value, bad, good) {
    const t = (value - bad) / (good - bad);
    return Math.min(1, Math.max(0, t));
}
function scoreOf(measure) {
    const total = SCORE.speed.weight * band(measure.mbps, SCORE.speed.bad, SCORE.speed.good) +
        SCORE.latency.weight * band(measure.latencyMs, SCORE.latency.bad, SCORE.latency.good) +
        SCORE.jitter.weight * band(measure.jitterMs, SCORE.jitter.bad, SCORE.jitter.good) +
        SCORE.reliability.weight * band(measure.successRate, SCORE.reliability.bad, SCORE.reliability.good);
    return Math.round(total * 100);
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function jitterOf(values) {
    if (values.length < 2)
        return 0;
    let sum = 0;
    for (let i = 1; i < values.length; i += 1)
        sum += Math.abs(values[i] - values[i - 1]);
    return sum / (values.length - 1);
}
// -------------------------------------------------------------------------
// Testing one candidate
// -------------------------------------------------------------------------
const PROBE_MS = 8_000;
const SPEED_MS = 20_000;
/** The country a geo endpoint reports, or "" (JSON `countryCode`/`country`, or a bare code). */
function countryIn(body) {
    const trimmed = body.trim();
    try {
        const parsed = JSON.parse(trimmed);
        const value = parsed.countryCode ?? parsed.country_code ?? parsed.country;
        if (typeof value === "string" && /^[A-Za-z]{2}$/.test(value))
            return value.toUpperCase();
    }
    catch {
        /* not JSON */
    }
    return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : "";
}
/** Does anything accept a TCP connection there? Most free-list entries are long dead, and this costs 2.5 s, not a probe's 8. */
function reachable(url, ms = 2_500) {
    return new Promise((resolve) => {
        const target = new URL(url);
        const socket = netConnect({ host: target.hostname, port: Number(target.port) });
        const done = (up) => {
            socket.destroy();
            resolve(up);
        };
        socket.setTimeout(ms, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}
async function testProxy(url, country, source, cfg) {
    if (!(await reachable(url)))
        return { ok: false, reason: "no connection" };
    // 1. Where does it really exit?
    let exit = "";
    for (const geo of cfg.geoUrls) {
        try {
            const got = await through(url, geo, PROBE_MS, 4096);
            if (got.status >= 200 && got.status < 300) {
                exit = countryIn(got.head);
                if (exit)
                    break;
            }
        }
        catch {
            /* try the next endpoint */
        }
    }
    if (!exit)
        return { ok: false, reason: "no exit country" };
    if (exit !== country)
        return { ok: false, reason: `exits in ${exit}` };
    // 2. Latency and jitter over sequential probes.
    const samples = [];
    for (let i = 0; i < cfg.probes; i += 1) {
        try {
            const got = await through(url, cfg.latencyUrl, PROBE_MS, 4096);
            if (got.status >= 200 && got.status < 400)
                samples.push(got.ttfbMs);
        }
        catch {
            /* a failed probe counts against reliability */
        }
    }
    const successRate = samples.length / cfg.probes;
    if (successRate < 0.8)
        return { ok: false, reason: `only ${samples.length}/${cfg.probes} probes passed` };
    // 3. HTTPS speed.
    let mbps = 0;
    try {
        const got = await through(url, cfg.speedUrl, SPEED_MS, 1_500_000);
        if (got.status < 200 || got.status >= 300 || got.bytes < 50_000)
            return { ok: false, reason: "https download failed" };
        const seconds = Math.max(0.001, (got.totalMs - got.ttfbMs) / 1000);
        mbps = (got.bytes * 8) / 1_000_000 / seconds;
    }
    catch (cause) {
        return { ok: false, reason: `https: ${cause.message}` };
    }
    if (mbps < cfg.minMbps)
        return { ok: false, reason: `slow: ${mbps.toFixed(1)} Mbit/s` };
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
function schemeOf(value) {
    const lower = (value || "").toLowerCase();
    return lower === "http" ? "http" : lower.startsWith("socks5") ? "socks5" : lower.startsWith("socks4") ? "socks4" : null;
}
/** An address and port that could be a proxy, as `scheme://ip:port`, or null. */
function proxyUrl(ip, port, scheme = "http") {
    const octets = ip.split(".").map(Number);
    const number = Number(port);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255))
        return null;
    if (!Number.isInteger(number) || number < 1 || number > 65535)
        return null;
    // Rebuilt from the numbers: a list's "078.84.81.60" is not a URL host.
    return `${scheme}://${octets.join(".")}:${number}`;
}
/**
 * `scheme://ip:port` for each acceptable line of a list. A line with a scheme
 * keeps it (http, socks5, socks4); a bare `ip:port` gets `scheme`. HTTPS
 * proxies (TLS to the proxy itself) and junk are dropped.
 */
function parseList(body, scheme = "http") {
    const found = [];
    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        // Some other scheme (https, ftp ...) is not a proxy the host can use.
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) && !/^(?:http|socks[45][ah]?):\/\//i.test(line))
            continue;
        const match = ENTRY.exec(line);
        const url = match ? proxyUrl(match[2], match[3], schemeOf(match[1]) ?? scheme) : null;
        if (url)
            found.push(url);
    }
    return found;
}
function plain(body, scheme = "http") {
    return parseList(body, scheme).map((url) => ({ url }));
}
function labelled(urls, country) {
    return urls.map((url) => ({ url, country }));
}
function json(body) {
    try {
        return JSON.parse(body);
    }
    catch {
        return null;
    }
}
function code(value) {
    return typeof value === "string" && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : undefined;
}
/** GeoNode: `{ data: [{ ip, port, country, protocols }] }`. */
function parseGeonode(body, country) {
    const parsed = json(body);
    const found = [];
    for (const entry of parsed?.data || []) {
        const scheme = ["http", "socks5", "socks4"].find((candidate) => (entry.protocols || []).includes(candidate));
        const url = entry.ip && entry.port && scheme ? proxyUrl(entry.ip, entry.port, scheme) : null;
        if (url)
            found.push({ url, country: code(entry.country) ?? country });
    }
    return found;
}
/** monosans `proxies.json`: `[{ protocol, host, port, username, geolocation: { country: { iso_code } } }]`. */
function parseMonosans(body) {
    const parsed = json(body);
    const found = [];
    if (!Array.isArray(parsed))
        return found;
    for (const entry of parsed) {
        const scheme = schemeOf(entry?.protocol);
        if (!scheme || entry.username)
            continue;
        const url = entry.host && entry.port ? proxyUrl(entry.host, entry.port, scheme) : null;
        if (url)
            found.push({ url, country: code(entry.geolocation?.country?.iso_code) });
    }
    return found;
}
/** Thordata `http.json`: `[{ ip, port, type, country_code }]`. */
function parseThordata(body) {
    const parsed = json(body);
    const found = [];
    if (!Array.isArray(parsed))
        return found;
    for (const entry of parsed) {
        const scheme = schemeOf(entry?.type);
        if (!scheme)
            continue;
        const url = entry.ip && entry.port ? proxyUrl(entry.ip, entry.port, scheme) : null;
        if (url)
            found.push({ url, country: code(entry.country_code) });
    }
    return found;
}
/** spys.me: `ip:port CC-N!-S +` per line. */
function parseSpys(body) {
    const found = [];
    for (const line of body.split(/\r?\n/)) {
        const match = /^((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\s+([A-Z]{2})-/.exec(line.trim());
        const url = match ? proxyUrl(match[1], match[2]) : null;
        if (url)
            found.push({ url, country: match?.[3] });
    }
    return found;
}
/** The free-proxy-list.net family's tables: `<tr><td>ip</td><td>port</td><td>CC</td>...`. */
function parseTable(html) {
    const found = [];
    for (const match of html.matchAll(/<tr><td>((?:\d{1,3}\.){3}\d{1,3})<\/td><td>(\d{2,5})<\/td><td>([A-Z]{2})<\/td>/g)) {
        const url = proxyUrl(match[1], match[2]);
        if (url)
            found.push({ url, country: match[3] });
    }
    return found;
}
/** A public http(s) address: nothing loopback, private or link-local, so a discovered list cannot aim the scraper inward. */
function publicUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":"))
        return false;
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet))) {
        const [a, b] = octets;
        if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
            return false;
    }
    return true;
}
async function get(url, limit = 6 * 1024 * 1024) {
    try {
        const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25_000) });
        if (!response.ok)
            return "";
        return (await response.text()).slice(0, limit);
    }
    catch {
        return "";
    }
}
/** A short name for a list: host plus the first two path segments (GitHub's owner/repo). */
function listName(url) {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^raw\.githubusercontent\.com$/, "github")}/${parsed.pathname.split("/").filter(Boolean).slice(0, 2).join("/")}`;
}
/** At most `limit` of `items` at once. */
async function each(items, limit, work) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next];
            next += 1;
            await work(item);
        }
    }));
}
/** Country codes for addresses nobody labelled, `geolocate` of them at most, in batches of 100. */
async function geolocate(ips, cfg, deadline) {
    const found = new Map();
    const { geoBatch, geoPauseMs } = cfg.sources;
    if (!geoBatch || cfg.geolocate < 1)
        return found;
    const sample = shuffled(ips).slice(0, cfg.geolocate);
    for (let at = 0; at < sample.length && Date.now() < deadline; at += 100) {
        if (at > 0)
            await new Promise((resolve) => setTimeout(resolve, geoPauseMs));
        try {
            const response = await fetch(geoBatch, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(sample.slice(at, at + 100)),
                signal: AbortSignal.timeout(20_000)
            });
            // 429 means the allowance is spent: what was learned so far is what there is.
            if (!response.ok)
                break;
            const rows = json(await response.text());
            if (!Array.isArray(rows))
                break;
            for (const row of rows) {
                const where = code(row?.countryCode);
                if (row?.query && where)
                    found.set(row.query, where);
            }
        }
        catch {
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
async function gather(countries, cfg, deadline) {
    const wanted = new Set(countries);
    const result = new Map(countries.map((country) => [country, new Map()]));
    const unlabeled = new Map();
    const labeledAnywhere = new Set();
    const add = (found, source) => {
        if (!cfg.protocols.includes(schemeOf(/^([a-z0-9]+):/i.exec(found.url)?.[1]) ?? ""))
            return;
        if (!found.country) {
            if (!unlabeled.has(found.url))
                unlabeled.set(found.url, source);
            return;
        }
        labeledAnywhere.add(found.url);
        const into = result.get(found.country);
        if (into && wanted.has(found.country) && !into.has(found.url))
            into.set(found.url, source);
    };
    const jobs = [];
    for (const country of countries) {
        for (const source of cfg.sources.perCountry) {
            jobs.push(async () => {
                if (Date.now() > deadline)
                    return;
                for (const found of source.parse(await get(source.url(country)), country))
                    add(found, source.name);
            });
        }
    }
    const world = [...cfg.sources.world];
    for (const url of cfg.extraLists)
        world.push({ name: listName(url), url, parse: plain });
    // Discovery: a list of lists. Each becomes one more unlabeled source.
    if (cfg.sources.index) {
        const known = new Set(world.map((source) => source.url));
        const listed = (await get(cfg.sources.index, 256 * 1024))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^https?:\/\//i.test(line) && !known.has(line) && (cfg.sources.indexAllowsPrivate || publicUrl(line)));
        for (const url of shuffled(listed).slice(0, 40))
            world.push({ name: listName(url), url, parse: plain });
    }
    for (const source of world) {
        jobs.push(async () => {
            if (Date.now() > deadline)
                return;
            for (const found of source.parse(await get(source.url)))
                add(found, source.name);
        });
    }
    await each(jobs, 8, (job) => job());
    // Addresses that no list labelled: ask where they are, then treat them like the rest.
    const pending = [...unlabeled.keys()].filter((url) => !labeledAnywhere.has(url));
    const where = await geolocate(pending.map((url) => new URL(url).hostname), cfg, deadline);
    for (const url of pending) {
        const country = where.get(new URL(url).hostname);
        const into = country ? result.get(country) : undefined;
        if (into && !into.has(url))
            into.set(url, unlabeled.get(url));
    }
    return new Map([...result].map(([country, urls]) => [country, [...urls].map(([url, source]) => ({ url, source }))]));
}
function shuffled(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}
// -------------------------------------------------------------------------
// The pool
// -------------------------------------------------------------------------
/** Country -> proxies, best first. */
let pool = new Map();
let loaded = false;
const flights = new Map();
function rank(entries) {
    return [...entries].sort((a, b) => b.score - a.score || a.latencyMs - b.latencyMs);
}
function load() {
    if (loaded)
        return;
    loaded = true;
    try {
        const stored = JSON.parse(readFileSync(settings.cacheFile, "utf8"));
        for (const [country, entries] of Object.entries(stored)) {
            if (!/^[A-Z]{2}$/.test(country) || !Array.isArray(entries))
                continue;
            const valid = entries.filter((entry) => entry && typeof entry.url === "string" && ENTRY.test(entry.url) && /^(?:http|socks[45]):/.test(entry.url) && typeof entry.score === "number");
            if (valid.length)
                pool.set(country, rank(valid));
        }
    }
    catch {
        /* no cache yet */
    }
}
function save() {
    try {
        mkdirSync(dirname(settings.cacheFile), { recursive: true });
        const temporary = `${settings.cacheFile}.tmp`;
        writeFileSync(temporary, JSON.stringify(Object.fromEntries(pool)), { mode: 0o600 });
        renameSync(temporary, settings.cacheFile);
    }
    catch {
        /* a cache that cannot be written only costs a rebuild after a restart */
    }
}
/** Run `work` over `items`, `limit` at a time, until `stop()` says so. */
async function limited(items, limit, stop, work) {
    let next = 0;
    async function lane() {
        while (next < items.length && !stop()) {
            const item = items[next];
            next += 1;
            await work(item);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
/** Rebuild one country: re-test what is kept, then try fresh candidates. */
async function refreshCountry(country, deadline, gathered) {
    const cfg = settings;
    const results = new Map();
    const timeUp = () => Date.now() > deadline;
    // What we already hold is tested first: it was good, and it costs nothing to find.
    const held = pool.get(country) || [];
    await limited(held, cfg.concurrency, timeUp, async (entry) => {
        const verdict = await testProxy(entry.url, country, entry.source, cfg);
        if (verdict.ok)
            results.set(entry.url, verdict.info);
    });
    const good = () => [...results.values()].filter((entry) => entry.score >= 70).length;
    if (good() < cfg.keep && !timeUp()) {
        const seen = new Set(held.map((entry) => entry.url));
        const fresh = (gathered ?? (await gather([country], cfg, deadline)).get(country) ?? []).filter((candidate) => !seen.has(candidate.url));
        // The small per-country lists are tested first; a bulk list that names tens of
        // thousands of addresses for one country is mostly dead, so it only fills the rest.
        const size = new Map();
        for (const candidate of fresh)
            size.set(candidate.source, (size.get(candidate.source) ?? 0) + 1);
        const bulk = (candidate) => ((size.get(candidate.source) ?? 0) > 2_000 ? 1 : 0);
        const picked = shuffled(fresh)
            .sort((a, b) => bulk(a) - bulk(b))
            .slice(0, cfg.candidates);
        await limited(picked, cfg.concurrency, () => timeUp() || good() >= cfg.keep, async (candidate) => {
            const verdict = await testProxy(candidate.url, country, candidate.source, cfg);
            if (verdict.ok)
                results.set(candidate.url, verdict.info);
        });
    }
    const kept = rank([...results.values()].filter((entry) => entry.score >= cfg.minScore)).slice(0, cfg.keep);
    if (kept.length)
        pool.set(country, kept);
    // A country where nothing passed keeps what it had only if the time ran out
    // before testing finished; a completed run that found nothing empties it.
    else if (!timeUp())
        pool.delete(country);
    save();
}
function refreshOne(country, budgetMs, gathered) {
    const running = flights.get(country);
    if (running)
        return running;
    const work = refreshCountry(country, Date.now() + budgetMs, gathered)
        .catch((cause) => console.error(`proxy-pool: refresh of ${country} failed`, cause))
        .finally(() => flights.delete(country));
    flights.set(country, work);
    return work;
}
/** Every configured country (and any other already held), oldest first, inside the budget. */
async function refreshAll() {
    load();
    const deadline = Date.now() + settings.budgetMs;
    const wanted = new Set([...settings.countries, ...pool.keys()]);
    const age = (country) => {
        const stamps = (pool.get(country) || []).map((entry) => entry.testedAt);
        return stamps.length ? Math.min(...stamps) : 0;
    };
    const order = [...wanted].sort((a, b) => age(a) - age(b));
    // Lists are read once for every country, within a third of the budget; testing gets the rest.
    const candidates = await gather(order, settings, Date.now() + settings.budgetMs / 3);
    // A few countries at once; each already runs `concurrency` tests, so the
    // bound that matters is the one inside the country.
    let next = 0;
    async function lane() {
        while (next < order.length && Date.now() < deadline) {
            const country = order[next];
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
const provider = {
    async pick(country) {
        load();
        const code = String(country || "").toUpperCase();
        if (!/^[A-Z]{2}$/.test(code))
            return [];
        const entries = pool.get(code);
        const stale = !entries || !entries.length || Date.now() - Math.max(...entries.map((entry) => entry.testedAt)) > settings.maxAgeMs;
        if (stale)
            await refreshOne(code, ON_DEMAND_MS);
        return rank(pool.get(code) || []).map((entry) => entry.url);
    },
    report(proxy, ok) {
        load();
        for (const [country, entries] of pool) {
            const entry = entries.find((candidate) => candidate.url === proxy);
            if (!entry)
                continue;
            if (ok) {
                entry.failures = 0;
            }
            else {
                entry.failures += 1;
                entry.score = Math.max(0, entry.score - 15);
            }
            const remaining = rank(entries.filter((candidate) => candidate.failures < 2));
            if (remaining.length)
                pool.set(country, remaining);
            else
                pool.delete(country);
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
async function build(context) {
    settings = { ...settingsOf(context?.config), sources: settings.sources, cacheFile: settings.cacheFile };
    await refreshAll();
    return { channels: [] };
}
export const proxyPoolScraper = {
    id: SCRAPER_ID,
    name: "Proxy pool (per-country HTTP proxies)",
    version: "1.2.0",
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
    reachable,
    settingsOf,
    through,
    refreshOne,
    reset(next = {}, tls = {}) {
        pool = new Map();
        loaded = true;
        flights.clear();
        settings = { ...settingsOf(), ...next };
        tlsOptions = tls;
    },
    /** Forget memory and re-read the cache file on next use. */
    unload() {
        pool = new Map();
        loaded = false;
    },
    settings: () => settings,
    pool: () => pool
};
// -------------------------------------------------------------------------
// `npx tsx scrapers/proxy-pool.mts [CC ...]` -- rebuilds the pool for the
// given countries (default DE) against the real lists and prints the result.
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    const wanted = process.argv.slice(2).map((entry) => entry.toUpperCase());
    build({ config: { ...JSON.parse(process.env.PROXY_POOL_CONFIG || "{}"), countries: (wanted.length ? wanted : ["DE"]).join(",") } })
        .then(async () => {
        const all = await provider.list();
        console.log(`${all.length} proxies kept`);
        for (const entry of rank(all)) {
            console.log(`${entry.country} ${String(entry.score).padStart(3)} ${entry.url.padEnd(28)} ` +
                `${entry.latencyMs}ms jitter ${entry.jitterMs}ms ${entry.mbps} Mbit/s ok ${entry.successRate} (${entry.source})`);
        }
    })
        .catch((cause) => {
        console.error("build() threw:", cause);
        process.exitCode = 1;
    });
}
