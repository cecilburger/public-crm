import type { Page } from 'puppeteer';
import { SessionExpiredError, clickButtonByText } from './dmScraperPuppeteer.ts';
import { ThrottledError } from './commentScraper.ts';

const IG_APP_ID = '936619743392459';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The reply was typed but Instagram never showed it as posted. Distinct from
 * an outright rejection, and treated the same way the DM sender treats its
 * own version: the caller may retry, and the retry is made safe by checking
 * what is already there first. */
export class ReplyNotConfirmedError extends Error {}

/** The profile offers no way to start a DM. Not a retryable failure: a
 * private account, or one that does not accept messages from strangers, will
 * answer the same way every time. */
export class NoDmButtonError extends Error {}

/**
 * Posting a reply under one of our own posts — the loud half of this feature.
 *
 * Kept in its own file, away from the reader, because the difference matters:
 * reading is invisible to everyone, while this speaks in public under the
 * workspace's own name and cannot be taken back quietly. Everything here is
 * therefore written to be repeatable without repeating itself — a retry that
 * double-posts under a brand's post is worse than a retry that fails.
 */
export async function replyToComment(
  page: Page, args: { mediaId: string; commentRef: string; text: string; ownUsername: string },
): Promise<void> {
  const text = args.text.trim();
  if (!text) return;

  // Same-origin, so the session cookie rides along. A page that is not on
  // instagram.com would post to the wrong origin entirely.
  if (!page.url().includes('instagram.com')) {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  if (page.url().includes('/accounts/login')) {
    throw new SessionExpiredError('Sesi Instagram sudah tidak aktif — silakan login ulang');
  }

  // A retry lands here for the same comment. If our reply is already up —
  // including one whose previous attempt reached Instagram and only looked
  // like it failed — saying it again posts a real duplicate under a public
  // post. This is the DM sender's pre-send check, applied to the louder
  // channel where a duplicate is more embarrassing.
  if (await alreadyReplied(page, args)) return;

  const csrf = await csrfToken(page);
  const body = `comment_text=${encodeURIComponent(text)}&replied_to_comment_id=${encodeURIComponent(args.commentRef)}`;

  const raw = await page.evaluate(`
    (async function () {
      try {
        var res = await fetch('/api/v1/web/comments/${args.mediaId}/add/', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-csrftoken': ${JSON.stringify(csrf)},
            'x-ig-app-id': '${IG_APP_ID}',
            'x-requested-with': 'XMLHttpRequest',
          },
          credentials: 'include',
          body: ${JSON.stringify(body)},
        });
        return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 1000) });
      } catch (err) {
        return JSON.stringify({ status: 0, body: String(err) });
      }
    })();
  `) as string;

  const res = JSON.parse(raw) as { status: number; body: string };
  if (res.status === 401 || res.status === 403) {
    throw new SessionExpiredError('Sesi Instagram sudah tidak aktif — silakan login ulang');
  }
  // 400 with a spam flag is Instagram refusing the *content or the pace*, not
  // the session. Worth reporting as a throttle so the caller backs off rather
  // than hammering a reply it will keep refusing.
  if (res.status === 429 || /spam|rate|limit|wait a few minutes/i.test(res.body)) {
    throw new ThrottledError(`Instagram menolak balasan komentar (${res.status}): ${summarise(res.body)}`);
  }
  if (res.status !== 200) {
    throw new Error(`Instagram menjawab ${res.status} saat membalas komentar: ${summarise(res.body)}`);
  }

  // A 200 is not agreement. These endpoints answer `{"status":"fail",...}`
  // with a perfectly healthy HTTP status, and reading only the status line
  // turned a refusal into "sent, but we cannot find it" — which hid the
  // reason Instagram gave us in plain text.
  let payload: { status?: unknown; message?: unknown; feedback_message?: unknown } = {};
  try {
    payload = JSON.parse(res.body);
  } catch {
    throw new Error(`Instagram membalas bukan JSON saat membalas komentar: ${summarise(res.body)}`);
  }
  if (payload.status !== 'ok') {
    const why = String(payload.feedback_message ?? payload.message ?? summarise(res.body));
    if (/spam|limit|try again|wait/i.test(why)) {
      throw new ThrottledError(`Instagram menolak balasan komentar: ${why}`);
    }
    throw new Error(`Instagram menolak balasan komentar: ${why}`);
  }

  // A 200 and a `status: ok` are still not proof. Confirmed live: both came
  // back twice while nothing whatsoever appeared under the post — Instagram
  // accepting a comment and then quietly discarding it is what a restricted
  // account looks like from the outside, and there is no field in the reply
  // that says so. Only looking is conclusive.
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(2000 * (attempt + 1));
    if (await alreadyReplied(page, args)) return;
  }
  throw new ReplyNotConfirmedError(
    'Instagram menjawab ok tapi balasannya tidak pernah muncul di postingan — '
    + `biasanya tanda akun sedang dibatasi untuk berkomentar (jawaban: ${summarise(res.body)})`,
  );
}

/**
 * Is our own reply to this comment already up?
 *
 * Replies live behind their own endpoint. Instagram's comment list reports
 * `child_comment_count` but leaves `preview_child_comments` empty, so a check
 * that reads only the list can never see a reply — confirmed the expensive
 * way: this answered "no reply" while two identical replies sat under the
 * post, and the second one was posted because of that answer. The count is
 * the signal; the children have to be fetched.
 */
export async function alreadyReplied(
  page: Page, args: { mediaId: string; commentRef: string; ownUsername: string },
): Promise<boolean> {
  const list = await getJson(page,
    `/api/v1/media/${args.mediaId}/comments/?can_support_threading=true&permalink_enabled=false`);
  if (!list) return false;

  const parent = ((list as { comments?: { pk?: unknown; child_comment_count?: unknown }[] }).comments ?? [])
    .find((c) => String(c.pk ?? '') === args.commentRef);
  if (!parent || Number(parent.child_comment_count ?? 0) === 0) return false;

  const children = await getJson(page,
    `/api/v1/media/${args.mediaId}/comments/${args.commentRef}/child_comments/`);
  if (!children) {
    // The parent says it has replies but we could not read them. Saying "no
    // reply" here is what causes a duplicate, so the safe answer is the
    // cautious one: assume one of them is ours and let a person decide.
    return true;
  }

  const own = args.ownUsername.toLowerCase();
  return ((children as { child_comments?: { user?: { username?: unknown } }[] }).child_comments ?? [])
    .some((c) => String(c.user?.username ?? '').toLowerCase() === own);
}

/** One authenticated GET through the page, parsed, or null. */
async function getJson(page: Page, path: string): Promise<unknown | null> {
  const raw = await page.evaluate(`
    (async function () {
      try {
        var res = await fetch(${JSON.stringify(path)}, {
          headers: { 'x-ig-app-id': '${IG_APP_ID}', 'accept': 'application/json' },
          credentials: 'include',
        });
        return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 2000000) });
      } catch (err) { return JSON.stringify({ status: 0, body: String(err) }); }
    })();
  `).catch(() => '') as string;

  if (!raw) return null;
  const res = JSON.parse(raw) as { status: number; body: string };
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/**
 * A thread with someone who has never messaged us.
 *
 * `discoverThreadId` next door can only find a row that is already in the
 * inbox, which a commenter by definition is not — answering a comment by DM
 * means starting the conversation, and the profile's own "Message" button is
 * the path a person would take. It returns the thread id that
 * `sendThreadMessage` already knows how to talk to, so nothing about sending
 * has to be duplicated here.
 *
 * Returns null rather than throwing when there is no button: an account can
 * simply not be reachable by DM (privacy settings, or one that blocked us),
 * and that is an outcome to record, not an error to retry.
 */
export async function openThreadWithUser(page: Page, username: string): Promise<string | null> {
  await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  });
  if (page.url().includes('/accounts/login')) {
    throw new SessionExpiredError('Sesi Instagram sudah tidak aktif — silakan login ulang');
  }

  // Locale-fragile by nature: Instagram renders this button in whatever
  // language the request's IP implies, which for this workspace is
  // Indonesian as often as English.
  const clicked = await clickButtonByText(page, /^(message|kirim pesan|pesan|send message)$/i, 8000);
  if (!clicked) {
    // No Message button on the profile does not mean the person is
    // unreachable. Instagram only offers that button on profiles the account
    // already has a relationship with; for everyone else the way in is the
    // inbox's own "new message" flow, which sends a message request. Falling
    // back to it is the difference between "we cannot DM this commenter" and
    // "we never tried" — and every commenter worth answering is, by
    // definition, someone we do not know yet.
    return await openThreadFromInbox(page, username);
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = /\/direct\/t\/([^/?]+)/.exec(page.url());
    if (match) return match[1] ?? null;
    await sleep(400);
  }
  return null;
}

/**
 * Start a thread from the inbox, for someone whose profile offers no button.
 *
 * This is the "new message" dialog a person would use: search the username,
 * tick the row, confirm. It sends a message request rather than a plain DM,
 * which is exactly right for a stranger who just commented.
 *
 * Every step reports what it actually saw when it fails, because this walks
 * a dialog whose markup Instagram changes without notice and a bare "could
 * not DM" taught us nothing for a whole evening.
 */
async function openThreadFromInbox(page: Page, username: string): Promise<string | null> {
  await page.goto('https://www.instagram.com/direct/new/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (page.url().includes('/accounts/login')) {
    throw new SessionExpiredError('Sesi Instagram sudah tidak aktif — silakan login ulang');
  }
  await sleep(2500);

  const searchBox = 'input[name="queryBox"], input[placeholder*="Search" i], input[placeholder*="Cari" i], input[aria-label*="Search" i]';
  const box = await page.waitForSelector(searchBox, { timeout: 10_000 }).catch(() => null);
  if (!box) throw new NoDmButtonError(`kotak pencarian DM tidak ditemukan saat mencoba mengirim ke @${username}`);

  await page.click(searchBox);
  await page.keyboard.sendCharacter(username);
  await sleep(3500);

  // The result row carries the username as its own text. Clicking the row is
  // what ticks it; there is no checkbox to target directly.
  const picked = await page.evaluate(`
    (function () {
      var wanted = ${JSON.stringify(username.toLowerCase())};
      var rows = Array.prototype.slice.call(
        document.querySelectorAll('div[role="button"], div[role="option"], li'));
      for (var i = 0; i < rows.length; i++) {
        var text = (rows[i].innerText || '').toLowerCase();
        if (text.split('\\n').indexOf(wanted) >= 0) { rows[i].click(); return true; }
      }
      return false;
    })();
  `).catch(() => false) as boolean;

  if (!picked) {
    const seen = await page.evaluate(`
      (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 300)
    `).catch(() => '') as string;
    throw new NoDmButtonError(
      `@${username} tidak muncul di hasil pencarian DM (yang tampil: ${seen.replace(/\s+/g, ' ').slice(0, 160)})`,
    );
  }

  await sleep(1200);
  await clickButtonByText(page, /^(chat|next|berikutnya|lanjut)$/i, 8000);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = /\/direct\/t\/([^/?]+)/.exec(page.url());
    if (match) return match[1] ?? null;
    await sleep(400);
  }
  return null;
}

/**
 * Did this text actually reach that person's thread? Asked of Instagram's own
 * inbox rather than of the page.
 *
 * The DM sender confirms by scraping the thread, and a message Instagram
 * decides is a *link* renders as a preview card instead of a plain bubble —
 * so the scrape misses it and reports a send that landed as a failure.
 * Nothing about that is rare here: the opener always names MCNAsia.biz, so
 * every single comment DM trips it, and a failure that is really a success
 * is the exact shape that gets a stranger messaged twice.
 */
export async function dmLanded(
  page: Page, username: string, text: string, opts: { sinceMs?: number } = {},
): Promise<boolean> {
  const inbox = await getJson(page, '/api/v1/direct_v2/inbox/?limit=20&thread_message_limit=5') as {
    inbox?: {
      threads?: {
        users?: { username?: unknown }[];
        items?: { text?: unknown; timestamp?: unknown; link?: { text?: unknown } }[];
      }[];
    };
  } | null;
  if (!inbox) return false;

  const wanted = normalise(text);
  const want = username.toLowerCase();

  for (const thread of inbox.inbox?.threads ?? []) {
    const withThem = (thread.users ?? []).some((u) => String(u.username ?? '').toLowerCase() === want);
    if (!withThem) continue;
    for (const item of thread.items ?? []) {
      // Instagram reports item timestamps in microseconds.
      const atMs = Number(item.timestamp ?? 0) / 1000;
      // Without this bound, confirming a send meant asking "does this text
      // exist in that thread?" — and a bot repeats itself constantly, so an
      // identical greeting sent half an hour earlier answered yes for a
      // message that never went out. Confirmed live: a reply recorded as
      // sent was nowhere on Instagram. A confirmation may only count a
      // message that arrived after the send began.
      if (opts.sinceMs && !(atMs >= opts.sinceMs)) continue;
      // A link item carries the message body under `link.text`, not `text`.
      const body = normalise(String(item.text ?? item.link?.text ?? ''));
      if (body && wanted && (body.startsWith(wanted.slice(0, 60)) || wanted.startsWith(body.slice(0, 60)))) {
        return true;
      }
    }
  }
  return false;
}

/** Same spirit as the DM scraper's own comparison: what Instagram renders is
 * never byte-identical to what we typed. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.cookies('https://www.instagram.com');
  const token = cookies.find((c) => c.name === 'csrftoken')?.value?.trim();
  if (!token) throw new SessionExpiredError('Sesi Instagram tidak membawa csrftoken — silakan login ulang');
  return token;
}

function summarise(body: string): string {
  return body.slice(0, 160).replace(/\s+/g, ' ');
}
