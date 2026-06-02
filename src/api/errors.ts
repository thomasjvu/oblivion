export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number") {
    return new HttpError(error.statusCode, error.message);
  }
  if (error instanceof Error) return new HttpError(500, error.message);
  return new HttpError(500, "unknown-error");
}
