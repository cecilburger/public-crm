import {
  CommentActionNotImplementedError, CommentActionUnavailableError, CommentNotFoundError, NoActiveSessionError,
  SendNotConfirmedError,
} from './sessionManager.ts';
import { PrivateReplyError } from './privateReply.ts';

/**
 * The HTTP answer for a failed comment action — the status the worker keys its
 * permanent/transient decision on, and the code the CRM turns into words.
 *
 * A private reply answers with its own stage, never the public reply's code:
 * 503 when the send was never pressed (nothing reached the customer), 502 when
 * it was pressed once and delivery could not be seen (it may well have).
 */
export function commentActionStatus(err: unknown): number {
  if (err instanceof PrivateReplyError) return err.nothingSent ? 503 : 502;
  if (err instanceof CommentActionNotImplementedError) return 501;
  if (err instanceof CommentNotFoundError) return 409;
  if (err instanceof CommentActionUnavailableError) return 409;
  if (err instanceof NoActiveSessionError) return 404;
  return 502;
}

export function commentActionBody(err: unknown): { error: string; code?: string } {
  const message = err instanceof Error ? err.message : 'Gagal menindaklanjuti komentar Facebook';
  if (err instanceof PrivateReplyError) return { error: message, code: err.code };
  if (err instanceof CommentActionNotImplementedError) return { error: message, code: 'comment_action_not_implemented' };
  if (err instanceof CommentNotFoundError) return { error: message, code: 'comment_not_found' };
  if (err instanceof CommentActionUnavailableError) return { error: message, code: err.code };
  if (err instanceof NoActiveSessionError) return { error: message };
  if (err instanceof SendNotConfirmedError) return { error: message, code: 'reply_not_confirmed' };
  return { error: message };
}
