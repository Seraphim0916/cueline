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

export function asCueLineError(error: unknown, code = "CUELINE_INTERNAL"): CueLineError {
  if (error instanceof CueLineError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CueLineError(code, message, { cause: error });
}
