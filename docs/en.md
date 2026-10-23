# Phonon TTS

Phonon TTS gives Gladys an **offline** voice: the texts to speak (scene
"Play a notification" announcements) are synthesized on your Gladys machine by
Gradium's [Phonon](https://huggingface.co/gradium) models, with no cloud
service or subscription. Once the model is downloaded, no internet connection is
needed.

## Prerequisites

- **Gladys 5.3 or later** (pluggable voices).
- **Gladys in `host` network mode** (standard installation): the speakers
  (Sonos, Google Cast, AirPlay…) download the audio from an address of your
  local network.
- About **1 GB of memory** and **150 MB of disk** free for the speech engine.
  A Raspberry Pi 4 or 5 is fine.
- For the **Phonon 40m** models (every language): a free
  [Hugging Face](https://huggingface.co) account.
  1. Open the model page, for instance
     [gradium/phonon-40m-fr](https://huggingface.co/gradium/phonon-40m-fr), and
     accept its terms of use (approval is instant).
  2. Create a **read** token at
     [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).

  The **Phonon 31m** model (English only) needs no account.

The Phonon 40m models are licensed **CC BY-NC 4.0** (non-commercial use);
Phonon 31m and the catalog voices are licensed Apache 2.0.

## Configuration

Right after installation, the integration **does not speak**: no model is
selected by default and nothing is downloaded.

1. Open the **Configuration** tab of the integration.
2. Choose the **model**: a 40m model in your language (the best choice), the
   multilingual model (then choose its **language**), or Phonon 31m for English
   without an account.
3. For a 40m model, paste your **Hugging Face token**. It is only used for the
   download and never sent to the speech engine.
4. Choose the **voice**: the model's own voice, or one of the 102 voices of the
   Phonon catalog. Listen to them first on the
   [voice demo page](https://bertrandda.github.io/gladys-phonon/), which shows
   the exact name to pick in the list. Every voice works with every model, but
   sounds best in its own language.
5. Save. The status at the top of the screen follows the download (about
   75 MB), then the engine startup, until **Ready**.
6. Make Phonon TTS the voice of Gladys: **Integrations › Artificial
   Intelligence › Voice**, choose **Phonon TTS**.

Your "Play a notification" scenes now speak with Phonon.

Only the selected model and voice are kept on disk: switching model or voice
deletes the previous ones. While a new model downloads, the current voice keeps
speaking.

### Custom voice (Gradium Studio)

A voice designed or cloned in [Gradium Studio](https://studio.gradium.ai/)
works too:

1. Create an API key in Gradium Studio, paste it into **Gradium API key**, and
   save.
2. Run the **List my Gradium Studio voices** action: it shows the ID of each of
   your voices.
3. Choose **Custom voice** in the voice list, paste the ID into **Custom
   voice**, and save.

You can also enter the https URL of a Phonon voice file (`.safetensors`)
there. The voice is downloaded once.

### Advanced settings

- **Speech rate**: slower, normal or faster.
- **Model weights**: `q8` (recommended) is smaller and faster on a CPU; `f32`
  is larger and slower.

## Actions

- **Test the voice**: synthesizes a sentence (yours, or a sample one) and
  reports the length of the generated speech and the computing time.
- **List my Gradium Studio voices**: see above.
- **Restart the speech engine**: retries the download and restarts the engine,
  for instance after a network outage.

## Limitations

- **The voice assistant answers in text** with Phonon TTS: its page is served
  over HTTPS, and browsers refuse to play audio served over plain HTTP on the
  local network. Scene announcements speak normally.
- Gladys waits **30 seconds** at most for a synthesis. On a modest machine, a
  very long text is cut and only its beginning is spoken.
- One language per model (the model's, or the one chosen for the multilingual
  model): a text in another language is read with the model's accent.

## Troubleshooting

- **"No model selected"**: choose a model and save.
- **"Gated model" / "Access denied"**: accept the terms on the Hugging Face
  page of the model **with the account of the token**, check the token, then
  save again.
- **"Cannot reach Hugging Face"**: Gladys needs the internet for the first
  download. Check the connection, then run **Restart the speech engine**.
- **The engine stops while starting**: check the logs of the `phonon`
  container in the Supervision block (not enough memory, unsupported CPU…).
- **The speakers play nothing**: check that Gladys runs in `host` network mode
  and that Phonon TTS is the voice selected in Integrations › Artificial
  Intelligence.
- The logs of the integration (Supervision block) detail every step.

Report an issue at
[github.com/bertrandda/gladys-phonon](https://github.com/bertrandda/gladys-phonon/issues).
