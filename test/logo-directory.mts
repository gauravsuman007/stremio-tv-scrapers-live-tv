// The shared logo-directory block: borrow by name+country, then by a name with one logo; never overwrite a live logo.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const block = readFileSync(new URL("../scripts/logo-directory.block.ts", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "logo-dir-"));
const file = join(dir, "block.mts");
writeFileSync(file, `${block}\nexport { fillLogos };\n`);

const channels = [
    { id: "BBCOne.uk", name: "BBC One", alt_names: ["BBC 1"], country: "GB" },
    { id: "Sport.de", name: "Sky Sport Bundesliga", alt_names: [], country: "DE" },
    { id: "A.us", name: "Dupe Channel", alt_names: [], country: "US" },
    { id: "A.ca", name: "Dupe Channel", alt_names: [], country: "CA" }
];
const logos = [
    { channel: "BBCOne.uk", url: "https://x/bbc.svg", width: 900, format: "SVG" },
    { channel: "BBCOne.uk", url: "https://x/bbc.png", width: 500, format: "PNG" },
    { channel: "Sport.de", url: "https://x/sky.png", width: 300, format: "PNG" },
    { channel: "A.us", url: "https://x/a-us.png", width: 300, format: "PNG" },
    { channel: "A.ca", url: "https://x/a-ca.png", width: 300, format: "PNG" }
];
let asked = 0;
globalThis.fetch = (async (url: string) => {
    asked += 1;
    const body = String(url).endsWith("channels.json") ? channels : logos;
    return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const { fillLogos } = (await import(pathToFileURL(file).href)) as { fillLogos: (c: Array<{ name: string; country: string; logo: string }>, dead?: (l: string) => boolean) => Promise<number> };

const row = (name: string, country: string, logo = "") => ({ name, country, logo });
const list = [
    row("BBC ONE HD", "GB"), /* folded, raster preferred over the vector */
    row("BBC 1", "UK"), /* alternate name, UK spelled the old way */
    row("Sky Sport Bundesliga 8", "DE"), /* no exact name: not borrowed */
    row("Sky Sport Bundesliga", ""), /* no country, one logo for the name */
    row("Dupe Channel", ""), /* two logos for one name: refused */
    row("Dupe Channel", "US"), /* but its own country is exact */
    row("BBC One", "GB", "https://own/live.png"), /* a logo it has is kept */
    row("BBC One", "GB", "https://dead.host/x.png"), /* unless its host is dead */
    row("Unknown Thing", "GB")
];

const filled = await fillLogos(list, (logo) => logo.includes("dead.host"));

assert.equal(list[0]?.logo, "https://x/bbc.png");
assert.equal(list[1]?.logo, "https://x/bbc.png");
assert.equal(list[2]?.logo, "");
assert.equal(list[3]?.logo, "https://x/sky.png");
assert.equal(list[4]?.logo, "");
assert.equal(list[5]?.logo, "https://x/a-us.png");
assert.equal(list[6]?.logo, "https://own/live.png");
assert.equal(list[7]?.logo, "https://x/bbc.png");
assert.equal(list[8]?.logo, "");
assert.equal(filled, 5);
await fillLogos([row("BBC One", "GB")]);
assert.equal(asked, 2, "the directory is fetched once");

globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
console.log("logo-directory: ok");
