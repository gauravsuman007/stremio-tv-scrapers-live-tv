// BEGIN stream-language
// The language of a mirror's commentary, as the ISO 639-1 code `ScrapedStream.language`
// wants, from whatever text the source gives for it: a language field ("English", "de"),
// or a broadcaster's name ("Sky Sport Uno IT", "DAZN2 DE", "TF1 France"). "" when the text
// does not say, and it must stay "" rather than guess: a wrong tag ranks a feed in front of
// the one the viewer asked for. Countries that speak several languages (Belgium, Canada,
// Switzerland, India, Spain's regions) are left out on purpose. Edit
// `scripts/stream-language.block.ts`, never a scraper's copy; `npm test` checks the copies.
const LANGUAGE_WORD_CODES: Record<string, string> = {
    english: "en", hindi: "hi", german: "de", deutsch: "de", spanish: "es", espanol: "es", french: "fr", francais: "fr",
    italian: "it", italiano: "it", portuguese: "pt", portugues: "pt", dutch: "nl", nederlands: "nl", arabic: "ar",
    russian: "ru", turkish: "tr", polish: "pl", polski: "pl", tamil: "ta", telugu: "te", bengali: "bn", urdu: "ur",
    greek: "el", serbian: "sr", croatian: "hr", romanian: "ro", hungarian: "hu", bulgarian: "bg", czech: "cs",
    swedish: "sv", danish: "da", norwegian: "no", finnish: "fi", hebrew: "he", ukrainian: "uk", persian: "fa",
    japanese: "ja", korean: "ko", chinese: "zh", indonesian: "id", thai: "th", vietnamese: "vi"
};
// Whole words of a name that tell the country (and so the one language its broadcasters use).
const LANGUAGE_COUNTRY_WORDS: Record<string, string> = {
    uk: "en", usa: "en", us: "en", australia: "en", ireland: "en", germany: "de", austria: "de", de: "de", italy: "it", it: "it",
    france: "fr", fr: "fr", portugal: "pt", brazil: "pt", br: "pt", netherlands: "nl", nl: "nl", poland: "pl", turkey: "tr",
    russia: "ru", greece: "el", cyprus: "el", serbia: "sr", croatia: "hr", romania: "ro", hungary: "hu", bulgaria: "bg",
    denmark: "da", sweden: "sv", norway: "no", finland: "fi", israel: "he", ukraine: "uk", argentina: "es", mexico: "es",
    colombia: "es", chile: "es", mena: "ar", egypt: "ar", arabia: "ar", czechia: "cs"
};
const LANGUAGE_SHORT_CODES = new Set(["en", "hi", "de", "es", "fr", "it", "pt", "nl", "ar", "ru", "tr", "pl", "ta", "te", "bn", "ur", "el", "sr", "hr", "ro", "hu", "bg", "cs", "sv", "da", "no", "fi", "he", "uk", "fa", "ja", "ko", "zh", "id", "th", "vi"]);

function languageOf(...texts: Array<string | undefined>): string {
    for (const text of texts) {
        const raw = (text || "").trim();

        if (!raw) continue;

        if (/^[A-Za-z]{2}([-_][A-Za-z]{2})?$/.test(raw)) {
            const code = raw.slice(0, 2).toLowerCase();

            if (LANGUAGE_SHORT_CODES.has(code)) return code;
        }

        const words = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^A-Za-z]+/).filter(Boolean);

        for (const word of words) {
            const named = LANGUAGE_WORD_CODES[word.toLowerCase()];

            if (named) return named;
        }

        // A country word counts when it is the LAST word that names one ("Sport TV2 Portugal"), and
        // two-letter ones only in capitals, so the English word "it" or "us" is not a country.
        let country = "";

        for (const word of words) {
            const found = LANGUAGE_COUNTRY_WORDS[word.toLowerCase()];

            if (found && (word.length > 2 || word === word.toUpperCase())) country = found;
        }

        if (country) return country;
    }

    return "";
}
// END stream-language
