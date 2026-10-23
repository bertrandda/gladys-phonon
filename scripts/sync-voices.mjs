// -----------------------------------------------------------------------------
// Sync the voice list with the Phonon voice catalog (gradium/phonon-voices on
// the Hugging Face Hub).
//
//   npm run sync-voices                 # latest catalog (main)
//   npm run sync-voices -- <revision>   # a branch, tag or commit
//
// The Gladys configuration form only takes static select options, so the list
// of voices lives in the manifest. This script pins the catalog to one commit
// and writes, from that commit:
//   - src/voices.catalog.json   the voices the integration can download;
//   - the options of the `voice` select of gladys-assistant-integration.json;
//   - site/voices.json          the data of the voice demo page (site/).
// Run it when Gradium publishes new voices, then release a new version.
// It needs network access to huggingface.co (the catalog is public: no token).
// -----------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sortVoices, voiceLabel, voiceOptions, voiceTags } from '../src/voiceLabels.js';

export const HUB = 'https://huggingface.co';
export const VOICES_REPO = 'gradium/phonon-voices';
// Model sizes the integration offers, whose samples the demo page plays.
export const SAMPLE_SIZES = ['40m', '31m'];
// Preferred clip of a voice, for each size (characters have no happy_01).
const PREFERRED_CLIPS = ['happy_01.ogg', 'line_1.ogg'];

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const MANIFEST = root('gladys-assistant-integration.json');
const CATALOG = root('src/voices.catalog.json');
const SITE_DATA = root('site/voices.json');

/**
 * The sample clips of a voice, as paths in the catalog repo.
 * Layout (catalog commit 0ee1720): `samples/<size>/<lang>/<locale>/<gender>/<n>_<name>_<id>/<clip>.ogg`
 * per model size, and one `samples/<lang>/.../<n>_<name>_<id>.ogg` per voice.
 * @param {string[]} files - Every file of the catalog repo.
 * @param {string} voiceId - The voice id.
 * @returns {Record<string, string|null>} `{ '40m': path, '31m': path, default: path }`.
 */
export function findSamples(files, voiceId) {
  const samples = {};
  for (const size of SAMPLE_SIZES) {
    const clips = files
      .filter(
        (f) => f.startsWith(`samples/${size}/`) && f.includes(`_${voiceId}/`) && f.endsWith('.ogg'),
      )
      .sort();
    samples[size] =
      PREFERRED_CLIPS.map((clip) => clips.find((f) => f.endsWith(`/${clip}`))).find(Boolean) ??
      clips[0] ??
      null;
  }
  samples.default =
    files.find(
      (f) =>
        f.startsWith('samples/') && !/^samples\/\d+m\//.test(f) && f.endsWith(`_${voiceId}.ogg`),
    ) ?? null;
  return samples;
}

/**
 * Build the catalog from the repo listing and its voices.jsonl.
 * @param {{ sha: string, files: string[], jsonl: string, blobs?: Map<string, { size?: number, sha256?: string }> }} input
 *   `blobs`: size and LFS checksum of each file, checked after each voice download.
 * @returns {{ repo: string, sha: string, voices: Array }}
 */
export function buildCatalog({ sha, files, jsonl, blobs = new Map() }) {
  const entries = jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const voices = entries.map((entry) => {
    if (!/^[A-Za-z0-9_-]+$/.test(entry.voice_id ?? '')) {
      throw new Error(`unexpected voice_id ${JSON.stringify(entry.voice_id)} in voices.jsonl`);
    }
    if (!files.includes(entry.filename)) {
      throw new Error(`${entry.filename} (${entry.name}) is not in ${VOICES_REPO}@${sha}`);
    }
    return {
      voice_id: entry.voice_id,
      name: entry.name,
      language: entry.language,
      locale: entry.locale ?? null,
      gender: entry.gender ?? null,
      age: entry.age ?? null,
      description: entry.description ?? null,
      filename: entry.filename,
      size: blobs.get(entry.filename)?.size ?? null,
      sha256: blobs.get(entry.filename)?.sha256 ?? null,
      samples: findSamples(files, entry.voice_id),
    };
  });
  return { repo: VOICES_REPO, sha, voices: sortVoices(voices) };
}

/**
 * Replace the options of the `voice` select of the manifest.
 * @param {object} manifest - Parsed manifest.
 * @param {Array} catalogVoices - Catalog voices.
 * @returns {object} The manifest.
 */
export function setVoiceOptions(manifest, catalogVoices) {
  const field = manifest.config_schema.find((f) => f.key === 'voice');
  if (!field) {
    throw new Error('the manifest has no `voice` field');
  }
  field.options = voiceOptions(catalogVoices);
  return manifest;
}

/**
 * Data of the demo page: the catalog plus each voice's select label and tags.
 * @param {{ repo: string, sha: string, voices: Array }} catalog
 * @returns {object}
 */
export function buildSiteData(catalog) {
  return {
    repo: catalog.repo,
    sha: catalog.sha,
    base_url: `${HUB}/${catalog.repo}/resolve/${catalog.sha}/`,
    voices: catalog.voices.map((voice) => ({
      ...voice,
      label: voiceLabel(voice),
      tags: voiceTags(voice),
    })),
  };
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
  return response;
}

async function format(text, filepath) {
  try {
    const prettier = await import('prettier');
    return prettier.format(text, { ...(await prettier.resolveConfig(filepath)), filepath });
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') {
      return text; // dev dependencies not installed: unformatted, `npm run format` fixes it
    }
    throw e;
  }
}

/**
 * JSON with each object or array on one line when it fits in `width` columns,
 * the way the manifest is written by hand: Prettier keeps a one-line object
 * that fits, but never joins the lines of one that `JSON.stringify` split.
 * @param {any} value - Value to serialize.
 * @param {number} [width] - Maximum line width (Prettier's printWidth).
 * @returns {string} The JSON text, without trailing newline.
 */
export function compactJson(value, width = 100) {
  const oneLine = (v) => {
    if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`;
    if (v && typeof v === 'object') {
      const entries = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`);
      return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
    }
    return JSON.stringify(v);
  };
  const render = (v, indent, prefix) => {
    const flat = oneLine(v);
    if (!v || typeof v !== 'object' || indent.length + prefix.length + flat.length + 1 <= width) {
      return flat;
    }
    const inner = `${indent}  `;
    const lines = Array.isArray(v)
      ? v.map((x) => `${inner}${render(x, inner, '')}`)
      : Object.entries(v).map(([k, x]) => {
          const key = `${JSON.stringify(k)}: `;
          return `${inner}${key}${render(x, inner, key)}`;
        });
    const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
    return `${open}\n${lines.join(',\n')}\n${indent}${close}`;
  };
  return render(value, '', '');
}

async function writeJson(path, value) {
  await writeFile(path, await format(`${compactJson(value)}\n`, path));
}

async function main(revision = 'main') {
  const info = await (
    await fetchOk(
      `${HUB}/api/models/${VOICES_REPO}/revision/${encodeURIComponent(revision)}?blobs=true`,
    )
  ).json();
  const siblings = info.siblings ?? [];
  const files = siblings.map((s) => s.rfilename);
  const blobs = new Map(
    siblings.map((s) => [s.rfilename, { size: s.size, sha256: s.lfs?.sha256 }]),
  );
  const jsonl = await (
    await fetchOk(`${HUB}/${VOICES_REPO}/resolve/${info.sha}/voices.jsonl`)
  ).text();
  const catalog = buildCatalog({ sha: info.sha, files, jsonl, blobs });

  await writeJson(CATALOG, catalog);
  await writeJson(
    MANIFEST,
    setVoiceOptions(JSON.parse(await readFile(MANIFEST, 'utf8')), catalog.voices),
  );
  await writeJson(SITE_DATA, buildSiteData(catalog));
  console.log(`${catalog.voices.length} voices from ${VOICES_REPO}@${catalog.sha}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2]).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
