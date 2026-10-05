/*
    THE EVENT KEY (scripts/event-key.block.ts): equal for two sources' cards of
    one event, different for anything that is not. Real names from the sources.
    Run with `npm test`.
*/
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const block = readFileSync(new URL("../scripts/event-key.block.ts", import.meta.url), "utf8");
const dir = mkdtempSync(`${tmpdir()}/event-key-`);
const file = `${dir}/block.mts`;

writeFileSync(file, `interface ScrapedEvent { key?: string; keys?: string[]; sides?: string[]; title?: string; competition?: string; sport?: string; start?: number }\n${block}\nexport { eventFor, readFixture, teamKey };\n`);

const { eventFor, readFixture } = (await import(file)) as {
    eventFor: (title: string, extra?: { sides?: string[]; start?: number }) => { name: string; event: { key?: string; keys?: string[]; competition?: string; sides?: string[] } };
    readFixture: (raw: string) => { sides: string[]; competition: string } | null;
};

let checks = 0;
const ok = (value: unknown, said: string) => {
    assert.ok(value, said);
    checks += 1;
};
const key = (name: string) => eventFor(name).event.key;
const allKeys = (name: string) => {
    const { event } = eventFor(name);

    return new Set([event.key, ...(event.keys || [])].filter(Boolean));
};
/* Two cards are one event when ANY of their keys is shared -- what the host does. */
const same = (a: string, b: string) => [...allKeys(a)].some((held) => allKeys(b).has(held));
const FLAG = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";

/* a source's typo is an alias (RoxieStreams: "Wales vs Denamrk") */
ok(same("Wales vs Denamrk", "Wales vs Denmark"), "a misspelt Denmark merges");
/* TimStreams writes "away @ home", and an American side by its nickname alone */
ok(same("Norway @ Portugal", "Portugal vs Norway"), "'@' is a versus");
const keysIn = (sport: string, name: string) => {
    const { event } = eventFor(name, { sport } as never);

    return new Set([event.key, ...(event.keys || [])].filter(Boolean));
};
const sameIn = (sport: string, a: string, b: string) => [...keysIn(sport, a)].some((held) => keysIn(sport, b).has(held));
ok(sameIn("american football", "Chiefs @ Raiders", "Las Vegas Raiders vs Kansas City Chiefs"), "NFL nicknames merge with full names");
ok(sameIn("baseball", "Padres @ Brewers", "Milwaukee Brewers vs San Diego Padres"), "MLB nicknames merge with full names");
ok(sameIn("hockey", "Golden Knights @ Canucks", "Vegas Golden Knights vs Vancouver Canucks"), "NHL nicknames merge with full names");
ok(!sameIn("american football", "Chiefs @ Raiders", "Chiefs @ Broncos"), "a shared nickname is not a shared fixture");
ok(!sameIn("american football", "Giants @ Eagles", "San Francisco Giants vs Philadelphia Phillies"), "the nickname Giants is the sport's own team");
ok(sameIn("baseball", "Giants @ Padres", "San Francisco Giants vs San Diego Padres"), "Giants are San Francisco in baseball");
ok(same("Cyprus x Latvia", "Latvia vs Cyprus"), "the Portuguese-style \"x\" is a versus");
ok(same("Italy x Turkey", "Türkiye @ Italy"), "x merges with a source that writes Türkiye");
ok(!same("Cyprus x Latvia", "Cyprus x Malta"), "a shared side is not a shared fixture (x)");
ok(readFixture("Formula X Grand Prix") === null, "an X inside a name is not a versus");
/* reading a name */
ok(JSON.stringify(readFixture(`UEFA Nations League : North Macedonia vs Scotland ${FLAG}`)) === JSON.stringify({ sides: ["North Macedonia", "Scotland"], competition: "UEFA Nations League" }), "a competition prefix and a flag come off");
ok(readFixture("UFC 332: Silva vs Wang")?.competition === "UFC 332", "a card's title is the competition");
ok(readFixture("Croatia vs England - UEFA Nations League")?.competition === "UEFA Nations League", "a trailing competition is read");
ok(readFixture("India v Australia (1st ODI)")?.sides[1] === "Australia", "'v' is a separator");
ok(readFixture("Cuiaba v. Ponte Preta")?.sides.length === 2, "'v.' with a dot is a separator");
ok(readFixture("Peru @ Canada")?.sides.length === 2, "'@' is a separator");
ok(readFixture("Alpha vs Bravo vs Charlie")?.sides.length === 3, "as many sides as there are");
ok(readFixture("France - Ligue 3 : Simulcast") === null, "a simulcast is not a fixture");
ok(readFixture("Channel V HD") === null, "a channel with a V in its name is not a fixture");
ok(readFixture("Sky Sport 1") === null, "an ordinary channel is not an event");

/* the same event */
ok(same("Canada vs Peru", "Peru vs Canada"), "order does not matter");
ok(same("Spain vs Czechia", "Spain vs Czech Republic"), "Czech Republic is Czechia");
ok(same("Spain vs Czechia", "Spain vs Czech"), "Czech is Czechia");
ok(same("USA vs Mexico", "United States vs Mexico"), "USA is the United States");
ok(same("Arsenal FC vs Chelsea FC", "Arsenal vs Chelsea"), "FC is noise");
ok(same("Atletico Tucuman v. Barracas Central", "Atlético Tucumán vs Barracas Central"), "accents and 'v.'");
ok(same("UEFA Nations League : Scotland vs North Macedonia", "North Macedonia vs Scotland"), "the competition is not part of the identity");
ok(same("No. 24 Kentucky vs South Carolina", "South Carolina vs Kentucky"), "a ranking is not part of the name");
ok(same("Sint Maarten v. St. Vincent&Grenadines", "Sint Maarten vs Saint Vincent and the Grenadines"), "St is Saint, & is and");
ok(same("Racing Louisville(w) v. Utah Royals(w)", "Racing Louisville FC (w) v. Utah Royals FC (w)"), "(w) however it is bracketed");
ok(same("Holy Cross vs William & Mary", "William and  Mary vs Holy Cross"), "& and 'and', spacing");
ok(same("Forge FC v. HFX Wanderers FC", "Forge vs HFX Wanderers"), "FC on either side");
ok(same("UFC 332: Silva vs Wang", "Silva vs Wang"), "a prefix naming the card is not a side");

/* not the same */
ok(!same("Spain vs Czechia", "Spain U21 vs Czechia U21"), "a youth side is another team");
ok(!same("Real Madrid vs Barcelona", "Real Madrid Castilla vs Barcelona"), "a reserve side is another team");
ok(!same("Spain vs Czechia", "Spain vs France"), "one side in common is not enough");
ok(!same("Manchester United vs Leeds", "Manchester City vs Leeds"), "United is not City");
ok(!same("Arsenal vs Chelsea", "Arsenal Women vs Chelsea Women"), "women's teams are other teams");
ok(!same("Inter vs Milan", "Inter Miami vs Chicago"), "Inter is not Inter Miami when the other side differs too");

/* a team written shorter by one source */
ok(same("Ohio State Buckeyes vs Iowa Hawkeyes", "Ohio State vs Iowa"), "mascots on both sides");
ok(same("UNLV Rebels vs California", "UNLV vs California"), "a mascot on one side");
ok(same("Syracuse Orange vs UConn Huskies", "UConn vs Syracuse"), "mascots, other order");
ok(same("Los Angeles Lakers vs Oklahoma City Thunder", "Los Angeles vs Oklahoma City"), "a city for a team");
ok(!same("Arsenal Women vs Chelsea Women", "Arsenal vs Chelsea"), "a women's side is never trimmed to the men's");
ok(!same("Spain U21 vs Czechia U21", "Spain vs Czechia"), "a youth side is never trimmed");
ok(!same("New York Yankees vs Boston Red Sox", "New Orleans vs Boston"), "'New' alone is not a team");
ok(!same("Manchester United vs Leeds", "Manchester City vs Leeds"), "United is not City (still)");
ok(!same("Ohio State Buckeyes vs Iowa Hawkeyes", "Ohio State Buckeyes vs Michigan Wolverines"), "one side is not enough");
ok(allKeys("Arsenal vs Chelsea").size === 1, "a one-word team has one key");

/* title-only events and explicit sides */
ok(eventFor("2026 World Grand Prix | Day 6").event.key === eventFor("World Grand Prix Day 6").event.key, "title-only events match on the title without the year");
ok(eventFor("World Grand Prix Day 6").event.key !== eventFor("World Grand Prix Day 7").event.key, "another day is another event");
ok(eventFor("x", { sides: ["Peru", "Canada"] }).event.key === key("Canada vs Peru"), "sides given by the source key the same as a name");
ok(eventFor("Live").event.key === undefined, "a title too short to identify anything gets no key");
ok(eventFor("UEFA Nations League : Peru vs Canada").name === "Peru vs Canada", "the card is named by who is in it");

console.log(`event-key: ${checks} checks ok`);
