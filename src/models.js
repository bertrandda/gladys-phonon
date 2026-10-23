// -----------------------------------------------------------------------------
// The Phonon checkpoints the integration offers (Hugging Face repos of Gradium).
//
// The 40m models are gated: their files download only with the token of an
// account that accepted their terms (approval is automatic). The 31m English
// model is public. A model keeps its id forever: it is the value stored in the
// `model` field of the configuration (see the manifest).
// -----------------------------------------------------------------------------

export const SUPPORTED_LANGUAGES = ['fr', 'en', 'de', 'es', 'pt'];

const NC = 'CC BY-NC 4.0';

export const MODELS = [
  {
    id: 'phonon-40m-fr',
    repo: 'gradium/phonon-40m-fr',
    label: 'Phonon 40m · Français',
    languages: ['fr'],
    license: NC,
    gated: true,
  },
  {
    id: 'phonon-40m-en',
    repo: 'gradium/phonon-40m-en',
    label: 'Phonon 40m · English',
    languages: ['en'],
    license: NC,
    gated: true,
  },
  {
    id: 'phonon-40m-de',
    repo: 'gradium/phonon-40m-de',
    label: 'Phonon 40m · Deutsch',
    languages: ['de'],
    license: NC,
    gated: true,
  },
  {
    id: 'phonon-40m-es',
    repo: 'gradium/phonon-40m-es',
    label: 'Phonon 40m · Español',
    languages: ['es'],
    license: NC,
    gated: true,
  },
  {
    id: 'phonon-40m-pt',
    repo: 'gradium/phonon-40m-pt',
    label: 'Phonon 40m · Português',
    languages: ['pt'],
    license: NC,
    gated: true,
  },
  {
    id: 'phonon-40m-multilingual',
    repo: 'gradium/phonon-40m-multilingual',
    label: 'Phonon 40m · Multilingual',
    languages: SUPPORTED_LANGUAGES,
    license: NC,
    gated: true,
  },
  {
    id: 'phonon-31m-en',
    repo: 'gradium/phonon-31m-en',
    label: 'Phonon 31m · English',
    languages: ['en'],
    license: 'Apache 2.0',
    gated: false,
  },
];

/**
 * @param {string} id - Model id.
 * @returns {object|undefined} The model, or undefined for an unknown id.
 */
export function findModel(id) {
  return MODELS.find((model) => model.id === id);
}

/**
 * The two-letter language of a Gladys language tag: `fr-FR` -> `fr`.
 * @param {string|null|undefined} language
 * @returns {string|null}
 */
export function normalizeLanguage(language) {
  if (typeof language !== 'string' || language.trim() === '') {
    return null;
  }
  return language.trim().slice(0, 2).toLowerCase();
}

/**
 * The model and normalization language the configuration asks for.
 * @param {{ model?: string|null, language?: string|null }} config - Normalized config.
 * @returns {{ model: object, lang: string } | { error: { en: string, fr: string } } | null}
 *   `null` while no model is selected (the integration stays unusable).
 */
export function resolveModel(config) {
  if (!config.model) {
    return null;
  }
  const model = findModel(config.model);
  if (!model) {
    return {
      error: {
        en: `Unknown model "${config.model}": choose a model again in the configuration.`,
        fr: `Modèle inconnu « ${config.model} » : choisissez de nouveau un modèle dans la configuration.`,
      },
    };
  }
  if (model.languages.length === 1) {
    return { model, lang: model.languages[0] };
  }
  const lang = normalizeLanguage(config.language);
  if (!lang || !model.languages.includes(lang)) {
    return {
      error: {
        en: 'The multilingual model needs a language: choose one in the configuration.',
        fr: 'Le modèle multilingue a besoin d’une langue : choisissez-en une dans la configuration.',
      },
    };
  }
  return { model, lang };
}
