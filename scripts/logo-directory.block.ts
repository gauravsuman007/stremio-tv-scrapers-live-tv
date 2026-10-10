// BEGIN logo-directory -- identical in every scraper that fills in missing logos. scripts/sync-blocks.mjs keeps the copies in step.

/*
    A SOURCE THAT HAS NO LOGO FOR A CHANNEL BORROWS ONE FROM IPTV-ORG'S
    DIRECTORY, by name. The directory is iptv-org's public `channels.json`
    (name, alternate names, country) joined to `logos.json`; it is held for the
    life of the process and fetched once. Two rules, both about not putting the
    wrong logo on a channel:
      1. the same folded name (or alternate name) in the SAME country;
      2. failing that, a name of five characters or more that every
         directory channel of that name gives ONE logo for, in any country.
    Nothing is borrowed for a name the directory does not know, and a logo the
    source already supplied is kept unless `dead` says its host is gone.

    MEMORY: the directory is ~12 MB of strings, and nine scrapers carry this
    block. It used to be held per scraper for the life of the process (over
    100 MB once they had all run). Now it is ONE copy per process, shared
    through `globalThis` (every scraper in the host sees the same global),
    fetched by whichever scraper asks first, and dropped ten minutes after
    the last `fillLogos` -- the scrapers all run in the same nightly window,
    so they still share one fetch.
*/
interface LogoDirectory {
    byCountry: Map<string, string>;
    byName: Map<string, Set<string>>;
}

const LOGO_API = "https://iptv-org.github.io/api";
const LOGO_DIRECTORY_IDLE_MS = 10 * 60_000;
const logoShared = ((globalThis as Record<symbol, unknown>)[Symbol.for("live-tv.logo-directory")] ||= {
    directory: null,
    timer: null
}) as { directory: Promise<LogoDirectory | null> | null; timer: ReturnType<typeof setTimeout> | null };

function foldLogoName(name: string): string {
    return name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/^\s*(?:\[[^\]]{1,6}\]\s*)+/, "")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/\b(hd\+?|fhd|uhd|sd|4k|hevc|raw|backup|feed|\d{3,4}p)\b/g, "")
        .replace(/[^a-z0-9]+/g, "");
}

async function loadLogoDirectory(): Promise<LogoDirectory | null> {
    try {
        const get = async (file: string): Promise<unknown[]> => {
            const response = await fetch(`${LOGO_API}/${file}.json`, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(`${file}.json -> ${response.status}`);
            return (await response.json()) as unknown[];
        };
        const [channels, logos] = (await Promise.all([get("channels"), get("logos")])) as [
            Array<{ id?: string; name?: string; alt_names?: string[]; country?: string }>,
            Array<{ channel?: string; url?: string; width?: number; format?: string }>
        ];
        /* The biggest raster logo per channel; a vector only when there is nothing else (a panel cannot sniff SVG). */
        const best = new Map<string, { url: string; width: number; vector: boolean }>();

        for (const logo of logos) {
            if (!logo.channel || !logo.url) continue;
            const candidate = { url: logo.url, width: logo.width || 0, vector: /svg/i.test(logo.format || "") };
            const held = best.get(logo.channel);
            if (!held || (held.vector && !candidate.vector) || (held.vector === candidate.vector && candidate.width > held.width)) best.set(logo.channel, candidate);
        }

        const directory: LogoDirectory = { byCountry: new Map(), byName: new Map() };

        for (const channel of channels) {
            const logo = channel.id ? best.get(channel.id) : undefined;
            if (!logo) continue;

            for (const name of [channel.name || "", ...(channel.alt_names || [])]) {
                const folded = foldLogoName(name);
                if (folded.length < 3) continue;
                directory.byCountry.set(`${folded}|${(channel.country || "").toUpperCase()}`, logo.url);
                (directory.byName.get(folded) || directory.byName.set(folded, new Set()).get(folded)!).add(logo.url);
            }
        }

        return directory;
    } catch (cause) {
        console.error("logo directory unavailable:", cause);
        logoShared.directory = null;
        return null;
    }
}

/** Fills `logo` on channels that have none (or whose own is `dead`). Never throws; returns how many it filled. */
async function fillLogos(channels: Array<{ name: string; country: string; logo: string }>, dead?: (logo: string) => boolean): Promise<number> {
    if (logoShared.timer) clearTimeout(logoShared.timer);
    const directory = await (logoShared.directory ||= loadLogoDirectory());
    logoShared.timer = setTimeout(() => {
        logoShared.directory = null;
        logoShared.timer = null;
    }, LOGO_DIRECTORY_IDLE_MS);
    logoShared.timer.unref?.();
    if (!directory) return 0;
    let filled = 0;

    for (const channel of channels) {
        if (channel.logo && !(dead && dead(channel.logo))) continue;

        const folded = foldLogoName(channel.name);
        if (folded.length < 3) continue;

        const country = (channel.country || "").toUpperCase().replace(/^UK$/, "GB");
        const own = country ? directory.byCountry.get(`${folded}|${country}`) || (country === "GB" ? directory.byCountry.get(`${folded}|UK`) : undefined) : undefined;
        const names = directory.byName.get(folded);
        const found = own || (names && names.size === 1 && folded.length >= 5 ? [...names][0] : undefined);

        if (found) {
            channel.logo = found;
            filled += 1;
        }
    }

    return filled;
}

// END logo-directory
