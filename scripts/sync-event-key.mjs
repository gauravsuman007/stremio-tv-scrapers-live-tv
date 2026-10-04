// Keeps the one event-identity block identical in every scraper that lists live events.
// `node scripts/sync-event-key.mjs` rewrites the copies; `--check` fails if any differ (CI).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const block = readFileSync(new URL("./event-key.block.ts", import.meta.url), "utf8").trim();
/* Every scraper that carries the block: a new events scraper opts in by adding the BEGIN/END markers. */
const files = [
    ...readdirSync(new URL("../scrapers/", import.meta.url))
        .filter((name) => name.endsWith(".mts"))
        .map((name) => new URL(`../scrapers/${name}`, import.meta.url)),
    new URL("../template/scraper-template.mts", import.meta.url)
].filter((file) => readFileSync(file, "utf8").includes("// BEGIN event-key"));
const pattern = /\/\/ BEGIN event-key[\s\S]*?\/\/ END event-key/;
let stale = 0;

for (const file of files) {
    const source = readFileSync(file, "utf8");

    const next = source.replace(pattern, () => block);

    if (next !== source) {
        stale += 1;
        if (process.argv.includes("--check")) console.error(`${file.pathname}: event-key block differs`);
        else writeFileSync(file, next);
    }
}

if (stale && process.argv.includes("--check")) process.exit(1);
console.log(stale ? `synced ${stale}` : "event-key blocks identical");
