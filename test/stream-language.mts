/*
    THE STREAM LANGUAGE (scripts/stream-language.block.ts): what a mirror's
    language field or broadcaster name says, as an ISO code, or "" when it
    does not say. Names are real daddylive ones. Run with `npm test`.
*/
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const block = readFileSync(new URL("../scripts/stream-language.block.ts", import.meta.url), "utf8");
const file = `${mkdtempSync(`${tmpdir()}/stream-language-`)}/block.mts`;

writeFileSync(file, `${block}\nexport { languageOf };\n`);

const { languageOf } = (await import(file)) as { languageOf: (...texts: Array<string | undefined>) => string };

let checks = 0;
const is = (texts: Array<string | undefined>, expected: string) => {
    assert.strictEqual(languageOf(...texts), expected, JSON.stringify(texts));
    checks += 1;
};

is(["Sky Sport Uno IT"], "it");
is(["DAZN2 DE"], "de");
is(["TF1 France"], "fr");
is(["TNT Sports 1 UK"], "en");
is(["Fox Sports 2 USA"], "en");
is(["Sport TV2 Portugal"], "pt");
is(["beIN Sports MENA English 1"], "en");
is(["beIN Sports MENA 1"], "ar");
is(["Sport 2 Israel"], "he");
is(["Polsat Sport 2 Poland"], "pl");
is(["Cytavision Sports 4 Cyprus"], "el");
is(["English"], "en");
is(["Hindi"], "hi");
is(["Deutsch"], "de");
is(["EN"], "en");
is(["de"], "de");
is(["pt-BR"], "pt");
is(["", "Hindi commentary"], "hi");
// Not said, or not one language: stays unknown.
is(["Event SD Stream"], "");
is(["DAZN CA"], "");
is(["Fox Soccer Plus"], "");
is(["V Sport Premium"], "");
is(["Telemundo it"], "");
is(["Canal+ Belgium"], "");
is(["SuperSport Premier League"], "");
is([undefined, ""], "");

console.log(`stream-language: ${checks} checks ok`);
