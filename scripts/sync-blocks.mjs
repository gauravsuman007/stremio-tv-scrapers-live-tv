// Keeps each shared block identical in every scraper that carries it.
// `node scripts/sync-blocks.mjs` rewrites the copies; `--check` fails if any differ (CI).
// A scraper opts in by holding the block's `// BEGIN <name>` ... `// END <name>` markers.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const BLOCKS = ["event-key", "logo-directory", "stream-language"];
let stale = 0;

for (const name of BLOCKS) {
    const block = readFileSync(new URL(`./${name}.block.ts`, import.meta.url), "utf8").trim();
    const files = [
        ...readdirSync(new URL("../scrapers/", import.meta.url))
            .filter((file) => file.endsWith(".mts"))
            .map((file) => new URL(`../scrapers/${file}`, import.meta.url)),
        new URL("../template/scraper-template.mts", import.meta.url)
    ].filter((file) => readFileSync(file, "utf8").includes(`// BEGIN ${name}`));
    const pattern = new RegExp(`// BEGIN ${name}[\\s\\S]*?// END ${name}`);

    for (const file of files) {
        const source = readFileSync(file, "utf8");
        const next = source.replace(pattern, () => block);

        if (next !== source) {
            stale += 1;
            if (process.argv.includes("--check")) console.error(`${file.pathname}: ${name} block differs`);
            else writeFileSync(file, next);
        }
    }
}

if (stale && process.argv.includes("--check")) process.exit(1);
console.log(stale ? `synced ${stale}` : "shared blocks identical");
