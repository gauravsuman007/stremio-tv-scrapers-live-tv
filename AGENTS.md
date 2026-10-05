# Developing a live-TV scraper for live-tv

This repository has no access to [live-tv](https://github.com/gauravsuman007/live-tv)
(the standalone app that consumes a scraper built here) and doesn't need any --
everything the contract requires lives in
[`template/scraper-template.mts`](template/scraper-template.mts), a richer,
example-augmented copy of THAT repo's own `docs/scraper-template.ts` (itself
a byte-identical copy of its `src/livetv/scraper-types.ts` -- the canonical
`Scraper`/`ScrapedChannel`/`ScrapedRail`/... definitions), kept in sync by
hand whenever it changes there -- see that repository's own `AGENTS.md`.
Read the template file's header comment in full before writing anything; it
is the actual spec, not a summary of it. This document is the workflow
around it: how to go from "a source I want to scrape" to a file that plugs
into a running live-tv deployment with **zero further editing**.

## The workflow, start to finish

1. **Copy the template.** `cp template/scraper-template.mts scrapers/<your-id>.mts`
   -- the `.mts` extension is required, not cosmetic (see "Why `.mts`"
   below). Pick `<your-id>` the same way the template's `SCRAPER_ID`
   constant wants it: stable, short, lowercase-dashed, never renamed once
   it ships.
2. **Implement `build()`** against whatever the real source publishes.
   Everything the function owes the rest of the system -- id namespacing,
   what to throw on vs. skip, that ranking and playability checks are the
   host's job, not yours -- is in the template's header. Read
   [`scrapers/ntvst.mts`](scrapers/ntvst.mts) for a worked example that
   fans out across several backends and declares a rail; its own comments
   explain every non-obvious step, which is usually more useful than the
   code itself when adapting this to a similar site.
3. **Run it standalone** before compiling anything:
   ```bash
   npm install
   npx tsx scrapers/<your-id>.mts
   ```
   This actually hits the real source and prints a channel/rail count plus
   the first channel found -- confirm the count looks right and the first
   channel has a real `streams[0].url`, not `undefined` or an empty string.
4. **Typecheck it locally with this repository's own `tsconfig.json`**,
   which mirrors live-tv's build flags exactly (`--strict
   --noUncheckedIndexedAccess`, target/module `ES2022`, `moduleResolution:
   bundler`):
   ```bash
   npm run build
   ```
   This must exit clean, zero errors, before you ever push --
   `--noUncheckedIndexedAccess` is the flag every generic TypeScript
   scraper trips on: it types `array[i]` and every regex capture group
   (`match[1]`) as `T | undefined`, not `T`. Fix each one for real (narrow
   with an `if`, or assert with `!` only where a loop bound already
   guarantees the value exists) -- **never** "fix" a compile error by
   loosening a flag in `tsconfig.json`. A file that only compiles under
   weaker settings will fail again the moment it reaches live-tv's own
   stricter build, which is the exact failure this workflow exists to
   prevent. **Leave the `dist/` this produced uncommitted** (`git checkout
   dist`, or just don't `git add` it) -- see "`dist/` is built by CI,
   never locally" below for why.
5. **Set a `version`** on the exported scraper object -- dot-separated
   integers, e.g. `"1.0.0"`. This is what lets live-tv's "Import from
   GitHub" (see "Delivering it" below) treat a later change as an UPDATE
   rather than either silently ignoring it or blindly re-copying it every
   time regardless of whether anything changed. Optional for a scraper only
   ever dropped in by hand, but there is no reason not to set it. Bump it
   every time `build()`'s behaviour changes.
6. **Commit and push the `.mts` source only.** CI builds `dist/<your-id>.mjs`
   from a clean checkout and commits it back as `github-actions[bot]` --
   see "`dist/` is built by CI, never locally" below. `git pull` before
   your NEXT commit to this repository; the bot's `dist/` commit will be
   ahead of you.

## Config and tasks are optional -- add them only when they earn their keep

The template's `configSchema` and `tasks` (both OPTIONAL, see the template's
header for the full contract) let your scraper expose user-settable knobs
-- an interval, a pacing delay -- and split its work into independently
refreshable, independently schedulable pieces. Most scrapers have one
uniform refresh rate and need neither; `build()` alone is a complete,
correct scraper, and live-tv's Settings page simply shows no gear icon
next to one that declares nothing. Reach for `tasks` only when your source
genuinely has parts that change at different rates and are worth refreshing
on different schedules -- [`scrapers/ntvst.mts`](scrapers/ntvst.mts) is the
worked example: its full channel list defaults to a twice-daily refresh,
its live-events rail to hourly, each independently, via two
`configSchema` interval fields and two `tasks` entries.

If you do add either: a task's `run()` is expected to write into a small
module-level cache that `build()` itself reads from (falling back to
fetching directly only if a task hasn't run yet -- see `ntvst.mts`'s
`channelsCache`/`eventsCache`), and a config field's `key` must be
STABLE -- live-tv reconciles stored values against your CURRENT
`configSchema` on every read (a removed key is dropped, a new one gets its
`default`, a retyped one is treated as new), so reusing a `key` for a field
with a different meaning would silently hand it an old, unrelated value.

## Why `.mts`, and why the output must be `.mjs`

Node decides whether a `.js` file is an ES module or CommonJS from the
nearest `package.json`'s `"type"` field. The directory a dropped-in
scraper lands in on the live-tv side is a bind-mounted data volume with
no `package.json` at all -- so a bare `.js` compiled from this template's
`import`/`export` syntax would default to CommonJS there and fail to
parse. `.mjs` has no such ambiguity; it is always a module, on any host.

Writing the *source* as `<your-id>.mts` (not `.ts`) is what makes `tsc`
emit `.mjs` on its own, correctly, every time -- renaming a `.ts` file's
compiled `.js` output by hand is fragile and easy to forget. `.mts` also
makes `tsc` check the file against Node's actual ESM module-resolution
rules, which plain `.ts` does not, catching a class of import mistakes
`.ts` would silently let through.

## Why `dist/` is committed, and built by CI, never locally

live-tv's Settings > Live TV > Sources > "Import from GitHub" reads a
configured repository's `dist/` directory directly, over the GitHub API,
and drops whatever `.mjs` files it finds straight into that deployment's
scrapers directory -- no cloning, no build step on that end, because that
container runs no TypeScript compiler at all (same reason the delivered
file has to be `.mjs`, not `.ts`/`.mts`). For that importer to see this
repository's scrapers, the compiled output has to actually be in the
repository, on `main` (the importer always reads `main` -- there is no
branch parameter) -- which is the one thing a normal `dist/` convention
(gitignored, rebuilt from source on demand) would break. So here, `dist/`
is tracked, not gitignored.

**But `dist/` is built by CI, never on a developer's or agent's machine.**
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) typechecks and
builds on every push and pull request, and on a push to `main` commits
whatever changed in `dist/` back to `main` itself, as `github-actions[bot]`,
with `[skip ci]` (that commit carries `contents: write` and does not
retrigger the workflow -- a `GITHUB_TOKEN`-authored push never does, so
there's no loop to worry about). A pull request only proves the build
*works*; it does not update `dist/` on that branch. So:

- **Do not run `npm run build` to produce a commit, and do not hand-edit
  or commit `dist/` yourself.** Commit the `.mts` source only. `npm run
  build` locally is fine (encouraged, even -- see step 4 above) for
  confirming the file typechecks before you push; just leave the
  resulting `dist/` changes uncommitted afterward (`git checkout dist`).
- **`git pull` before your next commit to this repository.** The bot's
  `dist/` commit lands on `main` shortly after your push and will be
  ahead of you; basing a new commit on a stale `main` risks a conflict
  against a file you were never supposed to touch by hand in the first
  place.
- A `.mts` source change pushed to `main` is not actually live for
  live-tv until **both** the bot's `dist/` commit exists on `main`
  **and** someone presses "Check for updates" on live-tv's own Sources
  page -- see "The import only happens when someone presses the button"
  below. If you're verifying a fix end-to-end, that means checking
  `main`'s commit history for the follow-up `Build dist/ [skip ci]`
  commit before assuming the change reached anyone.

This exactly mirrors how the `stremio-tv-scrapers-web-vod` sibling
repository builds its own `dist/` -- see that repository's `AGENTS.md` if
you need the fuller rationale (submodule-pinned contract typechecking,
version bumps, etc. -- this repository's own `version` field on each
scraper object plays the same role its `package.json` version does
there).

**The import only happens when someone presses the button.** live-tv
does not poll this repository on a schedule or at boot -- once a scraper
is imported it is read from live-tv's own mounted volume at every
subsequent boot, with no further dependency on GitHub being reachable,
until "Check for updates" is pressed again by hand.

## Delivering it

Three ways live-tv accepts a finished scraper (all described in the
template's header -- this is the short version):

- **Import from GitHub, no copying at all.** On the live-tv side:
  Settings > Live TV > Sources > "Import from GitHub", enter this
  repository (`owner/repo`) and -- only if this repository is private --
  an access token; there is no branch field, it always reads `main`. It
  fetches every `.mjs` in `dist/`, validates each one the same way a
  manual drop-in is validated, and writes it in. A LATER re-check of the
  same repository only replaces a scraper already running when the copy in
  `dist/` now has a strictly greater `version` than what is loaded --
  which is the entire reason step 5 above matters. This is the route this
  repository is built around, and the route
  [`scrapers/ntvst.mts`](scrapers/ntvst.mts) actually reaches a live-tv
  deployment by -- live-tv ships with nothing built in (but for the one scraper below), so this is not
  a fallback route for it. (iptv-org, [`scrapers/iptv-org.mts`](scrapers/iptv-org.mts), is the default scraper of live-tv, which fetches its `dist/iptv-org.mjs` from here on first start -- so its `id` and `iptv:` prefix are never renamed, and a `version` bump is what updates running installs.)
- **Drop it in, no rebuild.** Copy `dist/<your-id>.mjs` into the
  `scrapers` directory on that deployment's mounted data volume, then
  either restart the container or use the "Reload sources" action on its
  Settings > Live TV > Sources page. It appears immediately, on by
  default, ranked and checked exactly like any other source. Unlike a
  GitHub import, this always overwrites -- there is no version check,
  because copying a file in by hand is already a deliberate choice.
- **Built into the image.** For someone with that repo open: the `.mts`
  source (not the compiled output) becomes `src/livetv/scrapers/<your-id>.ts`
  there, added to `BUILTIN` in `src/livetv/scrapers.ts`. Needs a rebuild and a
  redeploy on that side; not something to do from here, and not how any
  scraper in this repository is delivered today -- `BUILTIN` is empty in
  live-tv. A scraper delivered this way can never be
  replaced by a GitHub import or a drop-in afterward, on purpose -- both
  routes refuse any id a built-in scraper already claims.

## What "zero further editing" means in practice

If you're an agent working from this file: the deliverable is judged by
whether `dist/<your-id>.mjs` -- the one CI produces after your commit, not
one built by hand -- can be copied straight into a live-tv deployment's
`scrapers` directory and picked up with **no changes at all** on the
other end. That means, before calling the scraper done:

- `npm run build` exits with no errors LOCALLY, using this repo's own
  `tsconfig.json` unmodified -- as a typecheck only. Do not commit the
  `dist/` this produces (see "`dist/` is built by CI, never locally").
- After pushing, CI's own build (same command, clean checkout) also
  succeeds -- check the workflow run, don't just assume a local pass
  means the same thing happened in CI.
- The bot's `Build dist/ [skip ci]` follow-up commit lands on `main` (`git
  pull` and check the log, or check the Actions tab) -- a source commit
  with no matching `dist/` update yet is a repository mid-flight, not yet
  in a state live-tv's importer can use.
- `node dist/<your-id>.mjs` (the CI-built copy, pulled after the bot's
  commit) runs without throwing an import-time error -- a quick sanity
  check that catches, for instance, a top-level await that behaves
  differently once compiled.
- The exported object's shape matches the template's `Scraper` interface
  exactly: `id`, `name`, an OPTIONAL `version`, `build()` -- live-tv's
  loader only accepts a module whose `default` export, or one of its named
  exports, looks like that shape, and silently skips (with a logged reason
  on that side, which you won't see from here) anything that doesn't.
- `version` is set and was bumped if this is a change to an existing
  scraper -- an unbumped version means a later "Import from GitHub" /
  "Check for updates" on the live-tv side sees no update at all and
  silently keeps running the OLD copy, even though `dist/` now holds
  something different.

## Keep `SOURCES.md` current

[SOURCES.md](SOURCES.md) tracks every live-TV/live-sport source considered
for this repository -- implemented, backend-blocked, possible, untriaged or
rejected, with the reason for whichever status applies. Read it before
triaging a new source: a candidate may already be marked rejected (with
why), or noted as probably sharing a backend `ntvst.mts` or `zlive.mts`
already resolved or hit a wall on. Update it in the same commit whenever a
source's status changes -- an agent picking this up next has only this
file and the scrapers themselves to go on, not this session's chat history.
Don't retry a rejected source. Several sources are often one catalogue
behind different fronts (same CDN, same rendition ladder): triage by
backend, not by front-end count, and note which ones share one.

[STRATEGIES.md](STRATEGIES.md) holds the worked-out *techniques* (what to
hook, the recurring envelope/gate shapes, how dead ends looked). Read it
before reverse-engineering anything, and add to it whenever you learn a
technique or confirm a dead end -- it is the how, SOURCES.md the status.

## Check what a source really serves before building it

A URL that plays in ffmpeg on your laptop can still fail on a television
or from the host. Before writing a scraper, with exactly the `referrer`
and `userAgent` you would return, confirm the playlist, a variant and a
segment all fetch, and that a real decode works:

```bash
ffmpeg -v error -rw_timeout 15000000 -user_agent "<browser UA>" \
  -headers "Referer: R\r\n" -f hls -allowed_extensions ALL -extension_picky 0 \
  -i "<url>" -t 8 -f null -
```

- **Don't trust file names or content types.** Playlists often have no
  `.m3u8`, are served as `application/json`/`text/html`, and segments may
  be named `.jpg` or have no extension while being real video. A strict
  client (ffmpeg) needs the flags above; a conforming HLS client copes.
- **A plausible master is not a playable one.** Check a segment: a CDN can
  list fine and 403 every segment (an ad CDN's `domain forbidden`, a
  `bad signature`), serve PNG-prefixed segments (a decoder may carry
  those, see below) or answer an outdated handshake with a looping decoy
  video. A resolver should look at WHAT the address serves.
- **A master's first variant is not always the best**, and widescreen
  streams report heights like 800 or 872, not 1080. Ranking is the host's
  job -- just don't hand it a link that only works for one rendition.
- **Tokens expire and IPs matter.** Resolve at play time (a resolver),
  and remember an address bound to the resolving network (`asn=`, an IP in
  the token) only plays from where it was resolved -- the host's own
  situation, so test there when you can.
- A source that needs something the contract cannot send is `blocked` in
  SOURCES.md, with the host/contract change it would need.

## Reverse-engineering a source that isn't plain JSON or HTML

Most sources are a JSON API or an HTML page you can parse directly. Some
gate their real stream URL behind client-side JavaScript -- WebAssembly,
an obfuscated bundle, a signed/encrypted request body -- and it's tempting
to give up and call the source unscrapable. Don't, until you've actually
tried running the gate rather than reading it. The general principle,
proven on both `ntvst.mts`'s `cdnlive` backend and `zlive.mts`'s
`/resolve` endpoint: **run the site's own code to see what it does, don't
hand-decode an obfuscated bundle line by line.** A modern JS engine
(Node) can execute almost anything a browser can, given the right stubs;
finding which globals it actually touches is far less work than reversing
what a minifier did to the source.

**Before any of that, check the source needs running code at all.** Several
"browser-only" sources were a JSON API behind a click, or had the stream
list inlined in the server-rendered page (Next.js flight data, an inline
`window.x = {...}`). Log the real page's requests and responses first, and
grep the bundle for the endpoint. See STRATEGIES.md for the order of attack
and the full technique list (`crypto.subtle` hooks with stack traces,
`allHeaders()` request logs, Next.js server actions, substitute WASM
instances, splice tests).

### Running an obfuscated bundle in Node to recover a crypto/signing scheme

This is how `zlive.mts`'s AES-GCM envelope was found. The site's channel
list was plain JSON, but resolving a channel's opaque key into a real
stream URL needed a `POST` whose body only the site's own minified JS
could produce -- no amount of reading the string-array-obfuscated source
by hand was going to recover it in reasonable time.

1. **Download the real bundle** (`curl` the `<script src>` the page
   loads) and confirm it's self-contained (no further `import`s of other
   chunks) -- most single-page-app entry bundles are, since a bundler
   inlines everything reachable from the page's own routes.
2. **Load it in `node:vm`** (`vm.createContext` + `vm.runInContext`) with
   browser globals stubbed just enough for it to parse and start running:
   `document`, `window`/`self`/`globalThis` all pointing at the same
   sandbox object, `TextEncoder`/`TextDecoder`, `crypto` (Node's own
   `require("crypto").webcrypto` -- has `.subtle`, unlike a stub object),
   `MutationObserver`/`ResizeObserver`/`IntersectionObserver` as no-op
   classes, `URL`/`URLSearchParams`/`Headers`/`Request`/`Response`/`Blob`
   copied straight from Node's own globals (they exist there already,
   just not inside the fresh `vm` context), and a `fetch` stub that
   **throws an error containing the full request** (url, method, headers,
   body) rather than actually going to the network. Function declarations
   at a script's top level become properties of the sandbox object even
   if the script throws partway through -- but `const`/`let` bindings do
   not, so a function you want to call directly afterward needs to be
   declared with `function`, not assigned as `sk = ...`.
3. **Call the function that builds the request directly**, wrapped in a
   `.catch()` that prints the thrown fetch stub's message -- this is the
   *exact* request the real client would have sent, headers and encrypted
   body included, with no manual reconstruction. Replay it verbatim with
   `curl` (write the body to a file first and use `--data-binary @file`
   -- shell quoting mangles base64's `+`/`/` easily enough to cost you an
   hour chasing a phantom bug) to confirm the server accepts it before
   going any further.
4. **If step 2 throws before reaching the function you need** (a bundled
   React app's own bootstrap trying to `ReactDOM.createRoot(...).render()`
   against a `document.getElementById` that returns `null`, for example),
   either accept the partial failure -- function declarations still
   hoisted, per above, so you may already have what you need -- or reach
   for `jsdom` (`npm install jsdom` in the repo's scratch directory,
   never as a dependency of the shipped scraper) for a real enough DOM
   that the app actually mounts. `jsdom`'s `window.crypto` is a
   **read-only, non-configurable-looking property that a plain assignment
   silently fails to override** -- use
   `Object.defineProperty(window, "crypto", { value: nodeWebcrypto,
   configurable: true })`, not `window.crypto = nodeWebcrypto`, or every
   `crypto.subtle` call inside the app will throw on a real `undefined`
   sub-property while looking like it should have worked.
5. **Once the request goes through, instrument rather than decode** the
   crypto primitives themselves to learn the exact algorithm without
   tracing the obfuscator's string-array indirection by hand at all:
   wrap `crypto.subtle.digest`/`.importKey`/`.encrypt` so each call logs
   its real arguments (the plaintext being hashed, the raw key bytes, the
   IV, the plaintext being encrypted) before delegating to the real
   implementation. This turns "reverse-engineer a signing scheme" into
   "read the log" -- it found `zlive.st`'s exact key derivation (SHA-256
   of a fixed salt plus the current date, used directly as a raw AES-GCM
   key, no HKDF) in one run, where manually decoding the obfuscated
   property-name indirection around it would have taken far longer for
   the same answer.
6. **Port the recovered algorithm into clean, un-obfuscated TypeScript**
   in the shipped scraper -- using Node's real `crypto.webcrypto`
   directly, not the site's own minified functions. By default, never ship
   obfuscated third-party JS, or a `vm`/`jsdom` sandbox, inside a scraper
   that reaches live-tv; those are research-only tools -- not a
   security boundary, and not something a `build()` call should depend on
   at runtime. The one exception is "Running a site's own code (last
   resort, with safeguards)" below, which has its own conditions.

### WASM-gated sources

The same "run it, don't decode it" principle applies to a source that
needs a WebAssembly module (minting an id, deriving a key, decrypting a
payload) to produce its stream URL. This repository has no `BrowserSite`
fallback at all -- `Scraper.build()` only ever returns a URL, so a source
whose gate cannot be made to run outside a real browser is not a slower
version of working, it's unscrapable, full stop. That raises the bar for
trying properly before giving up:

- **Load the `.wasm` directly in Node** with `WebAssembly.instantiate`
  and the site's own JS glue (a `wasm_exec.js`-style shim for Go; a
  thinner one for Rust/AssemblyScript). Stub only the couple of browser
  globals the shim actually touches rather than assuming it needs a real
  DOM -- most modules touch two or three browser APIs and the rest of a
  generic shim template is dead weight.
- **Disassemble the module** (`wasm2wat`/`wabt`, or Chrome DevTools' own
  WASM debugger) when the glue doesn't make the entry point obvious.
  Compare against the JS wrapper that calls it to see which export is
  used and how arguments are encoded (pointer+length into linear memory
  is the common case).
- **Confirm you can reproduce one known input/output pair** (captured
  from a real browser session -- a DevTools breakpoint on the JS
  wrapper, or a patched `console.log`) running the same module in Node
  before trying to understand its internals; then treat the module as a
  black box you invoke rather than something you need to fully
  understand.
- **`instance.exports` is frozen** -- assigning a wrapper into it does
  nothing. To see what an export takes and returns, wrap
  `WebAssembly.instantiate`/`instantiateStreaming` (in a real browser, via
  something like Playwright's `addInitScript`) and hand the page a
  substitute `{ module, instance: { exports: { ...wrappers } } }`
  instead, dumping linear memory at each pointer argument before and
  after the call.
- **Only ever ship zero-import `.wasm`.** Check
  `WebAssembly.Module.imports(module).length === 0` at load time -- such
  a module can only compute, it cannot fingerprint the caller. A module
  with imports into canvas/`navigator`/`localStorage` reads as "needs a
  real browser" until a trace shows they only feed an anti-bot check
  around an otherwise-pure computation (recover the algorithm instead of
  the module: scan linear memory for a key against known ciphertext,
  instrument internal functions by redirecting an existing, unused import
  of matching type to a sentinel logger). Never ship a module with
  imports, native or otherwise -- reimplement what it computes.
- **To see what an export takes and returns, hand the page a substitute
  instance.** `instance.exports` is frozen, so assigning a wrapper into it
  silently does nothing. Wrap `WebAssembly.instantiate`/`instantiateStreaming`
  (Playwright `addInitScript`) and return `{ module, instance: { exports:
  { ...wrappers } } }`, dumping linear memory at each pointer argument
  before and after the call.
- **An import table is not proof a module fingerprints you.** Canvas/
  navigator/`localStorage` imports often only feed anti-bot checks around a
  pure key schedule. Run the module in a Node *research* harness (its own
  glue, stubbed globals, `performance.now()` looking like an old page) until
  it decrypts once, then recover the algorithm: scan linear memory for the
  AES key (every aligned 32-byte window against the ciphertext), instrument
  an internal function (SHA-256 compress, found by its `K[0]` constant) by
  calling an otherwise-unused import of matching type with a sentinel --
  no function index shifts. Rebuild it natively; don't ship a module
  with imports.
- **Isolate missing dependencies one at a time**: if the glue calls
  `libsodium`/`crypto.subtle`/a hash, install the Node equivalent rather
  than polyfilling browser globals generically.
- Record the last attempt's date next to a dead end; a source blocked on
  "needs a browser for WASM" is worth retrying when its bundle changes.
- **When it genuinely can't run standalone** -- it fingerprints its
  environment, needs a real event loop tied to page lifecycle, or checks
  its output against something only the live page can supply -- there is
  no `BrowserSite` to fall back to here. Skip the source (the way
  `ntvst.mts` skips `dlhd` channels) and document exactly what was tried
  and why it didn't work, in the scraper's own docstring, so the next
  attempt doesn't repeat the dead end.

### Running a site's own code (last resort, with safeguards)

Some players seal requests inside a bytecode VM whose key, base path and
CSRF token are constants of one deploy, held only in that bytecode.
Copying one deploy's constants breaks on the next release, and a native
interpreter for a purpose-built VM is not worth writing. For such a
source -- and only after the native routes above (zero-import `.wasm`,
reimplementing the algorithm, a plain JSON API) are shown not to work -- a
scraper may download the site's player code at resolve time and execute
it in a `node:vm` context. The sibling VOD repository's maintainer
accepted this on 2026-10-01 for vidfast (`src/vidfast.mts` there is the
worked example); here, still ask the maintainer before the first
scraper that does it. The rules:

- **`vm` is not a security boundary.** It limits what a rotated bundle can
  reach by accident; it does not contain hostile code. Run only the code
  of the site you are already scraping, never code from a third party it
  loads, and say so in the engine's header comment.
- **Fetch narrowly.** Same-origin scripts of the one site only, a count cap
  and a byte cap per script; refuse everything else. Run each with a
  `timeout`.
- **Whitelist the sandbox.** Build the context from an explicit list of
  host globals (text/URL/timer/crypto basics); never expose `process`,
  `require`, `module`, `fs`, the real `console`, or a main-realm object
  that hands its `Function` constructor to the code. The sandbox's
  `fetch` resolves against the site's origin and **rejects every other
  host**.
- **Locate by shape, never by name.** Minified identifiers change every
  deploy: find entry points with `indexOf` on stable anchors (an
  object-literal key sequence, a string literal) plus small regexes on a
  short slice -- not a regex over a multi-megabyte module (that took 17 s).
  Return empty the moment a shape is missing; never throw, never guess.
- **Serialize and cache.** Player code keeps module-level state, so run
  one resolve at a time (a promise queue). Cache the built runtime per
  script-URL set (the deploy) for a few hours; fetch short-lived tokens
  fresh every time.
- **Stub the browser honestly.** Pass its anti-automation checks only by
  presenting a normal browser surface (no `webdriver`, native-looking
  functions, `window.crypto`, `parent.postMessage`, a silent console); do
  not patch the site's checks themselves.
- **Treat output as untrusted.** Use only `http(s)` URLs from it, and
  verify them like any other result (fetch the playlist, a segment).
- **Document the exit** in the scraper's docstring: what the code does,
  how each entry point is found, and what would make it return empty, so a
  failure after a redesign is quick to diagnose.

### Getting past Cloudflare/Turnstile with FlareSolverr, for research only

A source sitting behind a Cloudflare challenge is worth checking the same
way: [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) runs a
real, patched browser behind a small HTTP API and hands back cleared
cookies (`cf_clearance` etc.), the User-Agent it solved with, and the
page body. Run it once (`docker run -p 8191:8191
ghcr.io/flaresolverr/flaresolverr`) and `POST http://localhost:8191/v1`
with `{"cmd":"request.get","url":"...","maxTimeout":60000}` against
whichever host actually holds the challenge (the HTML page, or the API
host directly, if the challenge sits there instead). Use the returned
cookies and User-Agent for your own research fetches -- finding the real
stream endpoint, confirming it's reachable -- exactly as you would a
captured browser session.

This is a research tool for finding the recipe, never something a shipped
scraper depends on at request time: a source whose *stream itself* (not
just the page that reveals it) needs `cf_clearance` to keep working is
unscrapable here regardless of how it was found. `ScrapedStream.headers`
(live-tv 1.9.0) can carry a `Cookie` now, but `cf_clearance` is
short-lived and tied to the solving IP/UA pair -- it will not survive being
solved in one place (a FlareSolverr on your laptop) and used from the
host's own IP, and the host runs no FlareSolverr.

If only the API/HTML is Cloudflare-gated but the resulting stream URLs
are cookie-free (a signed URL, a token in the query string), it ships
normally -- FlareSolverr was only needed to find the recipe.

**Permission:** you may bypass a Turnstile/Cloudflare challenge to reach a
source whose *content itself* is gated for reasons beyond bot detection
(paywalls, sign-in-walled lists) -- but FlareSolverr is for the challenge
page only, not for defeating access controls the site owner put up for
other reasons.

**Stock headless Chromium is not FlareSolverr.** A simple/legacy JS
challenge, or a site that only *looks* Cloudflare-branded, clears with
plain Playwright in a second or two; a real managed challenge or Turnstile
does not clear at any timeout (it fingerprints CDP/`navigator.webdriver`;
only a patched browser build gets through, and downloading one is out of
scope). A different proof-of-work gate (Anubis) can look transiently
cleared before it finishes -- confirm the real page loaded before trusting
a "cleared" result from a non-Cloudflare gate.

### What this scraper contract cannot do -- recognise a dead end early

Before sinking hours into a source, check whether solving it would even
produce something `Scraper.build()` can return. The contract
(`template/scraper-template.mts`) is a **URL plus `referrer`, `userAgent`
and (live-tv 1.9.0) a static `headers` record**, sent on every request the
stream makes -- the playlist, variants, segments and keys. No per-request
signing, no ongoing network access in a decoder. That rules out, and is
worth recognising *before* spending a research session on:

- **A source needing a cookie, custom header, or signed request repeated
  on every segment fetch**, not just the initial playlist. `ntv.st`'s
  `dlhd` backend is the worked example: the playlist URL itself resolves
  in the clear with plain HTTP, but every segment it lists is a real PNG
  with the actual video steganographically hidden in its pixel data,
  requiring a decode step per segment, forever, for a live stream. There
  is nowhere in this contract to run an ongoing transform -- it would
  need a proxy sitting in front of the CDN, which is a host-level
  capability, not something a scraper can provide. Recognising this
  shape early (one-time gate vs. a gate that repeats on every request the
  player itself makes) saves the time `dlhd` cost before it was
  correctly re-diagnosed as an architectural limit rather than an
  unsolved cracking problem (see `ntvst.mts`'s docstring for the full
  history).
- **Headers and cookies: possible, but only STATIC ones.** (live-tv
  1.9.0.) `ScrapedStream.headers` (and a resolver's `ResolvedStream.headers`,
  which replaces them) is any record of request headers -- `Origin`, a token
  header, `Cookie` -- sent on every request. Names are free; the host refuses
  only what would break the request (`Host`, `Content-Length`,
  `Accept-Encoding`, `Range`, `User-Agent`/`Referer` which have their own
  fields). `Cookie` and `Authorization` go only to the host the stream's own
  address is on, never to a CDN a playlist merely names, and not along a
  redirect to another host; ClearKey streams get neither. The TV is not
  involved at all -- the host's relay fetches everything. What stays
  impossible: a header that must differ on every request (a signed request
  per segment). A per-play session cookie is a resolver's job: it runs on the
  host's own IP, so an IP-bound session matches the IP that plays.
- **A CDN that 403s Node's TLS handshake.** The giveaway: the same URL gives
  200 to curl/ffmpeg/a browser and 403 to Node however you set the headers.
  The host retries such a 403 at TLS 1.2 (live-tv 1.10.0, `fetchvia.ts`), which
  is what the Streamed CDN wants (`streamed.mts`). Your own `fetch` calls
  inside a scraper do NOT get this fallback: test them from Node, not from curl.
- **A source that behaves differently by caller IP.** A resolve that
  works from a laptop can legitimately return nothing (or a different
  provider entirely) from live-tv's own server -- the sibling
  `stremio-tv-scrapers-web-vod` repository has seen sites pick a CDN
  provider by the caller's address (see its AGENTS.md, "The same site can
  serve a different player depending on the caller's IP"). If a scraper
  that resolves cleanly in research returns nothing once actually
  deployed, suspect this before suspecting the algorithm.

### Geoblocks: working around them is allowed

Working around a geoblock is explicitly permitted, on any source, without
asking the maintainer first. A source that refuses your address by country (a region-locked API, a
`geo`/`country` check, a CDN that 403s outside one market) is not a dead
end by itself. You may work around it, both while researching a source and inside the
shipped scraper, as described below:

- Reach it from the right country through a VPN, a SOCKS/HTTP proxy, or a
  remote shell on a host there; or send the country hint the site's own
  client sends (an `X-Forwarded-For`/`CF-IPCountry`-style header, a
  `?country=` or market parameter, a region cookie). Use DoH for a
  DNS-level block (see "Check what a source really serves").
- A shipped scraper may carry and use proxies, including credentials for
  a proxy the maintainer supplies (read them from the scraper's
  `configSchema`, never hard-code a secret in the source).

#### Proxy pools: fetched and tested by the scraper itself

When a source is geoblocked, the scraper may keep its own country-specific
pool of working proxies and use it for its own requests (`build()`,
`buildEvents()`, a resolver's handshake):

- **Fetch** candidate lists for the needed country at the start of each
  run (the nightly/channels job is the natural place), from public proxy
  lists or the maintainer's configured provider. Treat a list as untrusted
  data: accept only `http(s)`/`socks` `host:port` entries.
- **Test every candidate** against the real source, not a generic
  "is it up" URL: the request that was blocked must now succeed, return
  the expected shape, and finish within a latency budget. Time it, drop
  the slow, and keep only the fastest few (a small pool, e.g. 3-5, ranked
  by latency). Test in parallel with a concurrency cap and a per-proxy
  timeout so a bad list cannot stall the job past the host's time limit.
- **Refresh with each run**: re-test the kept proxies, drop any that now
  fail or got slow, top up from a fresh list, and cache the pool at
  module level for the calls in between. If no proxy passes, return empty
  (or last good data) rather than throw.
- **Never trust the proxy with more than the fetch needs**: send no
  account cookies or secrets through a public proxy, and verify what
  comes back as for any other result.
- **A proxy cannot carry the stream.** `ScrapedStream` is a URL plus
  static headers, and the host's relay fetches the playlist and segments
  from the host's own IP; the contract has no per-stream proxy field.
  So a proxy fixes a geoblock on the scraping/resolving step only. If the
  stream URLs themselves are blocked or IP-bound, the source needs the
  host in that country (case 3 below), and a proxy pool does not change
  that; a per-stream proxy would be a contract change that starts in
  live-tv (see "Updating the template").

What decides whether the source is deliverable is **the host's own IP**,
not yours. After working around the block, test the final result the way
the host will see it:

1. **Block lifted by a parameter or header the scraper can send itself**
   (a market code, a cookie, an `Origin`): ship it normally, state the
   parameter in the docstring, and confirm the playlist and a segment
   still play without the workaround on the stream itself.
2. **Block on the resolve only, stream URLs are open once resolved**
   (signed URL with no IP binding): research through the proxy, ship the
   scraper to fetch the same way from the host. Mark it in SOURCES.md as
   "geoblocked, host must be in <country>" so a deployment elsewhere knows
   why it returns nothing, and have `build()` return empty rather than
   throw when the block answers.
3. **Block on the stream/CDN by IP, or the token is bound to the resolving
   IP** (`asn=`, an IP in the token): it plays only from that country.
   Deliver it only if the host runs there; otherwise it is `blocked` in
   SOURCES.md, naming the country and what the host would need.

Record in STRATEGIES.md how the block showed itself (status code, body,
the header it keyed on) and in SOURCES.md which country the source needs,
with the date you last tried; a source that was open from one country is
worth retrying from a second before calling it dead.

### Stream resolvers: for an address that cannot be written down ahead of time

If a source's playable URL is signed and expires, is bound to the caller, or
comes out of a handshake that must be repeated, do not resolve it in
`build()`. Give each stream a stable HANDLE as its `url`
(`https://<scraper id>.invalid/<key>`), set `resolver: "<name>"`, and export
`resolvers: { <name>: async (handle) => ({ url, referrer?, userAgent? }) }`.
The host calls it whenever it checks, probes or plays the channel, and never
fetches the handle itself (see `AGENTS.md` in the live-tv repo,
"A stream can be a handle: resolving at the moment of use"). `zlive.mts` is the worked example: it also
shows why a resolver should look at WHAT the address serves -- zlive answers
an outdated handshake with a looping decoy video instead of an error, which
passes every "is it a playlist / does it serve bytes" check.

Needs live-tv 1.6.0; an older one drops resolver streams rather than
offering a handle.

### Segment decoders: the one ongoing transform the contract CAN carry

A stream may name a `decoder` from its scraper's own `decoders` map (see the
template; every live-tv has it). The host's relay relays every request of such a stream -- playlist, variants,
segments, keys -- and runs the decoder on each segment. This is exactly
what `dlhd` needed (the bullet above describes the problem as it stood):
`scrapers/dlhd.mts` is the worked example. Two consequences worth knowing:

- `referrer` and `userAgent` are now sent on every segment too, not only
  on the playlist -- the relay once sent them on the playlist only, so a
  Referer-locked CDN passed the checks and failed on the television.
- A decoder is pure computation over bytes, run on the server for every
  segment of every viewer. It still cannot add a cookie, sign each
  request, or talk to the network; those remain dead ends here.

## Updating the template -- and contract changes start in live-tv

`ScrapedStream`, `ScrapedChannel` and the rest of the scraper contract are
defined in the [`live-tv`](https://github.com/gauravsuman007/live-tv) repository
(`src/livetv/scraper-types.ts`, copied byte-identical to
`docs/scraper-template.ts` there), and this repo's
`template/scraper-template.mts` is a richer copy of them (same interfaces,
minus `export`, plus the worked-example code). They must change together; a
contract field the host does not know is silently ignored, so the stream plays
as something it is not.

**Whenever a session here needs a contract change -- a new `ScrapedStream`
field, a new hook -- it is not done until the host side is too (what to do
with the field, when to refuse it, a test), because a field the host ignores
is worse than none.** Design and implement it in live-tv first, bump its
version (`package.json` AND `src/livetv/plugin.ts` together), copy
`scraper-types.ts` over `docs/scraper-template.ts` there, then mirror the
interface change in this template and say in the field's doc comment which
live-tv version introduced it. A feature that cannot work on an older live-tv
should be dropped by the host rather than offered broken (live-tv's AGENTS.md
has a section for each feature; read it before changing the field).

Contract changes so far: `decoder` (every live-tv), `resolver` (live-tv
1.6.0), `clearKey` (1.8.0, below), `logos` (1.8.0: an optional pair of image
URLs for one card, drawn side by side; give both sides' flags for a fixture
and keep `logo` = the first), `headers` (1.9.0; see "What this scraper
contract cannot do"), and the TLS 1.2 retry for a CDN that 403s Node's
handshake (1.10.0, host behaviour, no field). Diff the template against
live-tv's `docs/scraper-template.ts` when you start, since nothing enforces
the copies staying in step.

### ClearKey: encrypted DASH is deliverable now

`ScrapedStream.clearKey = { kid, key }` (32 hex characters each) with `url` set
to a DASH `.mpd` encrypted with Common Encryption. The HOST runs ffmpeg
(`-cenc_decryption_key`, copy, no re-encode) and serves ordinary HLS through
its relay, so the television never sees DASH or a key. `referrer`/`userAgent`
apply to the manifest and every segment. Rules for a scraper:

- Only ClearKey. Widevine/PlayReady/FairPlay are not, and nothing here
  handles them; leave those streams out.
- One key pair must open every track. Per-track keys cannot be expressed.
- Do not combine with `decoder`. A `resolver` may return `clearKey` itself.
- Needs live-tv 1.8.0 and an ffmpeg on the host; otherwise the host drops
  the stream. The host checks it only as far as the manifest, so a wrong key
  shows up as a picture that never appears -- test against the live stream
  (cricweb.mts and a real `liveFetch` did, see its header).
- Keys on these sites are usually JSON constants in a Shaka player page
  (`const DRM_KEY = "..."`): parse them, never evaluate the page.

Before this, a source that restreamed DRM-protected video with a published
ClearKey was unscrapable here (cricweb's `drm/player.php` family, 20 of its 45
fixture sources). A ClearKey stream is now just a stream; a Widevine,
PlayReady or FairPlay one still cannot be delivered by anything in this chain.


## Live events: compute the key here, the host only compares it

The host (live-tv) knows no sport and no team. Whether "Canada vs Peru" and
"Peru v. Canada" are one match is YOUR scraper's job, and you state it in
`ScrapedChannel.event.key` (see `ScrapedEvent` in the template). Every events
scraper carries the same `event-key` block between `// BEGIN event-key` and
`// END event-key` markers -- scrapers are standalone files and cannot import
one another, so it is copied. **Edit `scripts/event-key.block.ts`, then run
`node scripts/sync-event-key.mjs`** (`npm test` fails when a copy differs, and
runs `test/event-key.mts`, which holds the rules: aliases, "FC", rankings, "(w)",
accents, "v." and "@", and everything that must NOT merge). A new events scraper
starts from `template/scraper-template.mts`, which already carries the block
(the sync script keeps the template's copy current too) and a worked
`buildEvents()`; to add events to an existing scraper, copy the two marker lines
in and run the sync. `eventFor(title, { sides?, competition?, sport?, start? })`
returns the display name (the sides joined with " vs ") and the `event` object.

### Checklist for a new scraper that lists live events

1. Copy the template; set `SCRAPER_ID`; keep the `event-key` block and
   `buildEvents`, drop `build()`'s body to `{ channels: [] }` if the source has
   no channel list. Never edit the block in the scraper.
2. For each event, give `eventFor` what the source knows: `sides` when the teams
   are separate fields (do not parse a title if you do not have to), `competition`,
   `sport`, and `start` in epoch **milliseconds** (never 0, never seconds; leave
   it out when unknown -- the host only separates two cards by start when both
   have one, more than 8 hours apart).
3. Name the card `described.name`, put `described.event` on the channel, and add
   every mirror as a stream of that one card. Do not de-duplicate your own list.
   Do not put the competition, round, flag or "HD" in the name.
4. Rail: heading exactly `Live Events` (so all sources share one rail), group
   `Live events`; optional per-sport rails as `Live <Sport>`.
5. Declare `eventsIntervalMinutes` (and `channelsIntervalMinutes` if there are
   channels) in `configSchema`; the host reads them for the two jobs.
6. Dedup quality is measured, not assumed: add the source's awkward spellings to
   `test/event-key.mts` as cases (one merge case, one must-not-merge case) and
   fix them in `scripts/event-key.block.ts`, never in your scraper. A team the
   source writes shorter or differently is an alias (`EVENT_ALIASES`); a side
   that must never merge with its namesake (women, youth, reserves) is a marker.
7. Bump `version`, `npm test`, `npm run build`; CI builds `dist/`. Do not commit it.
8. After deploy, check the Sources page shows the two jobs, and that events from
   your source merge with another source's card rather than sitting beside it.

## Two jobs: `build()` is the channels, `buildEvents()` the live events

A scraper whose events change by the minute while its channels change by the
day exports `buildEvents` and gives `build()` the channels only; live-tv runs
them as separate jobs with their own schedules (`channelsIntervalMinutes` /
`eventsIntervalMinutes` in your `configSchema`, else 12 h / 15 min), buttons and
status. Both are called with `{ config }`. `tasks` and module-level caches are no
longer needed for this: a scraper that used them to refresh the two halves apart
(ntvst, dlhd, ...) now just returns fresh data from each function. A source that
is all events returns `{ channels: [] }` from `build()`. If a long crawl can outlive
the host's time limit (ntvst), keep it single-flight so the next call joins it.
