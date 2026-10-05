/*
    ZLIVE: THE PROMISES THAT KEEP THE DECOY AWAY, against a fake of the site.

    zlive answers a request it does not like with a 200 and a well-formed address to a
    LIVE-looking "scrapers go away" card. So: every API call carries `Origin`; the v5
    envelope really opens with the documented key schedule; an address of the decoy's
    shape (or whose first segment is the card's) is never handed out; the events
    feed is read with the field names the real feed uses. Run with `npm test`.
*/
import assert from "node:assert";
import { createDecipheriv, createHash, createHmac } from "node:crypto";

import { zliveScraper } from "../scrapers/zlive.mts";

let checks = 0;
const ok = (value: unknown, said: string): void => {
    assert.ok(value, said);
    checks += 1;
};

const SALT_V5 = "-eIt_LM4sZrw0-ZofDPQCqfznTuQIS9vmgIxT8vlOzQ";
const REAL = "https://cdn.example/main/secure/aa/1/chan.m3u8";
const DECOY = "https://iptv.zlive.st/main/secure/bb/1/0123456789ab.m3u8";
const OTHER_DECOY = "https://elsewhere.example/card.m3u8";
const live = (segment: string): string => `#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:8,\n${segment}\n#EXTINF:8,\n${segment}\n`;

let mode: "good" | "alwaysDecoy" | "cardAtOtherHost" = "good";
let missingOrigin = 0;
let decrypted: unknown = null;
const ticket = "TICKET-abcdefghijklmn";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : (input as Request).url);
    const headers = new Headers(init?.headers);
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

    if (url.startsWith("https://iptv.zlive.st/")) {
        const path = new URL(url).pathname;
        if (!path.startsWith("/main/") && !headers.get("origin")) missingOrigin += 1;
        if (url === DECOY) return new Response(live("https://route.example/card?data=1"));

        if (path === "/session/ticket") return json({ w: ticket });
        if (path === "/nonce") return new Response("no", { status: 404 });
        if (path === "/channels.json") return json([{ id: "cn", name: "Cartoon Network UK", flag: "gb", sport: "Kids", sources: [{ key: "cn-uk", label: "Primary" }] }]);

        if (path === "/streams" || path === "/resolve") {
            const body = JSON.parse(String(init?.body)) as Record<string, string>;
            const date = new Date().toISOString().slice(0, 10);
            const hmacKey = createHash("sha256").update(`${SALT_V5}:${date}`).digest();
            const aes = createHmac("sha256", hmacKey).update(`${ticket}|v5`).digest();
            let opened: unknown = null;
            try {
                const decipher = createDecipheriv("aes-256-gcm", aes, Buffer.from(body.r ?? "", "base64"));
                decipher.setAAD(Buffer.from(ticket));
                decipher.setAuthTag(Buffer.from(body.u ?? "", "base64"));
                opened = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body.m ?? "", "base64")), decipher.final()]).toString());
            } catch {
                /* a wrong envelope opens to nothing */
            }
            decrypted = opened;

            if (path === "/streams") {
                return json([
                    { id: "turkey-italy-tr", name: "Turkey @ Italy TR Commentary 4K", type: "Soccer", startTime: "2026-10-05T17:09:13.317Z", live: true, source: { key: "turkey-italy-tr", label: "Primary" } }
                ]);
            }

            if (!opened || !headers.get("origin")) return json({ location: DECOY });
            return json({ location: mode === "alwaysDecoy" ? DECOY : mode === "cardAtOtherHost" ? OTHER_DECOY : REAL });
        }
    }

    if (url === REAL) return new Response(live("https://cdn.example/seg/real.ts"));
    if (url === DECOY) return new Response(live("https://route.example/card?data=1"));
    if (url === OTHER_DECOY) return new Response(live("https://route.example/card?data=2"));
    if (url.startsWith("https://route.example/card")) return new Response(new Uint8Array(500).fill(7));
    if (url.startsWith("https://cdn.example/seg/")) return new Response(new Uint8Array(900).fill(1));

    throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const resolve = zliveScraper.resolvers!.zlive!;
const handle = "https://zlive.invalid/cn-uk";

// 1. The real address comes back, the v5 envelope opened with the documented key schedule, Origin on every API call.
let resolved = await resolve(handle, undefined);
ok(resolved?.url === REAL, "the real address is handed out");
ok(JSON.stringify(decrypted)?.includes('"s":"cn-uk"'), "the v5 envelope opens to {s, u} under HMAC(SHA-256(salt:date), ticket|v5) with the ticket as AAD");
ok(missingOrigin === 0, `every API call carries Origin (${missingOrigin} did not)`);

// 2. The events feed: real field names, broadcast tags stripped, start in ms.
const events = await zliveScraper.buildEvents!();
const turkey = events.channels[0];
ok(events.channels.length === 1, "the feed's event is read (source/type/startTime)");
ok(turkey?.name === "Turkey vs Italy", `broadcast tags are stripped from the name (${turkey?.name})`);
ok(turkey?.event?.start === Date.parse("2026-10-05T17:09:13.317Z"), "the start is epoch milliseconds");
ok(turkey?.streams[0]?.url === "https://zlive.invalid/turkey-italy-tr", "the event stream is a zlive handle");
ok(missingOrigin === 0, "the events call carries Origin too");

// 3. The decoy's address shape is never handed out, even though its playlist is live and endless.
mode = "alwaysDecoy";
resolved = await resolve(handle, undefined);
ok(resolved === null, "an address of the decoy's shape is refused");

// 4. The card behind an address of another shape is recognised by its bytes (learned from the step above).
mode = "cardAtOtherHost";
resolved = await resolve(handle, undefined);
ok(resolved === null, "the card's segment is recognised behind an unknown address");

globalThis.fetch = realFetch;
console.log(`zlive: ${checks} checks ok`);
