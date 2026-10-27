/**
 * Stable machine-readable error codes and their process exit codes.
 * Every failure the CLI reports goes through CliError, so JSON consumers
 * can branch on `error.code` and shells can branch on the exit code.
 */
export const ERROR_EXIT_CODES = {
  INTERNAL: 1,
  INVALID_ARGUMENT: 2,
  INVALID_CONFIG: 2,
  AUTH_REQUIRED: 3,
  AUTH_INVALID: 3,
  AUTH_EXPIRED: 3,
  INSECURE_CREDENTIALS: 3,
  NOT_FOUND: 4,
  TASK_NOT_OPEN: 4,
  REMOTE_MISSING: 4,
  AMBIGUOUS: 5,
  PARTIAL_DATA: 6,
  API_ERROR: 7,
  PERMISSION_DENIED: 7,
  NETWORK_ERROR: 7,
  RATE_LIMITED: 7,
  UNCERTAIN_WRITE: 8,
  VERIFY_FAILED: 8,
  BATCH_PARTIAL_FAILURE: 8,
  CONFLICT: 9,
  OP_ID_CONFLICT: 9,
  UNSUPPORTED_CAPABILITY: 10,
  CONFIRMATION_REQUIRED: 11,
} as const;

export type ErrorCode = keyof typeof ERROR_EXIT_CODES;

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }

  get exitCode(): number {
    return ERROR_EXIT_CODES[this.code];
  }
}

/** Converts any thrown value into a CliError without leaking stack traces or secrets. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("INTERNAL", message);
}
