// Errors that become a JSON response with a stable shape: { error: { code, message, details? } }.

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "Sign in to continue") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Not allowed", code = "forbidden") => new HttpError(403, code, message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);
