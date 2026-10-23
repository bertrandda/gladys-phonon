// -----------------------------------------------------------------------------
// Errors shown to the administrator (connection status, action results): they
// carry a message for each UI language of Gladys. `message` is the English one,
// for the logs and for the command acks Gladys records.
// -----------------------------------------------------------------------------

export class LocalizedError extends Error {
  /**
   * @param {{ en: string, fr: string }} messages - Messages shown in the UI.
   * @param {{ status?: number, cause?: unknown }} [options]
   */
  constructor(messages, { status, cause } = {}) {
    super(messages.en, { cause });
    this.name = 'LocalizedError';
    this.messages = messages;
    this.status = status;
  }
}

/**
 * The bilingual messages of any error (a plain Error shows its message in both
 * languages).
 * @param {unknown} error
 * @returns {{ en: string, fr: string }}
 */
export function messagesOf(error) {
  if (error instanceof LocalizedError) {
    return error.messages;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { en: message, fr: message };
}
