// -----------------------------------------------------------------------------
// TTS provider contract of Gladys (docs/specs/external-integrations/
// capabilities/tts-type.md in the Gladys repository):
//
//   core -> integration  external-integration.tts.synthesize
//                        { message_id, text, language }
//   integration -> core  external-integration.command-result
//                        { message_id, success: true, data: { audio: "audio/mpeg;base64,..." } }
//                        or { message_id, success: false, error }
//
// The spec gives the JS SDK an `onTtsSynthesize(cb)` handler, which SDK 0.15
// does not have yet: until it does, this shim intercepts the message on the
// SDK's own WebSocket (authentication, reconnection and the other commands
// stay the SDK's) and answers it the way the SDK acks every command. As soon as
// the SDK exposes onTtsSynthesize, it is used instead and the shim is inert.
// The shim relies on two internals of the SDK (`_handleMessage`, `_send`), so
// package.json pins the SDK version and test/ttsShim.test.js covers them.
// -----------------------------------------------------------------------------

export const TTS_SYNTHESIZE = 'external-integration.tts.synthesize';
export const COMMAND_RESULT = 'external-integration.command-result';

/**
 * Register the TTS synthesize handler.
 * @param {object} gladys - GladysIntegration instance, before connect().
 * @param {(text: string, language: string|null) => Promise<string>} handler -
 *   Resolves the audio as `<content type>;base64,...`.
 * @returns {'sdk'|'shim'} Which mechanism handles the command.
 */
export function onTtsSynthesize(gladys, handler) {
  if (typeof gladys.onTtsSynthesize === 'function') {
    gladys.onTtsSynthesize(handler);
    return 'sdk';
  }
  if (typeof gladys._handleMessage !== 'function' || typeof gladys._send !== 'function') {
    throw new Error(
      'This version of @gladysassistant/integration-sdk has neither onTtsSynthesize nor the ' +
        'internals the TTS shim needs: pin the SDK version of package.json.',
    );
  }
  const handleMessage = gladys._handleMessage.bind(gladys);
  gladys._handleMessage = async (rawData, ...rest) => {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch {
      return handleMessage(rawData, ...rest);
    }
    if (message?.type !== TTS_SYNTHESIZE) {
      return handleMessage(rawData, ...rest);
    }
    const payload = message.payload ?? {};
    try {
      const audio = await handler(payload.text, payload.language ?? null);
      gladys._send(COMMAND_RESULT, {
        message_id: payload.message_id,
        success: true,
        data: { audio },
      });
    } catch (e) {
      gladys._send(COMMAND_RESULT, {
        message_id: payload.message_id,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return 'shim';
}
