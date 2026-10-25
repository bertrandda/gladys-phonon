# Phonon TTS for Gladys Assistant

An external integration of type `tts` for [Gladys Assistant](https://gladysassistant.com): Gladys
speaks with Gradium's [Phonon](https://huggingface.co/gradium) text-to-speech models, **offline**,
on the Gladys machine.

- 7 models: Phonon 40m in French, English, German, Spanish, Portuguese and multilingual, and
  Phonon 31m in English. The administrator chooses one after installing: none is selected by
  default.
- 102 ready-made voices from the [Phonon voice catalog](https://huggingface.co/gradium/phonon-voices),
  to [listen to on the demo page](https://bertrandda.github.io/gladys-phonon/), plus custom voices
  from [Gradium Studio](https://studio.gradium.ai/).
- Once the model and the voice are downloaded, no internet access is needed.

User documentation: [English](docs/en.md) · [Français](docs/fr.md).

## How it works

```
Gladys core ──WebSocket: tts.synthesize / command-result──► main container (this repo, Node.js)
                                                              │  downloads the model and the voice
                                                              │  into /data/containers/phonon/models
                                                              │  HTTP: http://phonon:8880/v1/audio/speech (MP3)
                                                              ▼
                                  "phonon" sub-container: ghcr.io/gradium-ai/ptts-openai-server
                                  PTTS_MODEL=/models/<repo>/<commit>, PTTS_VOICE_DIR=/models/voices
```

- Gladys sends `external-integration.tts.synthesize { text, language }` over the integration
  WebSocket and expects the audio within 30 s
  ([TTS provider spec](https://github.com/GladysAssistant/Gladys/blob/master/docs/specs/external-integrations/capabilities/tts-type.md)).
  The integration answers it with the `onTtsSynthesize` handler of the JS SDK (0.16 or later),
  which checks the clip against the contract (content type, base64, 5 MB) before the ack.
- Speech is synthesized by the official `ptts-openai-server` image, declared as a sub-container
  in the [manifest](gladys-assistant-integration.json) (1 GB, 2 CPUs: the main container is limited
  to 256 MB and half a CPU). Its API streams MP3, which lets a synthesis that runs late hand back
  the speech produced so far.
- The main container downloads the checkpoint from Hugging Face, pinned to the commit of its first
  download, and the selected voice only, then starts the server on that local folder. The Hugging
  Face token and the Gradium API key never leave the main container, the progress and the errors
  show in the Configuration screen, and the previous voice keeps speaking during a download.

| File                                                 | Role                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| [`index.js`](index.js)                               | builds the dependencies and connects                          |
| [`src/integration.js`](src/integration.js)           | SDK wiring: TTS command, configuration, actions               |
| [`src/engine.js`](src/engine.js)                     | sub-container lifecycle, downloads, synthesis queue, statuses |
| [`src/hub.js`](src/hub.js)                           | Hugging Face downloads (checked size and sha256)              |
| [`src/voiceStore.js`](src/voiceStore.js)             | the voice folder: catalog and custom voices                   |
| [`src/phononClient.js`](src/phononClient.js)         | client of the speech server                                   |
| [`src/voices.catalog.json`](src/voices.catalog.json) | the pinned voice catalog (generated)                          |
| [`scripts/sync-voices.mjs`](scripts/sync-voices.mjs) | regenerates the voice list of the manifest and the demo page  |
| [`site/`](site)                                      | the voice demo page, published on GitHub Pages                |

## Development

Node.js 22 or later.

```bash
npm install
npm test                 # node --test, never touches the network
npm run lint
npm run format:check
```

### Refreshing the voices

The Gladys configuration form only takes static select options, so the voice list lives in the
manifest. When Gradium publishes new voices, run `npm run sync-voices` (or the **Sync voices**
workflow), then release a new version.

### Trying it against a Gladys instance

Run the **Build and publish image** workflow on your branch (Actions → Run workflow): its summary
prints the manifest pointing at the image it pushed. Paste it in Gladys, **Integrations → Install
an integration → Developer mode**. Gladys pulls the image and the speech server image, and the
Configuration screen of the integration takes it from there.

Outside Docker, `MODELS_DIR` (the sub-container volume `/models`, seen from the integration) and
`PHONON_URL` (the speech server) override the container defaults.

## Publishing

- **Release**: Actions → Release → patch / minor / major. It bumps `package.json` and the manifest,
  rolls the changelog, tags, builds the multi-arch image and publishes the GitHub Release.
- **Store**: add the `gladys-assistant-integration` topic to the repository. The store indexer
  only admits the `tts` type once the canonical schema of
  [GladysAssistant/integration-store](https://github.com/GladysAssistant/integration-store) lists it
  (it does not yet), and Gladys installs it from 5.3.0, the first release with pluggable voices.
  Until then, install it in developer mode. `npx github:GladysAssistant/integration-store .` runs
  the store checks locally.
- **Voice demo page**: Settings → Pages → Source: GitHub Actions. The **Voice demo page** workflow
  publishes `site/` on every change.

## License

The code is under the Apache 2.0 license. The Phonon 40m models are licensed CC BY-NC 4.0
(non-commercial use); Phonon 31m and the voice catalog are licensed Apache 2.0. The speech server
is Gradium's [xn-ptts](https://github.com/gradium-ai/xn-ptts) (MIT or Apache 2.0).
