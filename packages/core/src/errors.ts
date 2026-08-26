/**
 * RFC 9457 problem+json errors. Every error the API returns is one of these,
 * so clients never have to parse prose and we never leak stack traces.
 */
export type ErrorCode =
  | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict'
  | 'validation_failed' | 'rate_limited' | 'plan_limit_reached'
  | 'channel_unavailable' | 'window_expired' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409,
  validation_failed: 422, rate_limited: 429, plan_limit_reached: 402,
  channel_unavailable: 503, window_expired: 409, internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: Record<string, unknown>;
  /** Safe to show a customer. Internal causes stay in the log only. */
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
    this.expose = code !== 'internal';
  }

  toProblem(instance?: string) {
    return {
      type: `https://docs.kirana.id/errors/${this.code}`,
      title: this.code.replace(/_/g, ' '),
      status: this.status,
      detail: this.expose ? this.message : 'Unexpected error',
      ...(this.expose && this.detail ? { errors: this.detail } : {}),
      ...(instance ? { instance } : {}),
    };
  }
}

export const unauthenticated = (m = 'Sign in to continue') => new AppError('unauthenticated', m);
export const forbidden = (m = 'You do not have access to this') => new AppError('forbidden', m);
export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
export const conflict = (m: string) => new AppError('conflict', m);
export const invalid = (m: string, errors?: Record<string, unknown>) =>
  new AppError('validation_failed', m, errors);
