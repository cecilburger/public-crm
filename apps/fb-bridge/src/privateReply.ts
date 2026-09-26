import type { Page } from 'puppeteer';
import { focusComposer, readComposerText, readPrivateSendState } from './pageHtml.ts';
import { normaliseWhitespace } from './parsers/dom.ts';

/**
 * Where a private reply to a comment stopped, as the CRM records it.
 *
 * Every code but the last means NOTHING reached the customer — the send
 * control was never pressed — so trying again cannot deliver twice. The last
 * means it was pressed exactly once and delivery could not be seen: the
 * message may well have arrived, and it must not be sent again automatically.
 */
export type PrivateReplyCode =
  | 'private_surface_not_found'
  | 'private_composer_not_found'
  | 'private_composer_closed'
  | 'private_type_failed'
  | 'private_send_not_attempted'
  | 'private_send_unconfirmed';

export class PrivateReplyError extends Error {
  constructor(message: string, readonly code: PrivateReplyCode) {
    super(message);
    this.name = 'PrivateReplyError';
  }

  /** True when the send control was never pressed. */
  get nothingSent(): boolean {
    return this.code !== 'private_send_unconfirmed';
  }
}

export type PrivateSurfaceKind = 'dialog' | 'business_suite';

/**
 * The browser work of one private reply, supplied by the session manager.
 * Kept behind this seam so the part that has to be exactly right — the order,
 * the single send and what each failure means — is tested without a browser.
 */
export interface PrivateReplySteps<S = unknown> {
  /** How many messages with this text the customer's conversation holds now, from a fresh read. */
  baseline(): Promise<number>;
  /** Activates "Send message" once and returns the page showing the private surface, or null. */
  openSurface(): Promise<S | null>;
  /** Proves, in one DOM reading, that this is a private message to the right customer. */
  proveSurface(surface: S): Promise<PrivateSurfaceKind | null>;
  /** Types the text once and proves the composer holds it; throws `PrivateReplyError` otherwise. */
  enterText(surface: S, kind: PrivateSurfaceKind): Promise<void>;
  /** Whether Facebook's own send control has accepted the text. */
  sendEnabled(surface: S, kind: PrivateSurfaceKind): Promise<boolean>;
  /** Presses send. Called at most once per private reply. */
  pressSend(surface: S, kind: PrivateSurfaceKind): Promise<void>;
  /** Whether the message is now in the customer's conversation, beyond the baseline. */
  confirm(before: number): Promise<boolean>;
  /** Errors that are not this flow's to classify (the session is gone, a login is needed). */
  isPassthrough(err: unknown): boolean;
  log(event: string, fields?: Record<string, unknown>): void;
}

/**
 * One private reply: prove the surface, type once, send once, confirm.
 *
 * The destination is re-proven after typing and again immediately before the
 * send, because Facebook re-renders under the dialog; a surface that changed
 * is left with its draft unsent. The send is pressed once and never retried
 * here — what happens after it is only ever read.
 */
export async function runPrivateReply<S>(steps: PrivateReplySteps<S>): Promise<void> {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  let pressed = false;
  try {
    const before = await steps.baseline();
    steps.log('fb_private_surface_resolve_started', { baseline: before, elapsedMs: elapsed() });

    const surface = await steps.openSurface();
    if (!surface) {
      throw new PrivateReplyError(
        'Facebook tidak membuka kotak pesan pribadi untuk komentar ini — tidak ada yang dikirim', 'private_surface_not_found');
    }
    const kind = await steps.proveSurface(surface);
    if (!kind) {
      throw new PrivateReplyError(
        'Kotak pesan yang terbuka tidak terbukti milik pengomentar ini — tidak ada yang diketik', 'private_composer_not_found');
    }
    steps.log('fb_private_surface_selected', { surfaceType: kind, elapsedMs: elapsed() });
    steps.log('fb_private_composer_found', { surfaceType: kind, elapsedMs: elapsed() });

    await steps.enterText(surface, kind);
    steps.log('fb_private_text_entered', { surfaceType: kind, elapsedMs: elapsed() });
    if ((await steps.proveSurface(surface)) !== kind) {
      throw new PrivateReplyError('Kotak pesan pribadi berubah setelah diketik — tidak dikirim', 'private_composer_closed');
    }
    if (!(await steps.sendEnabled(surface, kind))) {
      throw new PrivateReplyError(
        'Tombol kirim Facebook tidak aktif untuk teks ini — pesan tidak dikirim', 'private_send_not_attempted');
    }
    if ((await steps.proveSurface(surface)) !== kind) {
      throw new PrivateReplyError('Kotak pesan pribadi berubah tepat sebelum dikirim — tidak dikirim', 'private_composer_closed');
    }

    steps.log('fb_private_send_started', { surfaceType: kind, elapsedMs: elapsed() });
    pressed = true;
    await steps.pressSend(surface, kind);

    if (!(await steps.confirm(before))) {
      throw new PrivateReplyError(
        'Pesan pribadi sudah dikirim sekali tapi belum terlihat di percakapan Messenger', 'private_send_unconfirmed');
    }
    steps.log('fb_private_send_confirmed', { surfaceType: kind, elapsedMs: elapsed() });
  } catch (err) {
    const failure = classify(err, pressed, steps.isPassthrough);
    if (failure instanceof PrivateReplyError) {
      steps.log('fb_private_send_failed', {
        code: failure.code, nothingSent: failure.nothingSent, elapsedMs: elapsed(),
        cause: err === failure ? undefined : String((err as Error)?.message ?? err).slice(0, 160),
      });
    }
    throw failure;
  }
}

/** What a failure means for the customer: nothing sent, or possibly sent. */
function classify(err: unknown, pressed: boolean, isPassthrough: (err: unknown) => boolean): unknown {
  const message = String((err as Error)?.message ?? err);
  // Once pressed, "may have been sent" outranks everything — a session that
  // died during the confirmation included — or a retry could deliver twice.
  if (pressed) {
    if (err instanceof PrivateReplyError && err.code === 'private_send_unconfirmed') return err;
    return new PrivateReplyError(
      `Pesan pribadi sudah dikirim sekali tapi konfirmasinya gagal: ${message}`, 'private_send_unconfirmed');
  }
  if (isPassthrough(err)) return err;
  if (err instanceof PrivateReplyError) return err;
  return new PrivateReplyError(`Pesan pribadi belum dikirim: ${message}`, 'private_send_not_attempted');
}

/**
 * Puts the text into the private composer once, then proves it is there,
 * whole. Text sitting in a box has reached no one, so every failure here is
 * "nothing sent".
 */
export async function enterPrivateText(page: Page, selectors: readonly string[], text: string): Promise<void> {
  if (!(await focusComposer(page, selectors))) {
    throw new PrivateReplyError('Kotak pesan pribadi tidak bisa difokuskan — tidak ada yang diketik', 'private_composer_closed');
  }
  await page.keyboard.sendCharacter(text);
  const typed = await readComposerText(page, selectors);
  if (normaliseWhitespace(typed ?? '') !== normaliseWhitespace(text)) {
    throw new PrivateReplyError(
      `Teks tidak masuk utuh ke kotak pesan pribadi (${(typed ?? '').length} dari ${text.length} karakter) — tidak dikirim`,
      'private_type_failed',
    );
  }
}

/**
 * Waits for the dialog's "Send Message" to accept the text.
 *
 * Measured live: it stays `aria-disabled="true"` for a few hundred ms after the
 * text lands, and a click in that window is silently ignored — nothing is sent,
 * and the only symptom is a confirmation that never comes.
 */
export async function waitForSendEnabled(page: Page, budgetMs: number, pollMs = 150): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if ((await readPrivateSendState(page)) === 'enabled') return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Whether the message reached the customer's conversation and stayed there.
 *
 * Every reading is a FRESH read of the conversation, supplied by the caller.
 * Measured live: a Business Suite tab opened before the send never showed the
 * delivered private reply, while a fresh load of the same conversation did —
 * so the one delivery on record was reported as a failure. A reading that
 * could not be taken counts as "not seen yet", never as delivered, and a
 * sighting has to survive a dwell and a second fresh read.
 */
export async function confirmPrivateDelivery(
  read: () => Promise<number | null>,
  before: number,
  opts: { checksAtMs: readonly number[]; dwellMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<boolean> {
  const wait = opts.sleep ?? sleep;
  let at = 0;
  for (const checkAt of opts.checksAtMs) {
    if (checkAt > at) {
      await wait(checkAt - at);
      at = checkAt;
    }
    const count = await read();
    if (count === null || count <= before) continue;
    await wait(opts.dwellMs);
    at += opts.dwellMs;
    const again = await read();
    if (again !== null && again > before) return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
