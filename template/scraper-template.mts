/**
 * TEMPLATE: a live-TV scraper for live-tv.
 * ========================================
 *
 * This file is self-contained on purpose -- it imports nothing from the
 * repository it is meant to join. Develop it anywhere, test it with plain
 * `node` or `tsx`, and hand the finished file back.
 *
 * COMPILE IT YOURSELF -- THIS CONTAINER RUNS NO TYPESCRIPT
 * -----------------------------------------------------------
 * Before handing the file back, compile it to plain JavaScript with the
 * SAME STRICTNESS this repository builds under, so it needs no further
 * editing on the other end. Name the SOURCE file `<your-id>.mts`, not
 * `.ts` -- that one letter is what makes `tsc` emit `.mjs` on its own,
 * which matters (see below):
 *
 *     tsc --strict --noUncheckedIndexedAccess --target ES2022 \
 *         --module ES2022 --moduleResolution bundler \
 *         <your-id>.mts
 *
 * `--noUncheckedIndexedAccess` is the one most templates miss: it means
 * `array[i]` is typed `T | undefined`, not `T`, everywhere -- including a
 * regex match's capture groups (`match[1]`) and every `for (let i = 0; ...)`
 * loop. Either narrow before use (`if (!entry) continue;`) or assert where
 * a bound already guarantees it (`array[i]!`) -- don't hand back a file
 * that only compiles with these flags loosened, since loosening them for
 * one file loosens them for the whole build.
 *
 * WHY `.mjs`, NEVER PLAIN `.js`: Node decides whether a `.js` file is a
 * module or CommonJS from the nearest `package.json`'s `"type"` field --
 * and the directory a dropped-in scraper lands in (a bind-mounted data
 * volume) has no `package.json` at all, so a bare `.js` defaults to
 * CommonJS and fails to parse the `import`/`export` syntax `tsc` emits.
 * `.mjs` has no such ambiguity; it is always a module, everywhere. Compile
 * from a `.mts` SOURCE rather than renaming the compiled output by hand --
 * `tsc` then also type-checks against Node's ESM resolution rules, which
 * `.ts` does not.
 *
 * Three ways to hand the finished, compiled scraper back -- pick whichever
 * fits how you're delivering it:
 *
 *   * IMPORT FROM GITHUB, NO COPYING AT ALL -- if this scraper lives in a
 *     repository with a `dist/` directory holding its compiled `.mjs`
 *     output COMMITTED (not gitignored -- see that repository's own
 *     AGENTS.md if it has one), Settings > Live TV > Sources > "Import
 *     from GitHub" reads it directly: enter the repo, an optional branch
 *     and, for a private repo, an access token, and it is fetched, checked
 *     and dropped in with no manual copying at all. Set `version` below so
 *     a later re-check only replaces this scraper when it is genuinely
 *     newer -- see that field's own comment.
 *   * DROP IT IN, NO REBUILD -- copy the compiled `<your-id>.mjs` into the
 *     `scrapers` directory on the deployment's mounted data volume, then
 *     reload it from Settings > Live TV > Sources > "Reload sources" (or
 *     just restart the container). It appears immediately, on by default,
 *     checked and ranked exactly like every other source -- no image
 *     rebuild, no redeploy, and no access to this repository needed at
 *     all. This is the route for a scraper built somewhere else and
 *     handed back as a finished file, with nowhere to import it from.
 *   * BUILT INTO THE IMAGE -- for someone with the repo open: save this
 *     file (the `.ts`, not the compiled output) as
 *     `src/scrapers/<your-id>.ts`, then in `src/scrapers.ts` add an import
 *     and one entry to the `BUILTIN` array:
 *
 *         import { myScraper } from "./scrapers/<your-id>.js";
 *         const BUILTIN: Scraper[] = [myScraper];
 *
 *     Needs a rebuild and a redeploy, worth it only for a source the
 *     deployment should never run without even after a wiped data volume --
 *     nothing is built in by default.
 *
 * WHAT YOUR SCRAPER OWES THE REST OF THE SYSTEM
 * -----------------------------------------------
 * Exactly one function, `build()`, that returns every channel your source
 * currently knows about, freshly fetched, and -- OPTIONALLY -- some named
 * groupings of your own channels to offer as rails. You do NOT need to:
 *
 *   - check whether a stream URL actually plays -- the nightly sweep does
 *     that for every source, uniformly;
 *   - rank or score anything, on a channel OR a rail -- ranking happens
 *     centrally, from fields every channel already carries (mirror count,
 *     category, whether it has a logo and so on); a rail you declare shows
 *     your channels best-first the same way any other rail does;
 *   - group your channels into rails at all -- most scrapers have no
 *     opinion here and leave `rails` out; the generic country/theme/kids
 *     rails are built centrally regardless, from every source at once;
 *   - worry about how often you are called -- `build()` is invoked at most
 *     once per index rebuild (every twelve hours, or on a manual refresh),
 *     never per page view.
 *
 * You DO need to:
 *
 *   - give every channel a globally unique id in YOUR OWN namespace (see
 *     `idFor` below) -- ids are never merged or reconciled across sources,
 *     a collision just means one of the two is silently dropped;
 *   - throw, rather than return an empty catalogue, when the fetch
 *     genuinely failed -- the caller keeps last night's channels on a
 *     thrown error, but an empty `channels` array is taken as "this source
 *     now has zero channels" and replaces them with nothing;
 *   - keep it reasonably fast and bounded -- there is no global timeout
 *     wrapped around `build()`, so set your own (see `withTimeout` below)
 *     rather than let one slow request hold up the whole rebuild.
 *
 * NEVER RETURN A STREAM URL YOU HAVE NOT AT LEAST FOUND IN YOUR SOURCE'S
 * OWN LISTING. This scraper is trusted to say what exists; it is not
 * trusted to guess.
 */

// -------------------------------------------------------------------------
// The shapes you build, copied verbatim from `src/scraper-types.ts` so this
// file needs nothing else. Keep them in sync if you pull a newer copy of
// this template later.
// -------------------------------------------------------------------------

interface ScrapedStream {
    url: string;
    /** Free text, e.g. "1080p". Not trusted, only shown. */
    quality: string;
    /** Short warnings such as "Geo-blocked" or "Not 24/7". */
    labels: string[];
    /** HTTP Referer this stream needs, or "". Sent on EVERY request the
     *  stream makes -- playlist, variants, segments, keys -- because the
     *  live-tv relays all of them. */
    referrer: string;
    /** User-Agent this stream needs, or "". Sent the same way. */
    userAgent: string;
    /**
     * OPTIONAL. Further request headers, sent on every request the stream
     * makes (playlist, variants, segments, keys): `Origin`, a token header,
     * `Cookie`. Names are free; `Host`, `Content-Length`, `Accept-Encoding`,
     * `Range`, `User-Agent` and `Referer` are ignored (use the two fields
     * above); at most 16, values up to 4 KB, no line breaks. `Cookie` and
     * `Authorization` go only to the host the stream's own address is on,
     * and are dropped on a redirect to another host; ClearKey streams get
     * neither. STATIC: a header that must differ on every request cannot be
     * carried -- a per-play cookie belongs in a resolver, which may return
     * `headers` too. Needs live-tv 1.9.0; an older host ignores the field.
     */
    headers?: Record<string, string>;
    /**
     * OPTIONAL. The name of an entry in this scraper's own `decoders`
     * (see `Scraper.decoders` and `SegmentDecoder` below) that every
     * SEGMENT of this stream must pass through before a player can read it.
     * Leave it out for an ordinary stream -- which is nearly all of them.
     *
     * For a CDN that disguises its video: dlhd's segments are real PNG
     * images with the MPEG-TS packed into their pixels (see `dlhd.mts`).
     * live-tv relays the stream, reads each playlist as it passes so it
     * knows every segment URL in it, and runs your decoder on each segment
     * on the way to the player. Playlists themselves are never decoded.
     *
     * A NAME, not the function, because your catalogue is stored as JSON
     * between runs. A name with no matching decoder -- or a live-tv too
     * old to relay segments -- drops the stream rather
     * than handing a player a picture.
     */
    decoder?: string;
    /**
     * OPTIONAL. The name of an entry in this scraper's own `resolvers`
     * (see `Scraper.resolvers`) that turns this stream's `url` into a
     * playable one AT THE MOMENT IT IS NEEDED. Leave it out for an ordinary
     * stream -- nearly all of them.
     *
     * For a source whose playable address cannot be written down ahead of
     * time: it is signed and expires, is bound to the caller, or is minted
     * by a handshake that must be repeated. Resolved once at scrape time
     * such a URL is stale by the time anyone presses Play.
     *
     * With a resolver, `url` is a HANDLE: any stable, unique URL naming the
     * stream (convention: `https://<scraper id>.invalid/<key>` -- a host
     * that never resolves, so a handle that escaped fails cleanly). It is
     * what the host stores evidence against and ranks by, and it is NEVER
     * fetched. The host calls the resolver for every check, probe and play
     * and fetches what it returns. A NAME, because the catalogue is JSON.
     */
    resolver?: string;
    /**
     * OPTIONAL. Marks `url` as a DASH manifest (`.mpd`) whose media is
     * ENCRYPTED with Common Encryption ("cenc", AES-CTR), and gives the
     * ClearKey that opens it. Leave it out for an ordinary stream.
     *
     * For sources that restream a DRM-protected channel and publish the key
     * beside it (a player page holding `kid:key` for Shaka or dash.js).
     * A television's browser cannot be handed a key through a URL, so the
     * HOST does it: ffmpeg opens the manifest with the key, copies the
     * decrypted video and audio (no re-encode) into ordinary HLS segments,
     * and the player is served that. To the viewer it is an HLS channel.
     *
     * `url` is the real manifest address, not a handle (but a stream with
     * a `resolver` may have the resolver return `clearKey` instead -- see
     * `ResolvedStream`). `referrer` and `userAgent` are sent on the manifest
     * and on every segment, as for any stream. It does not combine with
     * `decoder`: the host's own output is ordinary video.
     *
     * One key pair only: it must open every track the stream carries,
     * which is what these sources do in practice. A stream whose audio and
     * video use different keys cannot be expressed and should be left out.
     * Widevine, PlayReady and FairPlay are not ClearKey and are not
     * supported by anything here -- do not hand one over.
     *
     * Needs live-tv 1.8.0 and an `ffmpeg` on the host; without
     * both the stream is dropped, not offered broken. The host checks such a
     * stream as far as its manifest (reachable, really an MPD); whether the
     * key is right is only found out when someone plays it.
     */
    clearKey?: ClearKey;
}

/**
 * A ClearKey pair, both 32 hex characters (16 bytes). `key` decrypts;
 * `kid` is the key id the manifest names and is kept for the record --
 * the host does not need it to decrypt. See `ScrapedStream.clearKey`.
 */
interface ClearKey {
    kid: string;
    key: string;
}

/**
 * Turns one segment, exactly as the CDN served it, into what a player
 * expects -- normally MPEG-TS (188-byte packets, each starting `0x47`).
 * `url` is the segment's own address. Throw if the bytes are not what you
 * expected: that one segment then fails, and the player moves on.
 *
 * Runs on the live-tv server for every segment of every viewer, so keep
 * it pure computation over the bytes: no network, no state between calls.
 * `node:zlib` and `node:crypto` cover what this usually takes.
 */
/** What a resolver returns: the real address, plus the headers it needs if
 *  they differ from the stream's own. `null` (or a throw) means "cannot be
 *  resolved right now": a dead mirror, tried again on the next press. The
 *  host reuses an answer for about five minutes and gives a resolver about
 *  twelve seconds -- it is on the way to a press of Play. */
interface ResolvedStream {
    url: string;
    referrer?: string;
    userAgent?: string;
    /** Replaces the stream's own `headers` when given (see `ScrapedStream.headers`). */
    headers?: Record<string, string>;
    /** The key for a stream that is encrypted (see `ScrapedStream.clearKey`),
     *  when the resolver is what knows it -- a signed manifest and its key
     *  often change together. Overrides the stream's own. */
    clearKey?: ClearKey;
}

/** `handle` is the stream's own `url`. */
type StreamResolver = (handle: string) => Promise<ResolvedStream | null>;

type SegmentDecoder = (segment: Uint8Array, url: string) => Uint8Array | Promise<Uint8Array>;

/**
 * WHAT A LIVE EVENT IS, SAID BY THE SOURCE THAT KNOWS. A fixture is not its
 * name: seven sources write "Canada vs Peru", "Peru vs Canada", "UEFA Nations
 * League : Peru vs Canada". Working out that these are one match -- team
 * aliases, women's and youth sides, rankings, how a site writes a title -- is
 * YOUR job, because only you can see your data; the host knows no sport and no
 * team and only compares what you say.
 *
 * So compute a `key` and put it here. Name the card `Team A vs Team B` (any
 * number of sides) -- the participants only, no competition, round, flag or
 * "HD" -- and let the key carry the identity.
 *
 * The key is an opaque string, equal for two cards of the same event, from
 * whichever scraper wrote them. The convention every scraper here follows (the
 * `event-key` block, kept identical across them) is `v:` plus the sides' folded
 * identities, sorted and joined with `|`; for an event with no opponents
 * `t:` plus its folded title without the year. Use the same convention if you
 * want your events to merge with theirs; a different one merges only with
 * itself. Two cards with the same key merge unless both give a `start` more
 * than eight hours apart (a rematch, a replay). A card with no key is an
 * ordinary channel to the host.
 *
 * Every other field is optional and informational; give what the source has
 * and never invent one.
 */
interface ScrapedEvent {
    /** The identity: equal for two cards of one event. See above. */
    key?: string;
    /** The participants, as the source writes them: ["Canada", "Peru"]. Used
     *  for the card's name only. */
    sides?: string[];
    /** The event's own title when there are no sides: "World Grand Prix, Day 6". */
    title?: string;
    /** "UEFA Nations League", "UFC 332", "Friendlies". Shown, never matched on. */
    competition?: string;
    /** "football", "cricket", "mma", "darts" ... lowercase, free text. */
    sport?: string;
    /** Scheduled start, EPOCH MILLISECONDS. Omit when unknown -- never 0. */
    start?: number;
}

interface ScrapedChannel {
    /** Must start with `live:<your-scraper-id>:` -- see `idFor`. */
    id: string;
    name: string;
    /** ISO-ish country code as your source writes it, or "" if unknown. */
    country: string;
    /** The same country written out. "" falls back to the code. */
    countryName: string;
    /** That country's flag emoji, or "". */
    countryFlag: string;
    /** Free-text categories -- "news", "sports", "kids" and so on. Made-up
     *  categories are fine; unrecognised ones are simply worth nothing to
     *  the ranking rather than penalised. */
    categories: string[];
    /** ISO 639-3 codes for the channel's main language, if known. */
    languages: string[];
    /** A direct image URL. SVG is avoided if you have a choice -- the
     *  artwork proxy this surface uses can re-type raster formats but
     *  cannot sniff SVG, so an SVG logo renders as a broken image. */
    logo: string;
    /**
     * OPTIONAL. Two pictures for ONE card, drawn side by side on a single
     * tile -- a fixture's two flags or crests ("India" | "West Indies").
     * Leave it out for an ordinary channel. When it is present, `logo` must
     * still be set (to the first picture): a host that predates this field
     * shows `logo` alone, and a card whose logo is empty is given a name pill.
     * Direct image URLs, as `logo`; at most the first two are used. The
     * pair is only drawn when BOTH could be fetched; otherwise the card falls
     * back to `logo`. When two sources' cards for the same event merge, the
     * merged card takes `logo` and `logos` from whichever source has them.
     */
    logos?: string[];
    /**
     * OPTIONAL. What a live EVENT is, stated rather than left to be read out
     * of `name` -- the way cards from different sources become one card.
     * Leave it out for an ordinary channel. See `ScrapedEvent`.
     */
    event?: ScrapedEvent;
    website: string;
    network: string;
    /** At least one, or the channel is dropped centrally -- no need to
     *  filter empty-stream channels out yourself, but you may. */
    streams: ScrapedStream[];
}

/*
    ONE MORE THING THAT HAPPENS TO `name`/`country` CENTRALLY, AFTER
    `build()` RETURNS: a channel (or a live event -- the same type) whose
    folded `name`+`country` matches one already in the index, from another
    scraper (iptv-org's own built-in list included), is not added as a
    second card. Its `streams` are appended to the EXISTING channel's
    mirror list instead, each one still remembered as having come from
    this scraper for the source list's own badge -- you never see this
    happen and never need to give it a matching key yourself, it just
    means a channel your scraper returns may end up sharing a card, and a
    higher score, with someone else's entry rather than getting its own.
    A non-iptv-org mirror gets a small, deliberately modest preference over
    an iptv-org one when nothing else (verified liveness, codec) has
    already told the two apart -- write `name` the way a human would say
    it (no "(HD)", no "[Backup]") so this actually recognises the channel
    it is the same as.
*/

interface ScrapedRail {
    /** A short slug, unique within THIS scraper only, `[a-z0-9-]` and 40
     *  characters or fewer -- e.g. "anime-simulcasts". The final id shown
     *  to a viewer is built centrally as `rail:<your-scraper-id>-<this>`,
     *  so two scrapers can both call theirs "sport" with no collision. */
    id: string;
    /** Shown as the rail's heading, same as any other rail -- and the ONE
     *  place two different scrapers deliberately share text rather than
     *  namespacing away from each other. A rail from this scraper and a
     *  rail from another whose `heading`, trimmed and case-folded, reads
     *  the same are merged centrally into a single rail carrying both
     *  scrapers' channels (deduplicated the same way a repeated channel
     *  is, see `ScrapedChannel` above) rather than shown as two rails with
     *  the same title. If your source has a live-events rail, call it
     *  exactly "Live Events" so it merges with any other scraper's -- a
     *  viewer wants one events rail with several sources per event, not
     *  one per scraper. Do NOT do this by accident: a generic heading like
     *  "Sports" from two unrelated scrapers would merge the same way, so
     *  pick a heading that only means "merge with me" when you mean it. */
    heading: string;
    /** Ids of channels THIS SAME `build()` call also returned in
     *  `channels`. An id belonging to another scraper, or one this call
     *  did not itself return, is dropped rather than resolved -- a rail is
     *  not a way to reach into somebody else's catalogue. Leave it `[]`
     *  when the rail is described by `filter` instead. */
    channelIds: string[];
    /** Shown small beside the heading ("Most widely carried"). Defaults to
     *  "From <your scraper's name>". */
    by?: string;
    /** OPTIONAL. Where this rail sits in the lists of every rail: up to three
     *  names joined by "/" ("Genres", "Countries/Europe"). Each name is a group
     *  that opens and closes. Rails with no group are listed beside the groups. */
    group?: string;
    /** Describes the rail instead of listing it: the host fills it from
     *  the finished index, ranked like every rail (what last night's check
     *  proved first) and for the household looking, so a rail that means
     *  "all of X" -- a country, a language, a genre -- never goes stale.
     *  `channelIds` is ignored when this is present, and a filter rail is
     *  never merged with another by heading. Every field present must
     *  match; within a field any value does. See scrapers/iptv-org.mts. */
    filter?: {
        /** Country codes as your channels carry them in `country`. */
        countries?: string[];
        /** Your channels' own `categories` words. */
        categories?: string[];
        /** The host's genre ids, which fold every source's categories onto
         *  one vocabulary: news, entertainment, movies, sports, kids, music,
         *  documentary, lifestyle, business, devotional, general. */
        genres?: string[];
        /** ISO 639-3 codes on a channel's main feed. */
        languages?: string[];
        /** Network names as your channels carry them in `network`, case-folded. */
        networks?: string[];
        /** Ids of sources: "everything on <your scraper id>". */
        sources?: string[];
        /** "home-first" lifts the household's own countries above the rest;
         *  "first" keeps only the household's first market. Omitted: the same
         *  for everyone. */
        market?: "home-first" | "first";
    };
}

/** A page to start the Live TV app with: a title and which of THIS
 *  scraper's rails it carries, in order. Only a suggestion for a television
 *  nobody has edited; anyone can add, remove and rearrange pages and rails
 *  in Settings > Site layout. Pages from several scrapers with the same id
 *  are one page. `rows`: 1 (default) is one line that scrolls sideways, n is
 *  n lines scrolling together, 0 is as many as it takes to show everything
 *  with no sideways scrolling. */
interface ScrapedPage {
    /** Slug, `[a-z0-9-]`, 32 characters or fewer. */
    id: string;
    title: string;
    rails: { id: string; rows?: number }[];
}

interface ScrapedCatalogue {
    channels: ScrapedChannel[];
    /** Leave out entirely if you have no opinion about grouping -- most
     *  scrapers do, and that is the normal case, not a missing feature. */
    rails?: ScrapedRail[];
    /** Likewise optional: pages the app should start with. */
    pages?: ScrapedPage[];
}

/** A value one of this scraper's own config fields can hold. */
type ScraperConfigValue = string | number | boolean;

/**
 * One user-settable knob this scraper declares for itself -- an interval, a
 * pacing delay, a page size, anything the person running a deployment might
 * reasonably want to change without editing this file. Shown in Settings >
 * Live TV > Sources next to a gear icon beside this scraper's name,
 * pre-filled with its CURRENT value (whatever is stored, or `default` if
 * this deployment has never changed it).
 *
 * OPTIONAL -- a scraper with nothing worth exposing simply has no
 * `configSchema` at all, and gets no gear icon. This is the common case
 * unless your scraper also declares `tasks` (see below), where at least one
 * interval field is the whole point.
 */
interface ScraperConfigField {
    /** Stable, unique within THIS scraper's own schema. Never reuse a key
     *  for a field of a different meaning later -- see "Config values
     *  survive an update" below for why that matters. */
    key: string;
    /** Shown as the field's label in the settings form. */
    label: string;
    type: "number" | "string" | "boolean";
    /** Both this field's starting value on a fresh deployment AND the
     *  fallback used whenever a stored value no longer matches this field
     *  (wrong type, or the field is new since the value was last saved). */
    default: ScraperConfigValue;
    /** For a `"number"` field only. */
    min?: number;
    max?: number;
    /** A short explanation shown under the field in the settings form. */
    help?: string;
}

/** What a task's `run()` is handed. See `ScraperTask` below. */
interface ScraperTaskContext {
    /** This scraper's current config values, already reconciled against
     *  `configSchema` -- read directly, no lookup needed. */
    config: Record<string, ScraperConfigValue>;
    /**
     * Ensures one of THIS SAME scraper's other tasks has run at least once
     * during this run -- a no-op if it already has, otherwise it runs now
     * (satisfying that task's own `dependsOn` first). This is how a task
     * states a real prerequisite without the host needing to guess the
     * right order, and without your own code needing to call the
     * prerequisite's logic directly.
     */
    runTask(id: string): Promise<void>;
}

/**
 * One independently refreshable piece of work, besides the main `build()`.
 *
 * OPTIONAL -- most scrapers have a single source of data and need no
 * `tasks` at all; `build()` alone is a complete, correct scraper. Declare
 * `tasks` only when your source genuinely has parts that change at
 * different rates and are worth refreshing on different schedules -- e.g. a
 * slow full catalogue (twice a day is plenty) alongside a fast-moving
 * live-events feed (useful refreshed hourly). Each task gets its own "Run
 * now" button and, via a `configSchema` field, its own user-settable
 * refresh interval in Settings.
 */
interface ScraperTask {
    /** Stable, unique within this scraper's own `tasks`. */
    id: string;
    /** Shown next to this task's "Run now" button and its last-run status. */
    label: string;
    /** Ids of this scraper's OTHER tasks that must run first, in order,
     *  whether this task was triggered by its own schedule or by hand from
     *  Settings. The host runs each task in the chain at most once per
     *  invocation -- declaring this is the whole story; you never need to
     *  reason about ordering yourself. A cycle here is a bug in this file
     *  and fails loudly rather than hanging. */
    dependsOn?: string[];
    /** The key of a `"number"` field in `configSchema`, read as MINUTES
     *  between automatic runs of this task -- independently of every other
     *  task this scraper declares. Omit for a task that only ever runs as
     *  someone else's dependency, or only by hand. */
    intervalConfigKey?: string;
    run(ctx: ScraperTaskContext): Promise<void>;
}

/** What `build()` and `buildEvents()` are handed. */
interface ScraperBuildContext {
    /** This scraper's current config values, already reconciled against
     *  `configSchema`. */
    config: Record<string, ScraperConfigValue>;
}

interface Scraper {
    /** Stable, short, lowercase-dashed. Pick it once and do not rename it
     *  after this scraper has shipped -- it is the namespace every id you
     *  produce lives in, and renaming it orphans every favourite and
     *  watch-progress row a viewer has against your channels. */
    id: string;
    /** Shown in the Settings sources list. */
    name: string;
    /**
     * OPTIONAL, but set it if this scraper will ever be pulled in through
     * Settings > Live TV > Sources > "Import from GitHub" rather than only
     * copied in by hand: dot-separated integers, e.g. "1.2.0". A re-import
     * only ever replaces the copy already running when this is a real
     * increase over it, segment by segment -- an unversioned file can never
     * be known to be newer than anything, so leaving this out means a
     * re-import of this same file is always skipped as "no update", not
     * reapplied. Bump it whenever `build()`'s behaviour changes.
     */
    version?: string;
    /** OPTIONAL. See `ScraperConfigField` above. */
    configSchema?: ScraperConfigField[];
    /** OPTIONAL. See `ScraperTask` above. */
    tasks?: ScraperTask[];
    /** OPTIONAL. Named segment decoders, referenced by
     *  `ScrapedStream.decoder`. See `SegmentDecoder` above. */
    decoders?: Record<string, SegmentDecoder>;
    /** OPTIONAL. Named stream resolvers, referenced by
     *  `ScrapedStream.resolver`. See `StreamResolver` above. */
    resolvers?: Record<string, StreamResolver>;
    /** The CHANNELS job. For a scraper with live events too, return the
     *  channel list only (or `{ channels: [] }` when there is none). */
    build(context?: ScraperBuildContext): Promise<ScrapedCatalogue>;
    /**
     * OPTIONAL. The LIVE EVENTS job: fixtures, races, fights -- anything
     * that is on for a few hours and listed under a name that other sources
     * list too. Export it and the host runs it as its own job: its own held
     * result, schedule (`eventsIntervalMinutes` in `configSchema`, default 15
     * minutes; the channel job's is `channelsIntervalMinutes`, default 12
     * hours), "Run events" button and status. A slow channel crawl therefore
     * never holds events back, and events stay fresh with nobody looking.
     * Same return type as `build()`; every event card should carry `event`
     * (see `ScrapedEvent`) and a "Live Events" rail. Ids must still start
     * `live:<your-scraper-id>:`.
     */
    buildEvents?(context?: ScraperBuildContext): Promise<ScrapedCatalogue>;
}

/*
    CONFIG VALUES SURVIVE AN UPDATE -- AUTOMATICALLY, FIELD BY FIELD.

    The host stores each scraper's config values keyed by field `key`. When
    you ship a change to `configSchema` -- add a field, remove one, or
    change a field's `type` -- nothing here needs to migrate anything by
    hand: the host reconciles what is stored against your CURRENT schema
    every time it is read. A key you still declare, of the same type, keeps
    whatever value was saved; a key you removed is simply dropped; a key
    that is new, or whose stored value no longer matches its declared type,
    starts at that field's `default`. This is exactly why `key` must be
    stable and never reused for a field with a different meaning -- reusing
    one would silently hand an old value to a field it was never meant for.
*/

// -------------------------------------------------------------------------
// Fill in from here down.
// -------------------------------------------------------------------------

/** Change this. It becomes the second segment of every id this scraper
 *  produces, e.g. "live:my-source:bbc-one". */
const SCRAPER_ID = "my-source";

function idFor(rawId: string): string {
    return `live:${SCRAPER_ID}:${rawId}`;
}

/*
    LIVE EVENTS ONLY -- delete the block below (and `buildEvents`, further
    down) if your source has no live events.

    The BEGIN/END markers are load-bearing: this block is identical in every
    scraper that lists events and `node scripts/sync-event-key.mjs` rewrites
    it between them. DO NOT EDIT IT HERE -- change `scripts/event-key.block.ts`
    and sync. Use it as `eventFor(title, { sides?, competition?, sport?,
    start? })`: it returns `{ name, event }`, the card's name ("A vs B") and
    the `event` object to put on the channel.
*/
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
 * A source that names an American side by its nickname alone ("Chiefs @ Raiders")
 * and one that writes the whole name ("Las Vegas Raiders") are one fixture.
 * Nicknames repeat across leagues (Giants, Panthers, Cardinals, Rangers, Kings,
 * Jets), so a nickname is only expanded when the source states the sport.
 */
const US_NICKNAMES: Record<string, Record<string, string>> = {};
for (const [sport, list] of Object.entries({
    "american football": "Cardinals=Arizona Cardinals;Falcons=Atlanta Falcons;Ravens=Baltimore Ravens;Bills=Buffalo Bills;Panthers=Carolina Panthers;Bears=Chicago Bears;Bengals=Cincinnati Bengals;Browns=Cleveland Browns;Cowboys=Dallas Cowboys;Broncos=Denver Broncos;Lions=Detroit Lions;Packers=Green Bay Packers;Texans=Houston Texans;Colts=Indianapolis Colts;Jaguars=Jacksonville Jaguars;Chiefs=Kansas City Chiefs;Raiders=Las Vegas Raiders;Chargers=Los Angeles Chargers;Rams=Los Angeles Rams;Dolphins=Miami Dolphins;Vikings=Minnesota Vikings;Patriots=New England Patriots;Saints=New Orleans Saints;Giants=New York Giants;Jets=New York Jets;Eagles=Philadelphia Eagles;Steelers=Pittsburgh Steelers;49ers=San Francisco 49ers;Seahawks=Seattle Seahawks;Buccaneers=Tampa Bay Buccaneers;Titans=Tennessee Titans;Commanders=Washington Commanders",
    "baseball": "Diamondbacks=Arizona Diamondbacks;Braves=Atlanta Braves;Orioles=Baltimore Orioles;Red Sox=Boston Red Sox;Cubs=Chicago Cubs;White Sox=Chicago White Sox;Reds=Cincinnati Reds;Guardians=Cleveland Guardians;Rockies=Colorado Rockies;Tigers=Detroit Tigers;Astros=Houston Astros;Royals=Kansas City Royals;Angels=Los Angeles Angels;Dodgers=Los Angeles Dodgers;Marlins=Miami Marlins;Brewers=Milwaukee Brewers;Twins=Minnesota Twins;Mets=New York Mets;Yankees=New York Yankees;Phillies=Philadelphia Phillies;Pirates=Pittsburgh Pirates;Padres=San Diego Padres;Giants=San Francisco Giants;Mariners=Seattle Mariners;Cardinals=St. Louis Cardinals;Rays=Tampa Bay Rays;Rangers=Texas Rangers;Blue Jays=Toronto Blue Jays;Nationals=Washington Nationals",
    "hockey": "Ducks=Anaheim Ducks;Bruins=Boston Bruins;Sabres=Buffalo Sabres;Flames=Calgary Flames;Hurricanes=Carolina Hurricanes;Blackhawks=Chicago Blackhawks;Avalanche=Colorado Avalanche;Blue Jackets=Columbus Blue Jackets;Stars=Dallas Stars;Red Wings=Detroit Red Wings;Oilers=Edmonton Oilers;Panthers=Florida Panthers;Kings=Los Angeles Kings;Wild=Minnesota Wild;Canadiens=Montreal Canadiens;Predators=Nashville Predators;Devils=New Jersey Devils;Islanders=New York Islanders;Rangers=New York Rangers;Senators=Ottawa Senators;Flyers=Philadelphia Flyers;Penguins=Pittsburgh Penguins;Sharks=San Jose Sharks;Kraken=Seattle Kraken;Blues=St. Louis Blues;Lightning=Tampa Bay Lightning;Maple Leafs=Toronto Maple Leafs;Canucks=Vancouver Canucks;Golden Knights=Vegas Golden Knights;Capitals=Washington Capitals;Jets=Winnipeg Jets;Mammoth=Utah Mammoth",
    "basketball": "Hawks=Atlanta Hawks;Celtics=Boston Celtics;Nets=Brooklyn Nets;Hornets=Charlotte Hornets;Bulls=Chicago Bulls;Cavaliers=Cleveland Cavaliers;Mavericks=Dallas Mavericks;Nuggets=Denver Nuggets;Pistons=Detroit Pistons;Warriors=Golden State Warriors;Rockets=Houston Rockets;Pacers=Indiana Pacers;Clippers=Los Angeles Clippers;Lakers=Los Angeles Lakers;Grizzlies=Memphis Grizzlies;Heat=Miami Heat;Bucks=Milwaukee Bucks;Timberwolves=Minnesota Timberwolves;Pelicans=New Orleans Pelicans;Knicks=New York Knicks;Thunder=Oklahoma City Thunder;Magic=Orlando Magic;76ers=Philadelphia 76ers;Suns=Phoenix Suns;Trail Blazers=Portland Trail Blazers;Kings=Sacramento Kings;Spurs=San Antonio Spurs;Raptors=Toronto Raptors;Jazz=Utah Jazz;Wizards=Washington Wizards"
})) {
    US_NICKNAMES[sport] = Object.fromEntries(list.split(";").map((pair) => pair.split("=") as [string, string]).map(([nick, full]) => [nick.toLowerCase(), full]));
}

/** The whole name for a nickname the source gave alone, when its sport says which league; else the name unchanged. */
function fullTeamName(name: string, sport: string | undefined): string {
    const table = US_NICKNAMES[(sport || "").toLowerCase()];

    return table?.[name.trim().toLowerCase()] || name;
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
    const found = extra.sides && extra.sides.length >= 2 ? { sides: extra.sides, competition: "" } : readFixture(title);
    const fixture = found && extra.sport ? { ...found, sides: found.sides.map((side) => fullTeamName(side, extra.sport)) } : found;
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

/** A bound on any one request, so a hung server cannot hold up the whole
 *  nightly rebuild. Wrap every `fetch` you make in this. */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = 20_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
        return await work(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * EXAMPLE: a source that publishes one JSON document listing channels and
 * their stream URLs directly. Replace this body with whatever your real
 * source needs -- an M3U playlist parsed by hand, several endpoints
 * combined the way `src/scrapers/iptv-org.ts` does, a scrape of an HTML
 * page, anything -- the only contract is the return type.
 *
 * The example also declares ONE rail, "Exclusives", over whichever of its
 * own channels it marks that way -- to show the shape, not because every
 * scraper should. Delete the `rails` block below if your source has no
 * grouping opinion of its own; that is the common case.
 */
async function build(): Promise<ScrapedCatalogue> {
    const response = await withTimeout((signal) =>
        fetch("https://example.invalid/channels.json", { signal })
    );

    if (!response.ok) throw new Error(`channels.json -> ${response.status}`);

    const raw = (await response.json()) as Array<{
        id: string;
        name: string;
        country?: string;
        logo?: string;
        stream_url: string;
        exclusive?: boolean;
    }>;

    const channels: ScrapedChannel[] = [];
    const exclusiveIds: string[] = [];

    for (const entry of raw) {
        // Skip anything you cannot responsibly offer -- adult content, a
        // channel your source itself marks as dead, and so on. The
        // example below only demonstrates dropping entries with no URL.
        if (!entry.stream_url) continue;

        const id = idFor(entry.id);

        channels.push({
            id,
            name: entry.name,
            country: entry.country || "",
            countryName: entry.country || "",
            countryFlag: "",
            categories: [],
            languages: [],
            logo: entry.logo || "",
            website: "",
            network: "",
            streams: [
                {
                    url: entry.stream_url,
                    quality: "",
                    labels: [],
                    referrer: "",
                    userAgent: ""
                }
            ]
        });

        if (entry.exclusive) exclusiveIds.push(id);
    }

    return {
        channels,
        rails: exclusiveIds.length
            ? [{ id: "exclusives", heading: "Exclusives", channelIds: exclusiveIds }]
            : []
    };
}

/**
 * EXAMPLE configSchema/tasks -- delete both, and the `run()` bodies below,
 * if your source has one uniform refresh rate; build() alone (above) is
 * already a complete scraper. Shown here only because "how do these two
 * connect to build()" is easier to see than to describe: a task's run()
 * writes into a small module-level cache, and build() reads from that same
 * cache -- falling back to fetching directly only the very first time,
 * before either task has ever run (e.g. right after this scraper is first
 * loaded, before the host's scheduler has had its first tick).
 */
let cachedChannels: ScrapedChannel[] | null = null;

const configSchema: ScraperConfigField[] = [
    {
        key: "refreshMinutes",
        label: "Refresh interval (minutes)",
        type: "number",
        default: 720,
        min: 15,
        help: "How often the channel list is re-scraped."
    }
];

const tasks: ScraperTask[] = [
    {
        id: "channels",
        label: "Refresh channel list",
        intervalConfigKey: "refreshMinutes",
        async run() {
            cachedChannels = (await build()).channels;
        }
    }
];

/**
 * EXAMPLE live events job. A source that lists today's fixtures as JSON, each
 * with its teams, competition, sport and kick-off. The four things that make
 * the events merge with every other scraper's:
 *
 *   1. Pass what the source KNOWS to `eventFor` -- the `sides` when it
 *      names the teams separately (far better than parsing a title), the
 *      `competition`, the `sport`, the `start` as EPOCH MILLISECONDS. Never
 *      invent one; leave it out.
 *   2. Name the card `described.name` ("Canada vs Peru"): participants only,
 *      no competition, round, flag or "HD". The identity is in `event.key`.
 *   3. Put `described.event` on the channel. No `key` (the title was not a
 *      fixture) makes it an ordinary channel, which is correct for a source's
 *      "Match Centre 1" feed.
 *   4. Declare a rail called exactly "Live Events", so every source's events
 *      share one rail.
 *
 * Many sources mirror one event and one source may list it twice; both merge,
 * so do not de-duplicate your own list. Each mirror is a stream of the card.
 */
async function buildEvents(_context?: ScraperBuildContext): Promise<ScrapedCatalogue> {
    const response = await withTimeout((signal) => fetch("https://example.invalid/live.json", { signal }));

    if (!response.ok) throw new Error(`live.json -> ${response.status}`);

    const raw = (await response.json()) as Array<{
        id: string;
        title: string;
        home?: string;
        away?: string;
        league?: string;
        sport?: string;
        kickoff?: number; // epoch ms
        stream_url: string;
    }>;

    const channels: ScrapedChannel[] = [];

    for (const entry of raw) {
        if (!entry.stream_url) continue;

        const sides = entry.home && entry.away ? [entry.home, entry.away] : [];
        const described = eventFor(entry.title, {
            ...(sides.length ? { sides } : {}),
            ...(entry.league ? { competition: entry.league } : {}),
            ...(entry.sport ? { sport: entry.sport } : {}),
            ...(entry.kickoff ? { start: entry.kickoff } : {})
        });

        channels.push({
            id: idFor(entry.id),
            name: described.name,
            country: "",
            countryName: "",
            countryFlag: "",
            categories: ["sports", ...(entry.sport ? [entry.sport] : [])],
            languages: [],
            logo: "",
            event: described.event,
            website: "",
            network: "",
            streams: [{ url: entry.stream_url, quality: "", labels: [], referrer: "", userAgent: "" }]
        });
    }

    return {
        channels,
        rails: channels.length
            ? [{ id: "live-events", heading: "Live Events", channelIds: channels.map((channel) => channel.id), group: "Live events" }]
            : []
    };
}

export const myScraper: Scraper = {
    id: SCRAPER_ID,
    name: "My Source",
    // Optional -- see the Scraper interface above. Bump this whenever
    // build()'s behaviour changes; delete the line entirely if this
    // scraper is only ever going to be dropped in by hand.
    version: "1.0.0",
    // Both optional -- delete along with the example block above if this
    // scraper has nothing worth exposing as a setting.
    configSchema,
    tasks,
    build,
    // Delete for a source with no live events. With it, channels and events
    // are two jobs with their own schedules (add `channelsIntervalMinutes`
    // and `eventsIntervalMinutes` fields to `configSchema` to expose them).
    buildEvents
};

// -------------------------------------------------------------------------
// A quick manual test you can run standalone, before this ever touches the
// real repository: `npx tsx docs/scraper-template.ts` (or compile with
// `tsc` and run with `node`). Prints a channel count, a rail count, and the
// first channel found.
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    build()
        .then((catalogue) => {
            console.log(`${catalogue.channels.length} channels, ${(catalogue.rails || []).length} rails`);
            console.log(catalogue.channels[0] || "(none)");
        })
        .catch((cause) => {
            console.error("build() threw:", cause);
            process.exitCode = 1;
        });
}
