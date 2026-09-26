import {
  COMMENTS, COMMENT_ACTIONS, COMMENT_ID_ATTR_RE, COMMENT_ID_B64_RE, COMMENT_ID_DECODED_RE, COMMENT_ID_RE,
  POST_ID_RE, PROFILE_ID_RE, REPLY_COMMENT_ID_RE,
} from '../selectors.ts';
import {
  changeSignature, firstHrefMatch, isTimestampish, links, parseHtml, queryAll, queryFirst, textOf, textRuns,
  timestampFrom, type El,
} from './dom.ts';
import { postDetailsOf, type PostDetails } from './postDetails.ts';

export interface ParsedComment {
  /** Facebook's own comment id. Required — see `droppedNoId`. */
  commentId: string;
  postId: string;
  /** The comment this one answers when it is a reply; null for a top-level comment. */
  parentCommentId: string | null;
  authorId: string | null;
  authorName: string;
  text: string;
  commentedAt: string | null;
}

export interface ParsedComments {
  comments: ParsedComment[];
  /**
   * Comments found but discarded because no id could be read off them.
   *
   * There is no synthesised fallback here, unlike messages, and the difference
   * is deliberate: a DM arrives once, in a thread the bridge is watching
   * continuously, so a composite key over (thread, sender, position) is stable.
   * A comment is re-read from scratch on every reconciliation pass, under a
   * post whose comment list reorders itself ("Most relevant" vs "Newest") and
   * paginates — there is no position to key on that survives the next pass, so
   * a synthesised id would insert the same comment again on every sweep. Better
   * to drop it and say so loudly.
   */
  droppedNoId: number;
  /** Comments dropped for having no readable post id, which would leave them
   * unattributable. */
  droppedNoPost: number;
  /**
   * Comments the Page wrote itself — its replies to customers, and anything it
   * said first under its own post — dropped. They are not customers; ingested
   * they would sit in the inbox as a customer waiting for an answer.
   */
  droppedPageOwn: number;
  matchedComments: number;
  /**
   * Post articles seen, and how many of those carried no post link. A feed
   * still rendering shows post-shaped placeholders with no link in them, and
   * telling that apart from "this Page has no posts" is the whole diagnosis of
   * an empty sweep.
   */
  postArticles: number;
  postArticlesWithoutId: number;
  /**
   * Every post seen in this reading, newest first, whether or not it had a
   * comment on it.
   *
   * The timeline renders only the first comment or two under each post and
   * hides the rest behind "View more comments", so a reading of the timeline
   * alone silently misses comments — confirmed live, with a customer's second
   * question sitting on the post for an hour while the CRM showed nothing. The
   * caller uses these to go and read each post properly.
   */
  postIds: string[];
  /**
   * Each post's comment count, off its own summary ("3 comments",
   * "14 komentar"). A post whose summary is not rendered is absent. The
   * once-a-minute pulse compares these to decide which post to open: a count
   * that rose is a new comment or reply on that post.
   */
  commentCounts: Record<string, number>;
  /**
   * What each post is — its caption and its age — for the posts where either
   * could be read. The CRM names a comment group after its post with these
   * (`postDetails.ts`); the post id stays the identity.
   */
  postDetails: Record<string, PostDetails>;
}

/** The summary under a post: "3 comments", "1 comment", "14 komentar", "1,2 rb komentar", "2.4K comments". */
const COMMENT_COUNT_RE = /^([\d.,]+)\s*(rb|k|jt|m)?\s*(?:comments?|komentar)$/i;

/**
 * Reads Page comments off a rendered feed or a single post.
 *
 * Inbound only and inert. This returns data; nothing downstream replies to it,
 * direct-messages the author, moves them to WhatsApp, or hands them to a
 * chatbot. Those are separate features that do not exist yet, and this
 * deliberately stops at "the CRM knows the comment happened".
 *
 * Pure, same as the Messenger parsers: `outerHTML` in, structured comments out.
 */
export function parseFacebookComments(
  html: string,
  opts: {
    defaultPostId?: string | null; pageId?: string | null; pageName?: string | null;
    /** What a post's relative age ("2 days ago") counts back from. */
    now?: Date;
  } = {},
): ParsedComments {
  const root = parseHtml(html);
  const feed = queryFirst(root, COMMENTS.feed) ?? root;
  const now = opts.now ?? new Date();

  // Comments are found directly, not as descendants of a post scope. A comment
  // is itself a `div[role="article"]` — confirmed live — so a first version
  // that collected post articles and searched inside each swept the comment up
  // AS a post, searched its descendants, and found nothing. Each comment then
  // names its own post: the permalink on it carries `story_fbid=`, with the
  // enclosing post article as the fallback for a build that does not.
  const nodes = queryAll(feed, COMMENTS.comment);
  const postIds: string[] = [];
  const commentCounts: Record<string, number> = {};
  const postDetails: Record<string, PostDetails> = {};
  let postArticles = 0;
  let postArticlesWithoutId = 0;
  for (const post of queryAll(feed, COMMENTS.post)) {
    const label = post.getAttribute?.('aria-label') ?? '';
    if (/omment|omentar/i.test(label)) continue;
    postArticles += 1;
    const id = firstHrefMatch(post, POST_ID_RE);
    if (!id) { postArticlesWithoutId += 1; continue; }
    if (!postIds.includes(id)) postIds.push(id);
    const count = commentCountOf(post);
    if (count !== null && commentCounts[id] === undefined) commentCounts[id] = count;
    // An article that merely CONTAINS the post's link (a wrapper around the
    // post) has neither of its own, and must not stand in for the post.
    const details = postDetails[id] === undefined ? postDetailsOf(post, now) : null;
    if (details && (details.text !== null || details.createdAt !== null)) postDetails[id] = details;
  }
  const comments: ParsedComment[] = [];
  let droppedNoId = 0;
  let droppedNoPost = 0;
  let droppedPageOwn = 0;
  const matchedComments = nodes.length;
  for (const node of nodes) {
    const commentId = commentIdOf(node);
    if (!commentId) { droppedNoId += 1; continue; }
    const post = enclosingPost(node, feed);
    const postId = firstHrefMatch(node, POST_ID_RE)
      ?? (post ? firstHrefMatch(post, POST_ID_RE) : null)
      ?? opts.defaultPostId ?? null;
    if (!postId) { droppedNoPost += 1; continue; }
    const author = authorOf(node, commentId);
    const { authorId, authorName } = author;
    if (isPageOwn(author, opts)) { droppedPageOwn += 1; continue; }
    const text = bodyOf(node, authorName);
    // A bubble that rendered as a sticker or a GIF has no text to ingest.
    if (!text) continue;
    comments.push({
      commentId,
      postId,
      parentCommentId: parentOf(node, commentId),
      authorId,
      authorName,
      text,
      commentedAt: timestampFrom(node, COMMENTS.timeAttrs),
    });
  }
  return {
    comments, droppedNoId, droppedNoPost, droppedPageOwn, matchedComments, postIds, postArticles, postArticlesWithoutId,
    commentCounts, postDetails,
  };
}

/**
 * A post's comment count from its own summary — never from text inside one of
 * its comments, where a customer can write "5 comments" as easily as anything.
 */
function commentCountOf(post: El): number | null {
  for (const el of post.querySelectorAll('span[dir="auto"], div[role="button"]')) {
    if (nearestArticle(el) !== post) continue;
    const match = COMMENT_COUNT_RE.exec(textOf(el));
    if (match) return countValue(match[1]!, match[2]);
  }
  return null;
}

function nearestArticle(el: El): El | null {
  let node = el.parentNode as El | null;
  while (node && node.getAttribute?.('role') !== 'article') node = node.parentNode as El | null;
  return node;
}

/** "3" → 3; "1,2" + "rb" → 1200; "2.4" + "K" → 2400. Abbreviated counts are approximate, which only blunts the pulse. */
function countValue(digits: string, suffix: string | undefined): number {
  if (!suffix) return Number(digits.replace(/[.,]/g, ''));
  const base = Number(digits.replace(',', '.'));
  return Math.round(base * (/^(?:k|rb)$/i.test(suffix) ? 1_000 : 1_000_000));
}

interface CommentAuthor {
  authorId: string | null;
  authorName: string;
  /** Read off the comment's own author link, rather than guessed from the first profile link anywhere in it. */
  fromOwnLink: boolean;
}

/**
 * The comment's author, from the author's OWN anchor: the avatar and name
 * links the live Page writes as `<profile>?comment_id=<this comment>`. Any
 * other profile link inside a comment is someone it mentions — a customer
 * answering the Page's reply has the Page tagged in their text — and reading
 * the first profile link anywhere filed that customer as the Page.
 *
 * A profile with a username links by name (`facebook.com/sinta.uji`), which
 * carries no numeric id: the id is then null and the link's text is the name.
 * Renderings with no such anchor fall back to the old reading.
 */
function authorOf(node: El, commentId: string): CommentAuthor {
  const own = links(node).filter(({ href }) => idFromHref(href) === commentId && !POST_ID_RE.test(href));
  if (own.length > 0) {
    const authorId = own.map(({ href }) => profileIdOf(href)).find((id): id is string => id !== null) ?? null;
    const fromText = own.map(({ el }) => textOf(el).trim()).find((text) => text !== '') ?? '';
    return { authorId, authorName: fromText || authorNameOf(node), fromOwnLink: true };
  }
  return { authorId: firstHrefMatch(node, PROFILE_ID_RE), authorName: authorNameOf(node), fromOwnLink: false };
}

function profileIdOf(href: string): string | null {
  const m = PROFILE_ID_RE.exec(href);
  return m ? (m.slice(1).find((g) => g) ?? null) : null;
}

/**
 * Written by the Page itself. Read off the author's own link, the Page's id
 * decides, and for a Page that links by username its name does. Without that
 * link the reading is a guess, so both the id and the name have to agree —
 * dropping a real customer is the one mistake here that cannot be seen or
 * undone, while a Page comment that slips through is still recognised by the
 * CRM before anything answers it.
 */
function isPageOwn(author: CommentAuthor, page: { pageId?: string | null; pageName?: string | null }): boolean {
  const sameId = Boolean(page.pageId) && author.authorId === page.pageId;
  const sameName = Boolean(page.pageName)
    && author.authorName.trim().toLowerCase() === page.pageName!.trim().toLowerCase();
  if (author.fromOwnLink) return author.authorId ? sameId : sameName;
  return sameId && sameName;
}

/**
 * The comment a reply answers, read off the reply's own permalink
 * (`comment_id=<parent>&reply_comment_id=<this one>`). Only a link whose
 * `reply_comment_id` is this comment counts: a top-level comment that merely
 * contains its replies' links must not be filed as a reply to itself.
 */
function parentOf(node: El, commentId: string): string | null {
  for (const { href } of links(node)) {
    if (REPLY_COMMENT_ID_RE.exec(href)?.[1] !== commentId) continue;
    const parent = COMMENT_ID_RE.exec(href)?.[1];
    if (parent && parent !== commentId) return parent;
  }
  return null;
}

/** The nearest ancestor that is a post article rather than another comment,
 * or null when the comment is not inside one at all. */
function enclosingPost(node: El, stopAt: El): El | null {
  let parent = node.parentNode as El | null;
  while (parent && parent !== stopAt) {
    const role = parent.getAttribute?.('role');
    const label = parent.getAttribute?.('aria-label') ?? '';
    // "Comment by …" or "Komentar oleh …" — an article that is a comment is
    // not the post it sits under, in either localisation.
    if (role === 'article' && !/omment|omentar/i.test(label)) return parent;
    parent = parent.parentNode as El | null;
  }
  return null;
}

/** The permalink carries `comment_id=`; failing that, Facebook sometimes puts
 * the bare id on the element itself. */
function commentIdOf(node: El): string | null {
  // First link wins, in whichever form it writes the id. Order matters more
  // than form: a comment's own permalink comes before the link back to the
  // comment it replies to, and taking the first id of EITHER form is what
  // keeps a reply from inheriting its parent's.
  for (const { href } of links(node)) {
    const fromHref = idFromHref(href);
    if (fromHref) return fromHref;
  }
  for (const attr of ['id', 'data-commentid', 'data-testid']) {
    const value = node.getAttribute(attr)?.trim();
    const match = value ? COMMENT_ID_ATTR_RE.exec(value)?.[1] : null;
    if (match) return match;
  }
  return null;
}

/** One link's comment id, whichever of the forms it is written in. A reply's
 * own permalink names its parent in `comment_id` and itself in
 * `reply_comment_id`, so the latter wins whenever it is there. */
function idFromHref(href: string): string | null {
  const reply = REPLY_COMMENT_ID_RE.exec(href)?.[1];
  if (reply) return reply;
  const numeric = COMMENT_ID_RE.exec(href)?.[1];
  if (numeric) return numeric;
  const encoded = COMMENT_ID_B64_RE.exec(href)?.[1];
  return encoded ? decodeCommentId(encoded) : null;
}

/**
 * `Y29tbWVudDoxMjIxMDU0…` → `1090644533369851`.
 *
 * Decoded rather than pattern-matched on the encoded string, because base64
 * has no structure to match: the post id and the comment id run together in
 * the plain text, and only the plain text says which is which. Anything that
 * does not decode to `comment:<post>_<comment>` is not an id and is refused —
 * a guessed id would insert someone else's comment under this one's key.
 */
function decodeCommentId(encoded: string): string | null {
  let plain: string;
  try {
    plain = Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8');
  } catch {
    return null;
  }
  return COMMENT_ID_DECODED_RE.exec(plain)?.[2] ?? null;
}

/** Facebook labels a comment "Comment by <name>" in the accessibility tree;
 * when it does not, the first link inside a comment is the author's profile. */
function authorNameOf(node: El): string {
  const label = (node.getAttribute('aria-label') ?? '').trim();
  const fromLabel = COMMENTS.commentLabelRe.exec(label)?.[1]?.trim() ?? '';
  // The first profile link is usually the avatar and carries no text; the
  // name is the first profile link that has any. Confirmed live.
  const fromLink = links(node)
    .filter(({ href }) => PROFILE_ID_RE.test(href))
    .map(({ el }) => textOf(el).trim())
    .find((text) => text !== '') ?? '';

  // The label runs the name straight into the time — "Comment by Gabe a few
  // seconds ago", confirmed live, with no separator the regex could stop at —
  // so on its own it would file the customer as "Gabe a few seconds ago". The
  // author link's text is the bare name. When the label starts with it, the
  // link is the truth and the label only confirms it.
  if (fromLabel && fromLink && fromLabel.startsWith(fromLink)) return fromLink;
  return fromLabel || fromLink;
}

function bodyOf(node: El, authorName: string): string {
  const runs = textRuns(node, COMMENTS.textNode);
  const source = runs.length > 0 ? runs : [textOf(node)];

  return source
    .filter((run) => run && run !== authorName && !isTimestampish(run) && !isCommentChrome(run))
    .join('\n')
    .trim();
}

/**
 * "Like · Reply · 2 j" and its Indonesian counterpart sit inside the comment
 * element and have to be kept out of the body.
 *
 * Matched after the relative timestamp is stripped, not before: the run is
 * "Suka · Balas · 2 jam", and a word list that does not also know every way
 * Facebook writes "2 jam" would never match the whole string — which is how the
 * first version of this let the chrome through into the stored comment.
 */
function isCommentChrome(run: string): boolean {
  const withoutTime = changeSignature(run);
  return withoutTime.length > 0
    && /^(like|reply|suka|balas|share|bagikan|see more|lihat selengkapnya|·|\s)+$/i.test(withoutTime);
}

/**
 * How many replies under one comment are the Page's own and say exactly this.
 *
 * The proof that a public reply landed, on the same principle as message
 * sending: an emptied composer proves nothing, and "our text is somewhere on
 * the post" would report success off a reply made last week. A count, taken
 * before and after, is the only reading that means "a NEW one appeared".
 *
 * Scoped to the comment's `data-commentid` wrapper, so a reply the Page left
 * under a different comment on the same post cannot be counted here. The
 * wrapper's own article — the customer's comment — is skipped by label: it is
 * "Comment by <customer>", never by the Page.
 */
export function countOwnCommentReplies(
  html: string, opts: { pageName: string; text: string },
): number {
  const root = parseHtml(html);
  const wanted = opts.text.trim();
  const ownRe = COMMENT_ACTIONS.ownReplyLabelRe(opts.pageName);
  let count = 0;
  for (const article of queryAll(root, ['div[role="article"]'])) {
    const label = (article.getAttribute('aria-label') ?? '').trim();
    if (!ownRe.test(label)) continue;
    if (textOf(article).includes(wanted)) count += 1;
  }
  return count;
}
