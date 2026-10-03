export interface CueLineErrorOptions {
  cause?: unknown;
  details?: unknown;
}

export class CueLineError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, options: CueLineErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CueLineError";
    this.code = code;
    this.details = options.details;
  }
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  let rendering: string;
  try {
    rendering = (typeof error === "object" && error !== null ? JSON.stringify(error) : String(error))
      ?? "[unserializable value]";
  } catch {
    rendering = "[unserializable value]";
  }
  const limit = 240;
  const marker = "… [truncated]";
  if (rendering.length > limit) rendering = rendering.slice(0, limit - marker.length) + marker;
  return `Non-Error rejection (${error === null ? "null" : typeof error}): ${rendering}`;
}

export function asCueLineError(error: unknown, code = "CUELINE_INTERNAL"): CueLineError {
  if (error instanceof CueLineError) {
    return error;
  }
  const message = formatErrorMessage(error);
  return new CueLineError(code, message, { cause: error });
}
