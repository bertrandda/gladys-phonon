# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-26

## [0.1.1] - 2026-10-25

### Added

- Offline text-to-speech provider for Gladys (`tts` integration type): Gladys
  speaks scene notifications with Gradium's Phonon models, synthesized on the
  Gladys machine by the official `ptts-openai-server` image (sub-container).
- Seven models to choose from: Phonon 40m in French, English, German, Spanish,
  Portuguese and multilingual (Hugging Face account and token), and Phonon 31m
  in English (no account). No model is selected by default: nothing is
  downloaded and Gladys cannot speak until the administrator chooses one.
- The 102 voices of the Phonon voice catalog, the model's own voice, and custom
  voices from Gradium Studio (voice ID and API key, or the https URL of a voice
  file). Only the selected voice is downloaded.
- A demo page to listen to every voice before choosing it (GitHub Pages).
- Download progress, Hugging Face and Gradium errors and the engine state in the
  Configuration screen. The previous voice keeps speaking while a new model
  downloads. Once downloaded, everything works offline.
- Speech rate and model weights (q8 or f32) settings.
- Actions: test the voice, list the Gradium Studio voices of the account,
  restart the speech engine.
- A text too long to be spoken within the time Gladys waits is cut, and its
  beginning is spoken.
- Built on the integration SDK 0.16.0: Gladys' speech requests are answered by
  its `onTtsSynthesize` handler, which checks every clip before sending it.

[Unreleased]: https://github.com/bertrandda/gladys-phonon/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/bertrandda/gladys-phonon/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/bertrandda/gladys-phonon/releases/tag/v0.1.1
