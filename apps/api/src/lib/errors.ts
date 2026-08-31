export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    /**
     * Structured context merged into the JSON error envelope alongside code and
     * message. Used by batch job creation to tell the caller which row failed.
     * Keep it small and non-sensitive — it is sent verbatim to the client.
     */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Tags a row-scoped failure with its row index for the batch endpoint. Anything
 * that is not an AppError is returned untouched: an unexpected TypeError must
 * stay a 500 rather than being re-dressed as a client error.
 */
export function withRowIndex(err: unknown, rowIndex: number): unknown {
  if (!(err instanceof AppError)) return err;
  return new AppError(err.code, err.statusCode, err.message, {
    ...(err.details ?? {}),
    rowIndex,
  });
}
