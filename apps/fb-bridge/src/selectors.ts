/**
 * Every piece of knowledge about Facebook's own markup, in one file.
 *
 * WHY THIS FILE EXISTS AT ALL: Facebook ships UI changes without notice, and a
 * scraper's selectors going stale is routine maintenance, not an incident. When
 * that happens the fix has to be one file to open and a handful of constants to
 * correct — `apps/ig-bridge` spread its selectors as string literals across six
 * functions in two files, and re-finding them all is the expensive part of every
 * repair. Nothing outside this file may contain a Facebook selector, a
 * facebook.com URL, or an assumption about attribute names.
 *
 * HOW TO REPAIR IT: open the relevant surface in a normal browser, inspect the
 * element, and correct the constant. Every list below is tried in order and the
 * first that matches wins, so adding a new variant in front of the old one is
 * safe and does not break anyone still on the previous UI.
 *
 * STATUS OF THESE VALUES — read this before trusting them. They are written to
 * the structures Facebook's accessibility tree has used for its Messenger and
 * Page surfaces (roles, aria-labels, and the `/t/<id>` link shape), which are
 * the most durable handles available: they are driven by accessibility
 * requirements rather than by styling, so they survive visual redesigns that
 * shatter class-name selectors. They have NOT been verified against a live
 * logged-in Facebook session from this workspace, because doing so would mean
 * logging a real account in. Treat the first live run as the verification step:
 * the parsers log loudly and the bridge emits `session_error` when a selector
 * matches nothing, precisely so a stale selector is visible within one cycle
 * instead of looking like "no new messages".
 */

/* -------------------------------------------------------------------- URLs */

export const URLS = {
  base: 'https://www.facebook.com',
  login: 'https://www.facebook.com/login',
  /** The Messenger inbox the long-lived observer page sits on. */
  inbox: 'https://www.facebook.com/messages/t/',
  thread: (threadId: string) => `https://www.facebook.com/messages/t/${threadId}/`,
  /**
   * A Page's own posts, where the comment watcher reads from.
   *
   * Two URL shapes, because Facebook has two kinds of Page id. A classic Page
   * lives at `/<id>/posts`. The newer profile-style Pages — 15-digit ids
   * beginning 61… — are not reachable that way at all: confirmed live,
   * `/61594393176093/posts` renders "Konten Ini Tidak Tersedia Saat Ini",
   * while `profile.php?id=61594393176093` loads the Page normally. Picking the
   * wrong one costs a silent empty sweep, since a page with no posts on it and
   * a page that does not exist look identical to a comment parser.
   */
  pagePosts: (pageId: string) => (/^\d{6,}$/.test(pageId)
    ? `https://www.facebook.com/profile.php?id=${pageId}`
    : `https://www.facebook.com/${pageId}/posts`),
  post: (postId: string) => `https://www.facebook.com/${postId}`,
  /**
   * One post, opened directly, with a comment singled out.
   *
   * Acting on a comment used to start from the Page's whole timeline and hunt
   * for it there — which worked only while the comment happened to be near the
   * top. Confirmed live: a public reply landed that way, and the private
   * message on the SAME comment minutes later returned "comment not found",
   * because by then the feed had not rendered that far. The permalink is the
   * post itself, so the comment is always on the page that opens, and
   * `comment_id` asks Facebook to surface it.
   */
  postPermalink: (pageId: string, postId: string, commentId?: string) => {
    const base = `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(postId)}`
      + `&id=${encodeURIComponent(pageId)}`;
    return commentId ? `${base}&comment_id=${encodeURIComponent(commentId)}` : base;
  },
} as const;

/** Any URL whose path says we are looking at a login wall rather than content —
 * the single signal that a persisted session has expired. */
export const LOGGED_OUT_URL_MARKERS = ['/login', '/checkpoint', '/recover', '/two_step_verification'] as const;

/** A URL that means Facebook wants a human: a checkpoint, a 2FA prompt, or an
 * account review. Distinguished from a plain logged-out state because the
 * operator has to solve it interactively and no amount of retrying helps. */
export const CHECKPOINT_URL_MARKERS = ['/checkpoint', '/two_step_verification', '/confirmemail'] as const;

/** Pulls the thread id out of any Messenger URL or link href. */
export const THREAD_ID_RE = /\/(?:messages\/)?t\/([^/?#]+)/;

/** Facebook's own message id, wherever it happens to be exposed — an
 * attribute value, a data-* payload, occasionally an element id. Matched
 * loosely on purpose: which attribute carries it changes, the shape does not. */
export const MESSAGE_ID_RE = /\bmid\.\$?[A-Za-z0-9_$-]{6,}/;

/** Facebook comment ids are long digit strings; they show up in `id`,
 * `data-*` and in permalink hrefs as `comment_id=<digits>`. */
export const COMMENT_ID_RE = /(?:comment_id=|comment_fbid=)(\d{6,})/;
/**
 * The other way Facebook writes the same parameter, and the one the live Page
 * timeline uses: base64 of `comment:<post id>_<comment id>`, URL-encoded.
 *
 * Both forms are on the page at once — a comment's own permalink carries this
 * one, while a link back to the comment it replies to can carry the numeric
 * one. A reader that knew only the numeric form therefore read the PARENT's id
 * off a reply and filed two different comments under one id.
 */
export const COMMENT_ID_B64_RE = /(?:comment_id|comment_fbid)=([A-Za-z0-9+/_-]{12,}(?:%3D|=){0,2})/i;
export const COMMENT_ID_DECODED_RE = /^comment:(\d{6,})_(\d{6,})$/;
export const COMMENT_ID_ATTR_RE = /^(?:comment-)?(\d{10,})$/;
/**
 * A reply's own permalink, as the live Page renders it: `comment_id=<the
 * comment it answers>&reply_comment_id=<the reply itself>`. Read on its own,
 * `comment_id` there is the PARENT — so this is both the reply's id and the
 * only place its parent is named.
 */
export const REPLY_COMMENT_ID_RE = /reply_comment_id=(\d{6,})/;

/** `story_fbid=<id>` / `/posts/<id>` / `/videos/<id>` — the post a comment sits on. */
/**
 * A post's id from any of the link shapes Facebook uses for it. `story_fbid`
 * carries either a numeric id or, on the current Page feed, an opaque
 * `pfbid…` slug — confirmed live on the Page's own timeline, where every post
 * permalink was `permalink.php?story_fbid=pfbid0…&id=<pageId>`. The slug is a
 * perfectly good id: stable, unique, and the thing every comment permalink on
 * that post also carries. A first version accepted only digits and silently
 * dropped every comment on the Page as "no post".
 */
export const POST_ID_RE = /(?:story_fbid=(pfbid[A-Za-z0-9]+|\d{6,})|\/posts\/(pfbid[A-Za-z0-9]+|\d{6,})|\/videos\/(\d{6,}))/;

/** A profile link's numeric id, the commenter's identity when it is there. */
export const PROFILE_ID_RE = /(?:profile\.php\?id=(\d{6,})|facebook\.com\/(\d{10,})(?:[/?]|$))/;

/* --------------------------------------------------------- inbox / threads */

export const INBOX = {
  /** The scrollable conversation list. First match wins. */
  list: ['div[aria-label="Chats"]', 'div[role="grid"]', 'div[role="navigation"] div[role="list"]'],
  /** One conversation per row. Each carries an `href` to its own thread, which
   * is the single biggest difference from Instagram's inbox (whose rows carry
   * no id at all and had to be clicked to discover one). */
  rowLink: 'a[href*="/t/"]',
  /** The accessible name of a row, when the link's own text is not enough. */
  rowNameAttrs: ['aria-label', 'title'],
} as const;

export const THREAD = {
  /**
   * The message scrollback. The observer reads this container's `outerHTML`
   * and hands it to a pure parser — nothing interprets the DOM in the page.
   *
   * Confirmed live against the real site: Messenger renders the transcript as
   * an ARIA live region, `div[role="log"]`, labelled "Messages in conversation
   * with <name>". It is NOT a grid, and the `role="grid"` on the page belongs
   * to the *conversation list* on the left — pointing at that one made the
   * parser read inbox rows as if they were messages.
   */
  messageList: [
    'div[role="log"]',
    'div[aria-label^="Messages in conversation"]',
    'div[aria-label^="Pesan dalam percakapan"]',
  ],
  /**
   * One rendered message.
   *
   * There is no `role="row"` anywhere inside the transcript (confirmed live:
   * zero matches). Facebook marks each message with `data-scope="messages_table"`,
   * which is the one handle here that does not depend on the interface
   * language, so it is tried first; the labelled-descendant fallback behind it
   * catches a build where that attribute is absent, and the parser discards
   * whatever does not carry a message-shaped label.
   */
  row: [
    'div[role="log"] div[data-scope="messages_table"]',
    'div[data-scope="messages_table"]',
    'div[role="log"] div[aria-label]',
    // Last resort, for the older build the parser still supports. Harmless on
    // the current site: rows are only ever looked for *inside* the transcript
    // container, and the live transcript contains no `role="row"` at all — the
    // ones on the page belong to the conversation list, which is not searched.
    'div[role="row"]',
  ],
  /** Where a row's visible text lives, in preference order. */
  textNode: ['div[dir="auto"]', 'span[dir="auto"]'],
  /**
   * Attributes that carry a per-message timestamp. `data-utime` is unix
   * seconds; the tooltip/title variants are human-formatted strings that only
   * parse on a good day — `sentAt` is allowed to come back null rather than
   * guessed at, and the CRM falls back to arrival time when it does.
   */
  timeAttrs: ['data-utime', 'data-tooltip-content', 'title', 'datetime'] as const,
  /**
   * How a row says "this one is ours". Matched against a row's aria-label.
   * An inbound-only bridge must never mistake the operator's own reply for a
   * customer message, so anything matching here is dropped, and so is anything
   * whose sender cannot be established at all — see `parsers/messengerThread.ts`.
   */
  selfLabelRe: /^(you sent|you replied|anda mengirim|your message)\b/i,
  /** Row aria-labels of the form "Message from <name>" / "Pesan dari <name>",
   * which is where a sender name is exposed when the bubble itself has none. */
  senderLabelRe: /^(?:message|messages|pesan)\s+(?:from|dari)\s+(.+?)\s*$/i,
  /** The other label shape Facebook uses: "<name> sent a message" /
   * "<name> mengirim ...". Tried after `senderLabelRe` so the more specific
   * pattern wins when both could match. */
  senderSentLabelRe: /^(.+?)\s+(?:sent|replied|mengirim|membalas)\b/i,
  /** Last resort: the avatar beside a bubble is labelled with its sender. */
  avatarAlt: 'img[alt]',

  /**
   * Where a message carries Facebook's own id, in preference order.
   *
   * Confirmed live: the row holds it twice, as `data-message-id` and as `id`,
   * both reading `mid.$cAAAB...`. Named attributes are read before falling back
   * to a regex over the row's markup, because the attribute states which
   * message the id belongs to while a regex only states that an id appears
   * somewhere inside.
   */
  messageIdAttrs: ['data-message-id', 'id'] as readonly string[],

  /**
   * How a message actually arrives: sender and body encoded together in one
   * aria-label, with no separate node carrying either.
   *
   * Confirmed live, both shapes on the same message:
   *   "Pukul 1 Maret 2024 10.51, Anda: Kak masi ada ga kursi onex nya"
   *   "Masukkan, Pesan dikirim pukul 1 Maret 2024 10.51 oleh Anda: Kak masi ..."
   *
   * Capture 1 is the sender, capture 2 is the body. The "oleh/by" shape is
   * tried first because it is the more specific of the two — the other would
   * happily match it and take "Pesan dikirim pukul ... oleh Anda" as a name.
   *
   * The English wordings are the expected counterparts of the Indonesian ones
   * that were confirmed; they have not themselves been seen on a live
   * English-language account.
   */
  messageLabelRes: [
    /\b(?:oleh|by)\s+(.+?)\s*:\s*([\s\S]+)$/i,
    /^(?:pukul|at)\s+[^,]*,\s*(.+?)\s*:\s*([\s\S]+)$/i,
  ] as readonly RegExp[],

  /**
   * A sender name that means the connected account itself. Facebook writes the
   * first person rather than the Page's name ("Anda:" / "You:"), so comparing
   * against the configured Page name alone would never recognise our own
   * replies — and an inbound-only bridge that fails to recognise them ingests
   * the operator's own words as the customer's.
   */
  selfSenderRe: /^(?:anda|you|kamu|kau)$/i,

  /** Labels on controls that sit inside the transcript and are not messages. */
  rowChromeRe: /^(?:masukkan,\s*detail percakapan|enter,\s*conversation details|tindakan pesan|message actions)\b/i,
} as const;

/* ----------------------------------------------------------------- composer */

export const COMPOSER = {
  /**
   * The message box, confirmed live:
   *   role="textbox", contenteditable="true", data-lexical-editor="true",
   *   aria-label="Tulis ke <name>", aria-placeholder="Aa".
   *
   * Keyed structurally on purpose. The aria-label is localised *and* carries
   * the other party's name, so it identifies one conversation rather than the
   * composer. The fallback drops only `data-lexical-editor`, for a build that
   * stops emitting it; it still requires both the role and contenteditable, so
   * it cannot land on a search field (those are `<input>`, not an editable div).
   */
  box: [
    'div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ],

  /**
   * How long to wait for the composer before concluding the thread has none.
   *
   * Short by design. Confirmed live: a thread still sitting as a message
   * request renders its transcript perfectly and simply has no composer at all,
   * so waiting longer only delays a failure that is already certain.
   */
  waitMs: 8_000,

  /**
   * How long to wait for a sent message to appear in the transcript.
   *
   * There is no Send button to watch — the only controls beside the composer
   * are attachment, sticker, GIF, emoji and Like — so the message goes with
   * Enter and the transcript is the only evidence it left.
   */
  confirmMs: 12_000,
} as const;

/* ------------------------------------------------------------------ Page comments */

export const COMMENTS = {
  /**
   * Where a Page's posts and their comments are.
   *
   * Three, in this order, because two different pages are read through this
   * one name. A Page timeline has `div[role="feed"]`. A post permalink has no
   * feed at all: it renders the post in a modal that sits OUTSIDE
   * `div[role="main"]`, so main matched, contained no comments, and the read
   * came back empty while the post plainly had comments on it. The dialog is
   * therefore tried before main, and main stays last for the shapes that have
   * neither.
   */
  feed: ['div[role="feed"]', 'div[role="main"]'],
  /**
   * The same thing on a post's own permalink, which is a different page.
   *
   * `permalink.php` renders the post in a modal AND keeps a feed of other
   * posts behind it, so the feed-first list above picks the background — the
   * read then came back with the timeline's comments and none of the post's,
   * which is a silent miss, not an error. Here the modal wins, and the other
   * two remain for the renderings that have no modal.
   */
  postSurface: ['div[role="dialog"][aria-modal="true"]', 'div[role="main"]', 'div[role="feed"]'],
  /** One post within that feed. */
  post: ['div[role="article"]', 'div[data-pagelet^="FeedUnit"]'],
  /** One comment within a post. Facebook labels these in the accessibility
   * tree as "Comment by <name>", which is also where the author name comes
   * from when no profile link is rendered. */
  /**
   * One comment. TWO substrings, not one, and that is the whole point: a CSS
   * attribute match is CASE-SENSITIVE, so `*="omment"` matches "Comment by …"
   * and misses "Komentar oleh …" entirely. On an Indonesian-language session
   * every comment on the Page was therefore invisible to the parser — no
   * error, no dropped count, just an inbox that never showed a comment. The
   * `i` flag would be tidier and is not supported by the pure DOM parser these
   * selectors also run through, so both spellings are listed instead.
   */
  comment: [
    'div[role="article"][aria-label*="omment"]',
    'div[role="article"][aria-label*="omentar"]',
    'div[data-testid="UFI2Comment/root_depth_0"]',
  ],
  commentLabelRe: /^(?:comment|komentar)\s+(?:by|oleh)\s+(.+?)(?:\s*,.*)?$/i,
  /** The commenter's profile link — the only place their id appears. */
  authorLink: 'a[href*="/profile.php"], a[href^="https://www.facebook.com/"], a[role="link"][tabindex="0"]',
  /** The comment's own permalink, which carries `comment_id=`. */
  permalink: 'a[href*="comment_id="]',
  textNode: ['div[dir="auto"]', 'span[dir="auto"]'],
  timeAttrs: ['data-utime', 'data-tooltip-content', 'title'] as const,
} as const;

/* ------------------------------------------------------------------ signals */

/**
 * Text that means "you are not logged in", checked against the page body when
 * the URL alone is inconclusive. Facebook geo-localises its UI, so the
 * Indonesian wording is here alongside the English — an Indonesian-language
 * login wall that only matched English would read as a perfectly healthy page
 * with no messages in it, which is the worst possible failure mode: silent.
 */
export const LOGGED_OUT_TEXT_RE =
  /\b(log in to facebook|log into facebook|masuk ke facebook|create new account|buat akun baru)\b/i;

/** Text that means Facebook is asking a human to do something. */
export const CHECKPOINT_TEXT_RE =
  /\b(confirm your identity|security check|pemeriksaan keamanan|konfirmasi identitas|enter the code|masukkan kode|two-factor)\b/i;

/**
 * Relative timestamps ("4m", "2 jam", "Active now") tick over on their own with
 * no message having changed. `apps/ig-bridge` confirmed live that leaving these
 * in a row's change-signature makes the watcher re-read the thread forever, a
 * self-sustaining loop rather than a one-off. Stripped before comparing.
 */
export const VOLATILE_TEXT_RES: readonly RegExp[] = [
  /\bactive\s+(now|\d+\s*[a-z]+\s+ago)\b/gi,
  /\baktif\s+(sekarang|\d+\s*[a-z]+\s+(yang\s+)?lalu)\b/gi,
  /\b\d+\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|y|mnt|jam|hari|mgg|minggu|thn)\b/gi,
  /\b(just now|baru saja|kemarin|yesterday)\b/gi,
];

/* ------------------------------------------------- Meta Business Suite */

/**
 * A Page's own inbox, which is a different surface from `messages/t/`.
 *
 * Confirmed live: when the session is the Page identity, Messenger does NOT
 * serve the Page's conversations at facebook.com/messages/t/ at all. They live
 * in Meta Business Suite, and a watcher pointed at the old URL sweeps a
 * perfectly healthy personal inbox forever while a customer waits — the worst
 * shape of failure this bridge can have, because nothing errors.
 *
 * The messenger.com selectors above are deliberately untouched. A personal
 * inbox is still a real thing to read, and the two surfaces now have one
 * transport each rather than one set of selectors pretending to fit both.
 */
export const BIZ_URLS = {
  /**
   * The MESSENGER view, not "All messages". Confirmed live: the all-channels
   * view lists the Page's Instagram DMs beside its Messenger ones, with nothing
   * on the row to tell them apart, and a first version of this transport read
   * an Instagram conversation into the CRM as a Facebook one. Instagram is
   * another bridge's job; this one must not see it at all.
   */
  inbox: (assetId: string) =>
    `https://business.facebook.com/latest/inbox/messenger/?asset_id=${encodeURIComponent(assetId)}`,
  /**
   * A single conversation. `asset_id` says which Page's inbox, and
   * `selected_item_id` which conversation inside it — both are required, which
   * is why the asset id is connection state rather than anything derivable.
   */
  thread: (assetId: string, conversationId: string) =>
    `https://business.facebook.com/latest/inbox/all?asset_id=${encodeURIComponent(assetId)}`
    + `&selected_item_id=${encodeURIComponent(conversationId)}&thread_type=FB_MESSAGE`,
} as const;

/** The conversation id out of a Business Suite URL. */
export const BIZ_CONVERSATION_ID_RE = /[?&]selected_item_id=(\d{6,})/;
/**
 * Which platform a selected conversation belongs to. Read alongside the id,
 * because the id alone cannot say: a 15-digit id was a Messenger user and a
 * 39-digit one was Instagram on the day this was probed, and nothing
 * guarantees that shape. Only `FB_MESSAGE` is this bridge's to read.
 */
export const BIZ_THREAD_TYPE_RE = /[?&]thread_type=([A-Z_]+)/;
export const BIZ_MESSENGER_THREAD_TYPE = 'FB_MESSAGE';

/**
 * Where a message's direction is recorded.
 *
 * Business Suite states direction only in layout: the wrapper above an inbound
 * bubble computes `justify-content: flex-start`, an outbound one `flex-end`.
 * That is a computed style, so it exists in the stylesheet and NOT in the
 * markup — no amount of HTML parsing can recover it.
 *
 * So the in-page half measures it and stamps this attribute onto the clone it
 * serialises; the parser stays pure and reads nothing but the attribute. The
 * one differing atomic class (`x1nhvcw1` vs `x13a6bvl` at the time of writing)
 * is deliberately NOT used: those hashes are regenerated on Facebook's own
 * deploys, and the failure when one rotates is silent and severe — every agent
 * reply would be filed as something the customer said.
 */
export const DIRECTION_ATTR = 'data-kirana-direction';

export const BIZ_THREAD = {
  /** The pane holding one conversation's transcript and its composer. */
  detailView: ['span[data-surface*="bizweb_inbox:messenger_detail_view"]'],
  /** The transcript. An ARIA region, named in full by Business Suite. */
  messageList: [
    'div[role="region"][aria-label*="Message list container"]',
    'div[role="region"][aria-label*="Daftar pesan"]',
  ],
  /**
   * One message. Business Suite puts the body directly in this element's text
   * and exposes no per-message aria-label at all — the opposite of
   * messenger.com, where everything is encoded in the label. Which is why the
   * messenger.com transcript parser cannot be reused here, only its helpers.
   */
  row: [`[data-message-id]`],
  messageIdAttrs: ['data-message-id'],
  /** Facebook's own epoch-seconds stamp, when the surrounding group carries one. */
  timeAttrs: ['data-utime'],
  /** The header above the transcript, which is where the contact's name is —
   * the bubbles themselves never name a sender. */
  header: ['span[data-surface*="inbox:detail_view_header"]'],
  /** The conversation list. */
  list: ['span[data-surface*="bizweb_inbox:thread_list"]'],
} as const;

export const BIZ_COMPOSER = {
  /**
   * Lexical again, exactly as on messenger.com — so `page.type()` is just as
   * useless here, and the same CDP insertText path applies.
   */
  box: [
    'div[role="textbox"][contenteditable="true"][data-lexical-editor="true"][aria-placeholder*="Reply in Messenger"]',
    'div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]',
  ],
  /**
   * Business Suite renders no Send button; the only send-shaped control beside
   * the composer is "Send a Like". So Enter is the send, same as messenger.com.
   */
  waitMs: 12_000,
  confirmMs: 15_000,
} as const;

/**
 * The Business Suite conversation list.
 *
 * Confirmed live. Every conversation is a `data-surface` wrapper whose path
 * ends in `thread_rowN` (N counting from zero, newest first), holding a
 * `thread_title` surface with the contact's display name. The row carries NO
 * id and NO href — the only place Business Suite states which conversation is
 * open is the channel-selector tab links, whose hrefs all carry
 * `selected_item_id=<id>` for the CURRENT selection.
 *
 * So discovery is click-to-reveal: select a row, then read the id off those
 * links. Two things about the click were learned the hard way. A synthetic
 * mouse click at the row's centre does nothing — an invisible `a[role="row"]`
 * hover grid ("Move to Done", "Mark as Follow up") sits over the row and
 * swallows it. Dispatching `.click()` on the row's own `div[role="presentation"]`
 * wrapper selects it in well under a second. That grid is also why nothing
 * here matches `[role="row"]`: those are the destructive hover actions, not
 * the conversations.
 */
export const BIZ_INBOX = {
  list: ['span[data-surface*="bizweb_inbox:thread_list"]'],
  row: ['[data-surface*="thread_row"]'],
  rowTitle: ['[data-surface*="thread_title"]'],
  /** Pulls the `N` out of a row's surface path. */
  rowIndexRe: /thread_row(\d+)\s*$/,
  /** The element that actually receives the selecting click. */
  rowClickTarget: 'div[role="presentation"]',
  /**
   * The CONTAINER holding the channel tabs, not one tab.
   *
   * Two things learned the hard way. Reading a single `<a>` and then searching
   * for links inside it finds nothing — an element does not contain itself —
   * so this must be the container and the link chosen from within it. And the
   * tabs do not agree: confirmed live, the Messenger tab carries the selected
   * MESSENGER conversation while the Instagram tab simultaneously carries a
   * different, Instagram one. Taking "the first link" therefore reads whichever
   * platform happens to come first in the DOM.
   */
  selectedLinkContainer: [
    '[data-surface*="channel_selector"]',
    'div[role="tablist"]',
  ],
  /** The tab whose id is the one this transport means. */
  selectedLinkPreferredRe: /\/latest\/inbox\/messenger\b/,
  /** How long a click is given to be reflected in those links. Measured at
   * ~0.7s live; the budget is generous because a slow tab is not a failure. */
  revealMs: 8_000,
} as const;


/* ------------------------------------------------- comment actions */

/**
 * Acting on one comment on the Page's own post, at facebook.com/profile.php?id=.
 *
 * Confirmed live. The comment's stable handle is the `data-commentid` wrapper
 * around its `div[role="article"]`; inside the article the controls are plain
 * `[role="button"]`s carrying only visible text — "Reply", "Send message" — with
 * no aria-label, so they are matched by text. Reply opens a Lexical editor
 * whose placeholder names the commenter ("Reply to Gabe"); Send message opens a
 * modal dialog labelled "Message <name>" holding its own Lexical editor and an
 * explicit "Send Message" button. Nothing here relies on a class name.
 */
/**
 * The private-message dialog Facebook opens for a comment, by its own label.
 *
 * A bare `div[role="dialog"][aria-modal="true"]` is NOT this dialog on a post
 * permalink — the post is one too. See `COMMENT_ACTIONS.messageDialog`.
 */
const MESSAGE_DIALOG = [
  'div[role="dialog"][aria-modal="true"][aria-label^="Message"]',
  'div[role="dialog"][aria-modal="true"][aria-label^="Kirim pesan"]',
] as const;

/** The same selector, once per way Facebook labels the message dialog. */
const within = (selector: string): string[] => MESSAGE_DIALOG.map((dialog) => `${dialog} ${selector}`);

export const COMMENT_ACTIONS = {
  byId: (commentId: string) => `div[data-commentid="${commentId.replace(/[^0-9]/g, '')}"]`,
  /** Both spellings, for the same case-sensitivity reason as `COMMENTS.comment`. */
  article: 'div[role="article"][aria-label*="omment"], div[role="article"][aria-label*="omentar"]',
  replyButtonRe: /^(?:reply|balas)$/i,
  replyEditor: [
    'div[role="textbox"][data-lexical-editor="true"][aria-placeholder^="Reply to"]',
    'div[role="textbox"][data-lexical-editor="true"][aria-placeholder^="Balas"]',
  ],
  /** Our own reply, once it exists: an article labelled with the Page's name.
   * Facebook writes "Reply by <name>" or "Comment by <name>" depending on
   * nesting, so both are accepted. */
  ownReplyLabelRe: (pageName: string) =>
    new RegExp(`^(?:reply|comment|balasan|komentar)\\s+(?:by|oleh)\\s+${pageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  sendMessageButtonRe: /^(?:send message|kirim pesan)$/i,
  /**
   * The private-message dialog, named by its OWN label — never "whatever modal
   * is open".
   *
   * `permalink.php` renders the post itself inside
   * `div[role="dialog"][aria-modal="true"]`. Confirmed live, and expensively:
   * selectors scoped to "the modal" matched the POST's modal, so the private
   * reply was typed into the comment box under the post and Enter published it
   * as a public reply. Two of them, on the Page's own post, before the trace
   * showed what the surface actually was. Everything inside the message dialog
   * is therefore scoped to these, and nothing is scoped to a bare modal.
   */
  messageDialog: MESSAGE_DIALOG,
  messageEditor: within('div[role="textbox"][data-lexical-editor="true"]'),
  // Facebook spells the same control both ways depending on the surface, and
  // the comment row has a button of its own by that name — which is why these
  // are scoped to the message dialog and not to the page.
  messageSendButton: [
    ...within('[role="button"][aria-label="Send Message"]'),
    ...within('[role="button"][aria-label="Send message"]'),
    ...within('[role="button"][aria-label="Kirim Pesan"]'),
    ...within('[role="button"][aria-label="Kirim pesan"]'),
  ],
  waitMs: 10_000,
  // The private-DM confirmation window. Left at 20s: proven live to be enough
  // for a Messenger thread, which is a persistent conversation Facebook keeps
  // warm — unlike a fresh public reply, it has never been observed arriving
  // late here.
  confirmMs: 20_000,
  // The PUBLIC reply confirmation window — deliberately separate from
  // `confirmMs` above rather than one shared number raised for both. Confirmed
  // live: a reply on a genuinely fresh post can take longer than 20s for
  // Facebook's own backend to publish and render, well after the click, the
  // type and the Enter all succeeded — which once left the CRM holding a
  // terminal 'failed' status for a reply that Facebook had, in fact, already
  // posted. 60s is not an arbitrary bump; it is room for that observed publish
  // latency, scoped to the one flow that showed it.
  publicReplyConfirmMs: 60_000,
} as const;
