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
    const enriched = error as Error & {
      statusCode: number;
      code?: string;
      caseId?: string;
      products?: unknown;
      rates?: unknown;
      config?: unknown;
    };
    const details: Record<string, unknown> = {};
    if (enriched.code) details.code = enriched.code;
    if (enriched.caseId) details.caseId = enriched.caseId;
    if (enriched.products) details.products = enriched.products;
    if (enriched.rates) details.rates = enriched.rates;
    if (enriched.config) details.config = enriched.config;
    return new HttpError(
      enriched.statusCode,
      enriched.code ?? enriched.message,
      Object.keys(details).length ? details : undefined
    );
  }
  if (error instanceof Error) return new HttpError(500, error.message);
  return new HttpError(500, "unknown-error");
}
