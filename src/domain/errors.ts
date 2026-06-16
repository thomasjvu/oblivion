export class DomainError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, statusCode: number, details?: Record<string, unknown>) {
    super(typeof details?.message === "string" ? details.message : code);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function domainError(code: string, statusCode: number, details?: Record<string, unknown>): DomainError {
  return new DomainError(code, statusCode, details);
}