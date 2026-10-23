// -----------------------------------------------------------------------------
// Labels of the catalog voices, shared by the manifest (the `voice` select of
// the Configuration screen), the voice demo page and the status messages.
//
// The Gladys configuration form only takes STATIC select options, declared in
// the manifest: scripts/sync-voices.mjs writes them from the voice catalog with
// these helpers, and test/manifest.test.js checks both stay in sync.
// -----------------------------------------------------------------------------

// Values of the `voice` select that are not catalog voice ids (those are
// 16-character Gradium ids, they cannot collide).
export const VOICE_DEFAULT = 'default';
export const VOICE_CUSTOM = 'custom';

// First and last options of the `voice` select, around the catalog voices.
export const DEFAULT_VOICE_OPTION = {
  value: VOICE_DEFAULT,
  label: { en: "Model's default voice", fr: 'Voix par défaut du modèle' },
};
export const CUSTOM_VOICE_OPTION = {
  value: VOICE_CUSTOM,
  label: {
    en: 'Custom voice (Gradium Studio, see below)',
    fr: 'Voix personnalisée (Gradium Studio, voir ci-dessous)',
  },
};

// Order of the languages in the voice list (then locale, then name).
export const LANGUAGE_ORDER = ['fr', 'en', 'de', 'es', 'pt'];

const LANGUAGES = {
  fr: { en: 'French', fr: 'Français' },
  en: { en: 'English', fr: 'Anglais' },
  de: { en: 'German', fr: 'Allemand' },
  es: { en: 'Spanish', fr: 'Espagnol' },
  pt: { en: 'Portuguese', fr: 'Portugais' },
};

const REGIONS = {
  'fr-fr': { en: 'France', fr: 'France' },
  'en-us': { en: 'US', fr: 'États-Unis' },
  'en-gb': { en: 'UK', fr: 'Royaume-Uni' },
  'de-de': { en: 'Germany', fr: 'Allemagne' },
  'es-es': { en: 'Spain', fr: 'Espagne' },
  'es-mx': { en: 'Mexico', fr: 'Mexique' },
  'pt-br': { en: 'Brazil', fr: 'Brésil' },
};

const GENDERS = {
  female: { en: 'female', fr: 'femme' },
  male: { en: 'male', fr: 'homme' },
};

const AGES = {
  Young: { en: 'young', fr: 'jeune' },
  'Young Adult': { en: 'young adult', fr: 'jeune adulte' },
  Adult: { en: 'adult', fr: 'adulte' },
  'Middle-age': { en: 'middle-aged', fr: "d'âge mûr" },
  'Older Adult': { en: 'senior', fr: 'senior' },
};

// Catalog entries whose locale is not a region but a family of voices.
const CHARACTER_LOCALE = 'characters';
const CHARACTER = { en: 'character', fr: 'personnage' };

/**
 * Name of a language in the UI languages of Gladys (en, fr).
 * @param {string} language - ISO 639-1 code (fr, en, de, es, pt).
 * @returns {{ en: string, fr: string }}
 */
export function languageName(language) {
  return LANGUAGES[language] ?? { en: language, fr: language };
}

/**
 * Label of a catalog voice in the `voice` select, e.g.
 * `{ en: 'French (France) · Noémie — female, young', fr: 'Français (France) · Noémie — femme, jeune' }`.
 * @param {{ name: string, language: string, locale?: string|null, gender?: string|null, age?: string|null }} voice
 * @returns {{ en: string, fr: string }}
 */
export function voiceLabel(voice) {
  const label = {};
  for (const lang of ['en', 'fr']) {
    const language = languageName(voice.language)[lang];
    if (voice.locale === CHARACTER_LOCALE) {
      label[lang] = `${language} · ${voice.name} — ${CHARACTER[lang]}`;
      continue;
    }
    const region = REGIONS[voice.locale]?.[lang];
    const traits = [GENDERS[voice.gender]?.[lang], AGES[voice.age]?.[lang]].filter(Boolean);
    label[lang] =
      `${language}${region ? ` (${region})` : ''} · ${voice.name}` +
      (traits.length > 0 ? ` — ${traits.join(', ')}` : '');
  }
  return label;
}

/**
 * Short tags of a voice for the demo page: language and region, then gender
 * and age (or "character").
 * @param {{ language: string, locale?: string|null, gender?: string|null, age?: string|null }} voice
 * @returns {{ en: string[], fr: string[] }}
 */
export function voiceTags(voice) {
  const tags = {};
  for (const lang of ['en', 'fr']) {
    const region = REGIONS[voice.locale]?.[lang];
    const language = `${languageName(voice.language)[lang]}${region ? ` (${region})` : ''}`;
    tags[lang] =
      voice.locale === CHARACTER_LOCALE
        ? [language, CHARACTER[lang]]
        : [language, GENDERS[voice.gender]?.[lang], AGES[voice.age]?.[lang]].filter(Boolean);
  }
  return tags;
}

/**
 * Every option of the `voice` select: the model's default voice, the catalog
 * voices in list order, then the custom voice.
 * @param {Array} catalogVoices - `voices` of src/voices.catalog.json (already sorted).
 * @returns {Array<{ value: string, label: { en: string, fr: string } }>}
 */
export function voiceOptions(catalogVoices) {
  return [
    DEFAULT_VOICE_OPTION,
    ...catalogVoices.map((voice) => ({ value: voice.voice_id, label: voiceLabel(voice) })),
    CUSTOM_VOICE_OPTION,
  ];
}

/**
 * Sort catalog voices the way the select lists them: language (LANGUAGE_ORDER),
 * then locale, then name.
 * @param {Array<{ name: string, language: string, locale?: string|null }>} voices
 * @returns {Array} A sorted copy.
 */
export function sortVoices(voices) {
  const rank = (language) => {
    const index = LANGUAGE_ORDER.indexOf(language);
    return index === -1 ? LANGUAGE_ORDER.length : index;
  };
  return [...voices].sort(
    (a, b) =>
      rank(a.language) - rank(b.language) ||
      (a.locale ?? '').localeCompare(b.locale ?? '') ||
      a.name.localeCompare(b.name, 'fr'),
  );
}
