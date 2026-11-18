/** Typed domain errors. `errorResponse` maps `status` straight to the HTTP response. */
export class HttpError extends Error {
  /** A stable machine-readable code for clients (`errorResponse` adds it to the body when set). */
  code?: string;
  /** Seconds a client should wait before retrying (`errorResponse` sends it as `Retry-After` when set). */
  retryAfterSeconds?: number;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

/** The request is well formed but conflicts with the current state (a stale update, a cap reached). */
export class ConflictError extends HttpError {
  constructor(message = "That change isn't allowed from the current state.") {
    super(409, message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(limit: number) {
    super(413, `Body too large (limit ${limit} bytes)`);
  }
}

/** Too many attempts in a window (for example share attempts per hour). */
export class TooManyRequestsError extends HttpError {
  constructor(message = "Too many requests") {
    super(429, message);
  }
}

/** The request is well formed but the content is unacceptable (for example a file that isn't the image it claims to be). */
export class UnprocessableError extends HttpError {
  constructor(message = "Unprocessable") {
    super(422, message);
  }
}

/** The declared type of an upload (or the bytes behind it) isn't one this app accepts. */
export class UnsupportedMediaTypeError extends HttpError {
  constructor(message = "Unsupported media type") {
    super(415, message);
    this.code = "unsupported";
  }
}

/** Refused up front because the server is at its limit for this kind of work; nothing was attempted, so retrying is right. */
export class ServiceBusyError extends HttpError {
  constructor(message = "The server is busy. Try again in a few seconds.", retryAfterSeconds = 5) {
    super(503, message);
    this.code = "busy";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
