import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type { Database } from '@kirana/db';
import { markChatbotExhausted, CHATBOT_REPLY_QUEUE, type ChatbotJob } from './chatbotReply.ts';
import { markLegacyBdDraftExhausted, LEGACY_BD_DRAFT_QUEUE, type LegacyBdDraftJob } from './bdDraft.ts';

/**
 * How the worker's queues drive the chatbot processor, kept out of `main.ts`
 * (which connects to Redis and Postgres as it loads) so it can be tested.
 */

/** Another message on the same thread is being answered: come back after this long. */
export const CHATBOT_BUSY_DELAY_MS = 3_000;

/**
 * The processor's `onBusy`: put the job back for a few seconds and end this
 * run of it with `DelayedError`, which BullMQ does not count as an attempt.
 */
export function deferWhileBusy(job: Pick<Job, 'moveToDelayed'>, token: string | undefined): () => Promise<never> {
  return async () => {
    await job.moveToDelayed(Date.now() + CHATBOT_BUSY_DELAY_MS, token);
    throw new DelayedError();
  };
}

type FailedJob = Pick<Job, 'data' | 'attemptsMade' | 'opts'>;

/** No retry is coming: the error said none would help, or the attempts are spent. */
export function isFinalAttempt(job: FailedJob, err: Error): boolean {
  return err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * The queue's last word on a chatbot job. The contact is still waiting for an
 * answer the bot will not give, so the conversation goes to a person — for a
 * job drained from the old `bd.draft` queue as much as for a new one. True
 * when the hand-over was attempted.
 */
export async function handOverFailedChatbotJob(
  db: Database, queue: string, job: FailedJob, err: Error,
): Promise<boolean> {
  if (!isFinalAttempt(job, err)) return false;
  if (queue === CHATBOT_REPLY_QUEUE) {
    await markChatbotExhausted(db, job.data as ChatbotJob, err.message);
    return true;
  }
  if (queue === LEGACY_BD_DRAFT_QUEUE) {
    await markLegacyBdDraftExhausted(db, job.data as LegacyBdDraftJob, err.message);
    return true;
  }
  return false;
}
