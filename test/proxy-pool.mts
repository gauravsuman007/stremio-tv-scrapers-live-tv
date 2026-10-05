/*
    THE PROXY POOL (scrapers/proxy-pool.mts), against local fakes only: fake
    HTTP proxies with set exit country, latency, jitter, failure and speed, a
    fake candidate list, a fake TLS origin behind CONNECT. Nothing here touches
    the internet. Run with `npm test`.
*/
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as tlsServer } from "node:https";
import { connect, createServer as createNet, type AddressInfo, type Socket } from "node:net";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { __test, proxyPoolScraper } from "../scrapers/proxy-pool.mts";

let checks = 0;
const ok = (value: unknown, said: string): void => {
    assert.ok(value, said);
    checks += 1;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ---- pure parts ------------------------------------------------------ */

ok(
    JSON.stringify(
        __test.parseList(
            ["http://1.2.3.4:8080", "5.6.7.8:3128", "socks5://9.9.9.9:1080", "https://8.8.8.8:443", "999.1.1.1:80", "1.1.1.1:0", "1.1.1.1:70000", "junk", " 2.2.2.2:81 "].join("\n")
        )
    ) === JSON.stringify(["http://1.2.3.4:8080", "http://5.6.7.8:3128", "socks5://9.9.9.9:1080", "http://2.2.2.2:81"]),
    "a list keeps valid http and SOCKS proxies as scheme://ip:port; https proxies, bad octets and ports and junk are dropped"
);
ok(__test.countryIn('{"status":"success","countryCode":"de","query":"1.2.3.4"}') === "DE", "ip-api shape");
ok(__test.countryIn('{"ip":"1.2.3.4","country":"fr"}') === "FR", "country.is shape");
ok(__test.countryIn("nl\n") === "NL", "a bare code");
ok(__test.countryIn("<html>blocked</html>") === "" && __test.countryIn('{"country":"Germany"}') === "", "anything else is no answer");
ok(
    __test.splitUrls("http://a/x?fields=a,b,c,https://b/y").length === 2,
    "a comma inside a query is not a separator"
);
ok(__test.median([3, 1, 2]) === 2 && __test.median([1, 2, 3, 10]) === 2.5, "median");
ok(__test.jitterOf([100, 100, 100]) === 0 && __test.jitterOf([100, 200, 100]) === 100, "jitter is the mean consecutive difference");

const fast = { mbps: 30, latencyMs: 80, jitterMs: 5, successRate: 1 };

ok(__test.scoreOf(fast) === 100, "a fast, steady proxy scores 100");
ok(__test.scoreOf({ ...fast, jitterMs: 400 }) < __test.scoreOf(fast), "jitter costs score");
ok(__test.scoreOf({ ...fast, latencyMs: 1500 }) < __test.scoreOf(fast), "latency costs score");
ok(__test.scoreOf({ ...fast, mbps: 4 }) < __test.scoreOf(fast), "slowness costs score");
ok(__test.scoreOf({ ...fast, successRate: 0.8 }) < __test.scoreOf(fast), "unreliability costs score");
ok(__test.scoreOf({ mbps: 1, latencyMs: 5000, jitterMs: 2000, successRate: 0.8 }) === 0, "the worst is 0");

/* ---- fakes ----------------------------------------------------------- */

const dir = mkdtempSync(`${tmpdir()}/proxy-pool-`);

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-subj", "/CN=speed.test", "-days", "2"], { stdio: "ignore" });

const SPEED_BYTES = 300_000;

/** One HTTPS origin per proxy (so each has its own speed): sends SPEED_BYTES at `rate` Mbit/s. */
async function fakeOrigin(rate: number): Promise<number> {
    const server = tlsServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, async (_request, response) => {
        const chunk = 30_000;
        const pause = (((chunk * 8) / (rate * 1_000_000)) * 1000);

        response.writeHead(200, { "content-length": SPEED_BYTES });
        for (let sent = 0; sent < SPEED_BYTES; sent += chunk) {
            response.write(Buffer.alloc(Math.min(chunk, SPEED_BYTES - sent), 1));
            await sleep(pause);
        }
        response.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server as never);

    return (server.address() as AddressInfo).port;
}

interface Behaviour {
    exit: string;
    /** Latency of a small request: a fixed number, or a function of the call count. */
    delay: number | ((n: number) => number);
    /** Mbit/s of the https download. */
    rate?: number;
    /** Fail every nth small request (0 = never). */
    failEvery?: number;
    /** Refuse CONNECT. */
    noTunnel?: boolean;
}

const servers: ReturnType<typeof httpServer>[] = [];

/** What a proxy's "internet" answers: where it exits (geo.test) and how it performs (lat.test). */
function handlerFor(behaviour: Behaviour): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
    let calls = 0;

    return async (request, response) => {
        const url = new URL(request.url || "", `http://${request.headers.host || "x"}`);

        if (url.hostname === "geo.test") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ status: "success", countryCode: behaviour.exit, query: "1.1.1.1" }));
            return;
        }

        if (url.hostname === "lat.test") {
            calls += 1;

            const wait = typeof behaviour.delay === "function" ? behaviour.delay(calls) : behaviour.delay;

            await sleep(wait);

            if (behaviour.failEvery && calls % behaviour.failEvery === 0) {
                request.socket.destroy();
                return;
            }

            response.writeHead(204);
            response.end();
            return;
        }

        response.writeHead(404);
        response.end();
    };
}

async function fakeProxy(behaviour: Behaviour): Promise<string> {
    const originPort = await fakeOrigin(behaviour.rate ?? 50);
    const server = httpServer(handlerFor(behaviour));

    server.on("connect", (request, client: Socket, head) => {
        if (behaviour.noTunnel) {
            client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
        }

        const upstream = connect(originPort, "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection established\r\n\r\n");
            upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });

        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);

    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A SOCKS5 proxy (and SOCKS4 for an IPv4 target) with the same behaviours. It
 * ignores the name it is asked for and tunnels port 80 to this proxy's own
 * "internet" and port 443 to its speed origin, unless `noTunnel` (then it
 * refuses 443 with "connection not allowed").
 */
async function fakeSocks(behaviour: Behaviour, log: string[] = []): Promise<string> {
    const tlsPort = await fakeOrigin(behaviour.rate ?? 50);
    const plain = httpServer(handlerFor(behaviour));

    await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
    servers.push(plain);

    const plainPort = (plain.address() as AddressInfo).port;
    const server = createNet((sock) => {
        let buf = Buffer.alloc(0);
        let stage: "start" | "request" | "done" = "start";

        const tunnel = (host: string, port: number, version: 4 | 5): void => {
            stage = "done";
            log.push(`${host}:${port}`);

            const refuse = port === 443 && behaviour.noTunnel;
            const target = port === 443 ? tlsPort : port === 80 ? plainPort : port;

            if (refuse) {
                sock.end(version === 5 ? Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]) : Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]));
                return;
            }

            const up = connect(target, "127.0.0.1", () => {
                sock.write(version === 5 ? Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]) : Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
                if (buf.length) up.write(buf);
                sock.removeListener("data", onData);
                sock.pipe(up);
                up.pipe(sock);
            });

            up.on("error", () => sock.destroy());
            sock.on("error", () => up.destroy());
        };

        const onData = (chunk: Buffer): void => {
            buf = Buffer.concat([buf, chunk]);

            if (stage === "start") {
                if (buf[0] === 4) {
                    const end = buf.indexOf(0, 8);

                    if (buf.length < 9 || end < 0) return;

                    const port = buf.readUInt16BE(2);
                    const host = [...buf.subarray(4, 8)].join(".");

                    buf = buf.subarray(end + 1);
                    tunnel(host, port, 4);
                    return;
                }

                if (buf[0] !== 5 || buf.length < 2 || buf.length < 2 + (buf[1] as number)) return sock.destroy() as unknown as void;

                buf = buf.subarray(2 + (buf[1] as number));
                sock.write(Buffer.from([5, 0]));
                stage = "request";
            }

            if (stage === "request") {
                if (buf.length < 5) return;

                const kind = buf[3];
                const need = kind === 1 ? 10 : 7 + (buf[4] as number);

                if (buf.length < need) return;

                const host = kind === 1 ? [...buf.subarray(4, 8)].join(".") : buf.toString("utf8", 5, 5 + (buf[4] as number));
                const port = buf.readUInt16BE(need - 2);

                buf = buf.subarray(need);
                tunnel(host, port, 5);
            }
        };

        sock.on("data", onData);
        sock.on("error", () => undefined);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server as never);

    return `socks5://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const configure = (more: Record<string, unknown> = {}): void =>
    __test.reset(
        {
            latencyUrl: "http://lat.test/204",
            speedUrl: "https://speed.test/dl",
            geoUrls: ["http://geo.test/json"],
            probes: 5,
            minMbps: 3,
            minScore: 40,
            keep: 3,
            candidates: 20,
            concurrency: 8,
            budgetMs: 60_000,
            cacheFile: `${dir}/cache.json`,
            ...more
        },
        { rejectUnauthorized: false }
    );

/* ---- testing one candidate ------------------------------------------- */

configure();

const steady = await fakeProxy({ exit: "DE", delay: 40, rate: 40 });
const jittery = await fakeProxy({ exit: "DE", delay: (n) => (n % 2 ? 30 : 330), rate: 40 });
const wrongExit = await fakeProxy({ exit: "FR", delay: 40, rate: 40 });
const flaky = await fakeProxy({ exit: "DE", delay: 40, rate: 40, failEvery: 2 });
const noHttps = await fakeProxy({ exit: "DE", delay: 40, noTunnel: true });
const slow = await fakeProxy({ exit: "DE", delay: 40, rate: 1.5 });

const cfg = __test.settings();
const steadyVerdict = await __test.testProxy(steady, "DE", "t", cfg);

ok(steadyVerdict.ok, "a steady proxy passes");

if (steadyVerdict.ok) {
    const { info } = steadyVerdict;

    ok(info.latencyMs >= 35 && info.latencyMs < 200, `latency is measured (${info.latencyMs} ms for a 40 ms proxy)`);
    ok(info.jitterMs < 40, `a steady proxy has little jitter (${info.jitterMs} ms)`);
    ok(info.mbps > 10 && info.mbps < 120, `speed is measured over https (${info.mbps} Mbit/s for a 40 Mbit/s proxy)`);
    ok(info.https && info.successRate === 1 && info.country === "DE" && info.score > 70, "https, reliability, country, a good score");
}

const jitteryVerdict = await __test.testProxy(jittery, "DE", "t", cfg);

ok(jitteryVerdict.ok && steadyVerdict.ok && jitteryVerdict.info.jitterMs > 200, "jitter is measured");
ok(jitteryVerdict.ok && steadyVerdict.ok && jitteryVerdict.info.score < steadyVerdict.info.score, "a jittery proxy scores below a steady one");

const wrong = await __test.testProxy(wrongExit, "DE", "t", cfg);

ok(!wrong.ok && /exits in FR/.test(wrong.reason), "a proxy that exits in another country is rejected");

const unreliable = await __test.testProxy(flaky, "DE", "t", cfg);

ok(!unreliable.ok && /probes passed/.test(unreliable.reason), "a proxy that fails probes is rejected");

const tunnelless = await __test.testProxy(noHttps, "DE", "t", cfg);

ok(!tunnelless.ok && /https/.test(tunnelless.reason), "a proxy without CONNECT is rejected");

const sluggish = await __test.testProxy(slow, "DE", "t", cfg);

ok(!sluggish.ok && /slow/.test(sluggish.reason), "a proxy under the speed floor is rejected");

const dead = await __test.testProxy("http://127.0.0.1:1", "DE", "t", cfg);

ok(!dead.ok, "a dead address is rejected, not thrown");

/* ---- SOCKS proxies, tested the same way -------------------------------- */

const socksLog: string[] = [];
const socksGood = await fakeSocks({ exit: "DE", delay: 40, rate: 40 }, socksLog);
const socksJittery = await fakeSocks({ exit: "DE", delay: (n) => (n % 2 ? 30 : 330), rate: 40 });
const socksWrong = await fakeSocks({ exit: "FR", delay: 40, rate: 40 });
const socksNoTls = await fakeSocks({ exit: "DE", delay: 40, noTunnel: true });
const socksSlow = await fakeSocks({ exit: "DE", delay: 40, rate: 1.5 });
const socksVerdict = await __test.testProxy(socksGood, "DE", "t", cfg);

ok(socksVerdict.ok && socksVerdict.info.url === socksGood && socksVerdict.info.country === "DE" && socksVerdict.info.https, "a SOCKS5 proxy is tested and passes");
ok(socksVerdict.ok && socksVerdict.info.latencyMs >= 35 && socksVerdict.info.latencyMs < 200 && socksVerdict.info.mbps > 10, "its latency and HTTPS speed are measured through the tunnel");
ok(socksLog.includes("geo.test:80") && socksLog.includes("lat.test:80") && socksLog.includes("speed.test:443"), "names are sent to the SOCKS proxy, not looked up here");

const socksJit = await __test.testProxy(socksJittery, "DE", "t", cfg);

ok(socksJit.ok && socksVerdict.ok && socksJit.info.jitterMs > 200 && socksJit.info.score < socksVerdict.info.score, "SOCKS jitter is measured and costs score");

const socksOther = await __test.testProxy(socksWrong, "DE", "t", cfg);

ok(!socksOther.ok && /exits in FR/.test(socksOther.reason), "a SOCKS proxy that exits elsewhere is rejected");

const socksBlocked = await __test.testProxy(socksNoTls, "DE", "t", cfg);

ok(!socksBlocked.ok && /https/.test(socksBlocked.reason), "a SOCKS proxy that will not tunnel to 443 is rejected");

const socksTooSlow = await __test.testProxy(socksSlow, "DE", "t", cfg);

ok(!socksTooSlow.ok && /slow/.test(socksTooSlow.reason), "a slow SOCKS proxy is rejected");
ok(!(await __test.testProxy("socks5://127.0.0.1:1", "DE", "t", cfg)).ok, "a dead SOCKS address is rejected, not thrown");

/* SOCKS4 takes an IPv4 target, so it is exercised on `through` directly. */
const four = httpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("hello");
});

await new Promise<void>((resolve) => four.listen(0, "127.0.0.1", resolve));
servers.push(four);

const fourLog: string[] = [];
const socks4Proxy = (await fakeSocks({ exit: "DE", delay: 1 }, fourLog)).replace("socks5:", "socks4:");
const fourGot = await __test.through(socks4Proxy, `http://127.0.0.1:${(four.address() as AddressInfo).port}/x`, 5000);

ok(fourGot.status === 200 && fourGot.head === "hello" && fourLog[0] === `127.0.0.1:${(four.address() as AddressInfo).port}`, "SOCKS4 works for an IPv4 target");

/* ---- refreshing a country, picking, feedback -------------------------- */

const list = createServerForLists();

const hits: Record<string, number> = {};

function createServerForLists(): ReturnType<typeof httpServer> {
    const lists: Record<string, string[]> = {};
    const server = httpServer((request, response) => {
        const country = (request.url || "").split("/").pop() || "";

        hits[country] = (hits[country] || 0) + 1;

        response.writeHead(lists[country] ? 200 : 404);
        response.end((lists[country] || []).join("\n"));
    });

    (server as unknown as { lists: typeof lists }).lists = lists;
    return server;
}

await new Promise<void>((resolve) => list.listen(0, "127.0.0.1", resolve));
servers.push(list);

const lists = (list as unknown as { lists: Record<string, string[]> }).lists;
const listPort = (list.address() as AddressInfo).port;
const sources = {
    perCountry: [
        {
            name: "fake",
            url: (country: string) => `http://127.0.0.1:${listPort}/${country}`,
            parse: (body: string, country: string) => __test.parseList(body).map((url) => ({ url, country }))
        }
    ],
    world: [],
    index: "",
    geoBatch: "",
    geoPauseMs: 0
};

const medium = await fakeProxy({ exit: "DE", delay: 400, rate: 8 });
const best = await fakeProxy({ exit: "DE", delay: 20, rate: 60 });
const second = await fakeProxy({ exit: "DE", delay: 120, rate: 25 });
const spain = await fakeProxy({ exit: "ES", delay: 60, rate: 30 });

const socksBest = await fakeSocks({ exit: "DE", delay: 10, rate: 80 });

lists.DE = [medium, jittery, wrongExit, flaky, noHttps, slow, "socks5://9.9.9.9:1080", "http://127.0.0.1:1", best, second, steady, socksBest, socksNoTls, socksSlow].map((entry) => entry.replace("http://", ""));
lists.ES = [spain.replace("http://", ""), wrongExit.replace("http://", "")];

configure({ sources });

const provider = proxyPoolScraper.proxies;

ok(provider, "the scraper exports a proxy provider");

await __test.refreshOne("DE", 60_000);

const german = await provider!.pick("de");

ok(german.length === 3, `at most keepPerCountry are kept (${german.length})`);
ok(german.includes(socksBest) && german.slice(0, 2).includes(best) && german.slice(0, 2).includes(socksBest), "the best proxies lead, whatever their protocol (a SOCKS5 and an HTTP one tie at the top)");
ok(german[2] === second || german[2] === steady, "then the next best");

const all = (await provider!.list()).filter((entry) => entry.country === "DE");

ok(all.every((entry, index) => index === 0 || (all[index - 1] as { score: number }).score >= entry.score), "list() is best first");
ok(![wrongExit, flaky, noHttps, slow, "http://127.0.0.1:1", socksNoTls, socksSlow].some((bad) => german.includes(bad)), "rejected proxies are not kept");
ok(all.every((entry) => entry.score >= 40 && entry.https && entry.mbps >= 3), "every kept proxy meets the floors");

/* feedback */
const top = german[0] as string;

provider!.report(top, false);

const afterOne = (await provider!.list()).find((entry) => entry.url === top);

ok(afterOne && afterOne.failures === 1, "one failure is recorded");

const scoreBefore = all.find((entry) => entry.url === top)?.score ?? 0;

ok(afterOne && afterOne.score === Math.max(0, scoreBefore - 15), "a failure costs 15 points");

provider!.report(top, true);
ok((await provider!.list()).find((entry) => entry.url === top)?.failures === 0, "a success clears the failures");

provider!.report(top, false);
provider!.report(top, false);
ok(!(await provider!.pick("DE")).includes(top), "two failures in a row remove the proxy");

/* another country, built on first use */
ok(!(await provider!.list()).some((entry) => entry.country === "ES"), "ES is not held yet");
ok(JSON.stringify(await provider!.pick("ES")) === JSON.stringify([spain]), "a country nobody refreshed is built on first pick, and only exits there");
ok(JSON.stringify(await provider!.pick("ZZ")) === "[]", "a country with no list answers nothing");
ok(JSON.stringify(await provider!.pick("nonsense")) === "[]", "a bad code answers nothing");

/* single flight */
await Promise.all([provider!.pick("PT"), provider!.pick("PT")]);

/* the cache */
ok(existsSync(`${dir}/cache.json`), "the pool is written to its cache file");
__test.unload();
ok((await provider!.list()).some((entry) => entry.country === "ES"), "a restart reads the cache back");


/* ---- the parsers, on the shapes the real lists have ------------------- */

ok(
    JSON.stringify(__test.parseSpys("Proxy list (#400)\n\nIP address:Port CountryCode-Anonymity(Noa/Anm/Hia)-SSL_support(S)-Google_passed(+)\n\n1.9.88.46:8088 MY-N - \n200.69.92.239:999 CO-N! - \nbad line\n300.1.1.1:80 US-N - ")) ===
        JSON.stringify([{ url: "http://1.9.88.46:8088", country: "MY" }, { url: "http://200.69.92.239:999", country: "CO" }]),
    "spys.me lines give an address and a country"
);
ok(
    JSON.stringify(__test.parseTable('<tr><td>8.8.4.4</td><td>3128</td><td>US</td><td>United States</td><td>anonymous</td></tr><tr><td>9.9</td><td>1</td><td>DE</td></tr><tr><td>5.5.5.5</td><td>80</td><td>de</td>')) ===
        JSON.stringify([{ url: "http://8.8.4.4:3128", country: "US" }]),
    "the free-proxy-list table is scraped, malformed rows are skipped"
);
ok(
    JSON.stringify(__test.parseMonosans(JSON.stringify([
        { protocol: "http", host: "1.2.3.4", port: 80, username: null, geolocation: { country: { iso_code: "DE" } } },
        { protocol: "socks5", host: "1.2.3.5", port: 80, username: null, geolocation: { country: { iso_code: "DE" } } },
        { protocol: "http", host: "1.2.3.6", port: 80, username: "u", geolocation: { country: { iso_code: "DE" } } },
        { protocol: "http", host: "1.2.3.7", port: 80, username: null }
    ]))) === JSON.stringify([{ url: "http://1.2.3.4:80", country: "DE" }, { url: "socks5://1.2.3.5:80", country: "DE" }, { url: "http://1.2.3.7:80", country: undefined }]),
    "monosans json: http and SOCKS, no credentials, country when it has one"
);
ok(
    JSON.stringify(__test.parseThordata(JSON.stringify([{ ip: "4.4.4.4", port: 8080, type: "http", country_code: "us" }, { ip: "4.4.4.5", port: 8080, type: "socks5", country_code: "US" }]))) ===
        JSON.stringify([{ url: "http://4.4.4.4:8080", country: "US" }, { url: "socks5://4.4.4.5:8080", country: "US" }]),
    "thordata json"
);
ok(
    JSON.stringify(__test.parseGeonode(JSON.stringify({ data: [{ ip: "6.6.6.6", port: "3128", country: "DE", protocols: ["http"] }, { ip: "6.6.6.7", port: "1080", country: "DE", protocols: ["socks5"] }] }), "DE")) ===
        JSON.stringify([{ url: "http://6.6.6.6:3128", country: "DE" }, { url: "socks5://6.6.6.7:1080", country: "DE" }]),
    "geonode json keeps http and SOCKS entries"
);
ok(
    JSON.stringify(__test.parseList("1.1.1.1:1080\nsocks4://2.2.2.2:1080\nsocks5h://3.3.3.3:1080\nsocks4a://4.4.4.4:1080\nSOCKS5://5.5.5.5:1080", "socks5")) ===
        JSON.stringify(["socks5://1.1.1.1:1080", "socks4://2.2.2.2:1080", "socks5://3.3.3.3:1080", "socks4://4.4.4.4:1080", "socks5://5.5.5.5:1080"]),
    "a bare address gets the list's own protocol; a scheme on the line wins; socks5h and socks4a are SOCKS5 and SOCKS4"
);
ok(__test.parseList("36.66.121.131:8080:Indonesia\n91.211.212.6:32650:Greece").length === 2, "an ip:port:Country line is a proxy");
ok(JSON.stringify(__test.parseList("078.084.001.060:5328")) === JSON.stringify(["http://78.84.1.60:5328"]), "leading zeros in an address are dropped, not a throw later");
ok(__test.parseList("not json at all") .length === 0 && __test.parseMonosans("not json").length === 0 && __test.parseGeonode("<html>", "DE").length === 0, "garbage gives nothing, not a throw");

ok(!__test.publicUrl("http://127.0.0.1/x") && !__test.publicUrl("http://localhost/x") && !__test.publicUrl("http://10.0.0.5/x") && !__test.publicUrl("http://192.168.1.1/x") && !__test.publicUrl("http://169.254.169.254/x") && !__test.publicUrl("http://172.20.0.1/x") && !__test.publicUrl("http://[::1]/x") && !__test.publicUrl("file:///etc/passwd"), "discovered lists may not aim inward");
ok(__test.publicUrl("https://raw.githubusercontent.com/a/b/main/http.txt") && __test.publicUrl("http://8.8.8.8/x"), "public lists are fine");

/* ---- gathering from every kind of source ------------------------------ */

const geoLog: string[][] = [];
const hub = httpServer((request, response) => {
    const path = request.url || "";
    const send = (status: number, body: string): void => {
        response.writeHead(status);
        response.end(body);
    };

    if (request.method === "POST" && path.startsWith("/batch")) {
        let body = "";

        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            const ips = JSON.parse(body) as string[];
            const countries: Record<string, string> = { "20.0.0.1": "DE", "20.0.0.2": "DE", "20.0.0.3": "FR", "20.0.0.4": "DE" };

            geoLog.push(ips);
            send(200, JSON.stringify(ips.map((query) => ({ query, countryCode: countries[query] || "ZZ" }))));
        });
        return;
    }

    if (path === "/country/DE") return send(200, "30.0.0.1:80\n30.0.0.2:80\nsocks5://30.0.0.9:1080");
    if (path === "/spys") return send(200, "30.0.0.3:80 DE-N - \n30.0.0.4:80 FR-N - ");
    if (path === "/table") return send(200, "<tr><td>30.0.0.5</td><td>8080</td><td>DE</td><td>x</td></tr>");
    if (path === "/plain") return send(200, "20.0.0.1:80\n20.0.0.2:80\n20.0.0.3:80\n30.0.0.1:80");
    if (path === "/found") return send(200, "20.0.0.4:3128\n");
    if (path === "/index") return send(200, `http://127.0.0.1:${hubPort}/found\nhttp://127.0.0.1:${hubPort}/missing\nfile:///etc/passwd\n`);
    send(404, "");
});

await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
servers.push(hub);

const hubPort = (hub.address() as AddressInfo).port;
const hubSources = (more: Record<string, unknown> = {}): typeof sources => ({
    perCountry: [{ name: "pc", url: (country: string) => `http://127.0.0.1:${hubPort}/country/${country}`, parse: (body: string, country: string) => __test.parseList(body).map((url) => ({ url, country })) }],
    world: [
        { name: "spys", url: `http://127.0.0.1:${hubPort}/spys`, parse: __test.parseSpys },
        { name: "table", url: `http://127.0.0.1:${hubPort}/table`, parse: __test.parseTable },
        { name: "plain", url: `http://127.0.0.1:${hubPort}/plain`, parse: (body: string) => __test.parseList(body).map((url) => ({ url })) }
    ],
    index: "",
    geoBatch: `http://127.0.0.1:${hubPort}/batch`,
    geoPauseMs: 0,
    ...more
});

configure({ sources: hubSources(), geolocate: 1000 });

const gathered = await __test.gather(["DE", "FR"], __test.settings(), Date.now() + 30_000);
const urlsOf = (country: string): string[] => (gathered.get(country) || []).map((entry) => entry.url).sort();

ok(
    JSON.stringify(urlsOf("DE")) ===
        JSON.stringify(["http://20.0.0.1:80", "http://20.0.0.2:80", "http://30.0.0.1:80", "http://30.0.0.2:80", "http://30.0.0.3:80", "http://30.0.0.5:8080", "socks5://30.0.0.9:1080"]),
    `DE gathers per-country, labeled world and geolocated entries, deduplicated (${urlsOf("DE")})`
);
ok(JSON.stringify(urlsOf("FR")) === JSON.stringify(["http://20.0.0.3:80", "http://30.0.0.4:80"]), "FR gets its labeled and its geolocated entry");
ok((gathered.get("DE") || []).find((entry) => entry.url === "http://30.0.0.1:80")?.source === "pc", "the first list to name a proxy is credited");
ok(geoLog.length === 1 && !geoLog[0]!.includes("30.0.0.3") && !geoLog[0]!.includes("30.0.0.1"), "only addresses no list labelled are geolocated");

configure({ sources: hubSources(), geolocate: 1000, protocols: ["http"] });
ok(!(await __test.gather(["DE"], __test.settings(), Date.now() + 30_000)).get("DE")!.some((entry) => entry.url.startsWith("socks5:")), "the protocols setting leaves SOCKS candidates out");

configure({ sources: hubSources(), geolocate: 0 });
const noGeo = await __test.gather(["DE"], __test.settings(), Date.now() + 30_000);

ok(!(noGeo.get("DE") || []).some((entry) => entry.url.startsWith("http://20.")), "geolocate 0 skips unlabeled lists");

configure({ sources: hubSources({ index: `http://127.0.0.1:${hubPort}/index` }), geolocate: 1000 });
ok(!(await __test.gather(["DE"], __test.settings(), Date.now() + 30_000)).get("DE")!.some((entry) => entry.url === "http://20.0.0.4:3128"), "a discovered list on a private address is not fetched");

configure({ sources: hubSources({ index: `http://127.0.0.1:${hubPort}/index`, indexAllowsPrivate: true }), geolocate: 1000 });
ok((await __test.gather(["DE"], __test.settings(), Date.now() + 30_000)).get("DE")!.some((entry) => entry.url === "http://20.0.0.4:3128"), "a discovered public list is fetched and its entries used (file:// and 404s ignored)");

configure({ sources: hubSources({ geoBatch: "http://127.0.0.1:1/none" }), geolocate: 1000 });
ok((await __test.gather(["DE"], __test.settings(), Date.now() + 30_000)).get("DE")!.length === 5, "a geolocation service that is down costs only the unlabeled entries");

configure({ sources: hubSources(), geolocate: 1000, extraLists: [`http://127.0.0.1:${hubPort}/found`] });
ok((await __test.gather(["DE"], __test.settings(), Date.now() + 30_000)).get("DE")!.some((entry) => entry.url === "http://20.0.0.4:3128"), "an extra list URL from the settings is read");

configure({ sources: { ...hubSources(), perCountry: [], world: [{ name: "late", url: `http://127.0.0.1:${hubPort}/spys`, parse: __test.parseSpys }] } });
ok((await __test.gather(["DE"], __test.settings(), Date.now() - 1)).get("DE")!.length === 0, "past its deadline a gather fetches nothing");

/* ---- the two passes: held proxies first, lists only for a country that needs them ---- */

configure({ sources, keep: 2, countries: ["DE", "ES"] });
await __test.refreshOne("DE", 60_000);

const deGood = (await provider!.list()).filter((entry) => entry.country === "DE" && entry.score >= 70).length;

ok(deGood >= 2, `DE holds at least two good proxies for the pass test (${deGood})`);

for (const key of Object.keys(hits)) delete hits[key];

await __test.refreshAll();

ok(!hits.DE, `a country whose held proxies still pass is finished: its list was not read (${hits.DE || 0} reads)`);
ok((hits.ES || 0) >= 1, "a country with too few good proxies has its list read");
ok((await provider!.list()).filter((entry) => entry.country === "DE").length >= 2, "and the country that was skipped keeps its re-tested proxies");

/* a held proxy that died is not kept, and the country becomes needy */
const heldDe = (await provider!.list()).filter((entry) => entry.country === "DE");

lists.DE = [];
for (const key of Object.keys(hits)) delete hits[key];
configure({ sources, keep: 2, countries: ["DE"] });
__test.unload();
await __test.refreshAll();
ok(heldDe.length >= 2 && (await provider!.list()).filter((entry) => entry.country === "DE").length >= 2 && !hits.DE, "re-testing alone keeps a healthy country whatever its list says");

/* ---- the sources added for countries with few free proxies ----------- */

const freeOnly = __test.parseProxyFreeOnly(JSON.stringify([
    { ip: "89.28.239.39", port: "10808", country: "GB", protocols: ["socks5"] },
    { ip: "82.9.133.51", port: "8080", country: "GB", protocols: ["http", "https", "socks4"] },
    { ip: "bad", port: "1", country: "GB", protocols: ["http"] },
    { ip: "5.5.5.5", port: "70000", country: "GB", protocols: ["http"] }
]), "GB");

ok(JSON.stringify(freeOnly.map((entry) => entry.url)) === JSON.stringify(["socks5://89.28.239.39:10808", "http://82.9.133.51:8080", "http://82.9.133.51:8080", "socks4://82.9.133.51:8080"]) && freeOnly.every((entry) => entry.country === "GB"), "proxyfreeonly: one entry per protocol, https as http, bad rows dropped, country kept");
ok(__test.parseProxyFreeOnly("<html>", "GB").length === 0, "proxyfreeonly: garbage gives nothing");

const fine = __test.parseFineproxy(
    '<tbody><tr class="fpb-row fpb-prow"><td class="col-ip"><div class="fpb-prow-title">PREMIUM</div></td></tr>' +
        '<tr class="fpb-row"><td class="col-ip"><div class="fpb-ip">164.38.155.10<span class="fpb-ip-port">:80</span></div></td><td><div class="fpb-protos"><span class="fpb-proto on">HTTP</span><span class="fpb-proto off">HTTPS</span><span class="fpb-proto on">SOCKS5</span></div></td></tr>' +
        '<tr class="fpb-row"><td class="col-ip"><div class="fpb-ip">1.2.3.4<span class="fpb-ip-port">:1080</span></div></td><td><span class="fpb-proto off">HTTP</span></td></tr></tbody>',
    "GB"
);

ok(JSON.stringify(fine.map((entry) => entry.url)) === JSON.stringify(["http://164.38.155.10:80", "socks5://164.38.155.10:80"]), "fineproxy: only the protocols a row has switched on, no premium row, no row with none");
ok(__test.fineproxyUrl("GB") === "https://fineproxy.org/free-proxies/europe/united-kingdom/" && __test.fineproxyUrl("US") === "https://fineproxy.org/free-proxies/north-america/united-states/" && __test.fineproxyUrl("ZZ") === "", "fineproxy: its page is filed by region and country name, and a country it does not know has none");

const hubRows = __test.parseProxyHub(
    '<td class="ip-cell"><span class="ip-text" title="31.59.20.249">31.59.20.249</span></td><td class="port-cell"><span class="port-text">6827</span></td>' +
        '<td class="ip-cell"><span class="ip-text" title="9.9.9.9">9.9.9.9</span></td><td class="port-cell"><span class="port-text">3128</span></td>',
    "GB",
    "socks5"
);

ok(JSON.stringify(hubRows.map((entry) => entry.url)) === JSON.stringify(["socks5://31.59.20.249:6827", "socks5://9.9.9.9:3128"]), "proxyhub: ip and port cells, the page's protocol");

/* a rebuild drops what died */
configure({ sources });
ok((await provider!.pick("ES")).length === 1, "ES is held before everything goes away");
servers.forEach((server) => server.close());
await sleep(50);
await __test.refreshOne("ES", 20_000);
ok((await provider!.list()).every((entry) => entry.country !== "ES"), "a completed rebuild that finds nothing empties the country");

console.log(`proxy-pool: ${checks} checks ok`);
process.exit(0);
