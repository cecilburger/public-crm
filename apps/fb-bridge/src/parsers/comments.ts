import { COMMENTS, COMMENT_ID_ATTR_RE, COMMENT_ID_RE, POST_ID_RE, PROFILE_ID_RE } from '../selectors.ts';
import {
  changeSignature, firstHrefMatch, isTimestampish, links, parseHtml, queryAll, queryFirst, textOf, textRuns,
  timestampFrom, type El,
} from './dom.ts';

export interface ParsedComment {
  /** Facebook's own comment id. Required — see `droppedNoId`. */
  commentId: string;
  postId: string;
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
  matchedComments: number;
}

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
  html: string, opts: { defaultPostId?: string | null } = {},
): ParsedComments {
  const root = parseHtml(html);
  const feed = queryFirst(root, COMMENTS.feed) ?? root;

  // A feed of posts, or a single post page. When no post container matches, the
  // whole fragment is treated as one post so that a per-post read works with
  // exactly the same code as a feed read.
  const posts = queryAll(feed, COMMENTS.post);
  const scopes = posts.length > 0 ? posts : [feed];

  const comments: ParsedComment[] = [];
  let droppedNoId = 0;
  let droppedNoPost = 0;
  let matchedComments = 0;

  for (const scope of scopes) {
    const postId = firstHrefMatch(scope, POST_ID_RE) ?? opts.defaultPostId ?? null;
    const nodes = queryAll(scope, COMMENTS.comment);
    matchedComments += nodes.length;

    for (const node of nodes) {
      const commentId = commentIdOf(node);
      if (!commentId) { droppedNoId += 1; continue; }
      if (!postId) { droppedNoPost += 1; continue; }

      const authorName = authorNameOf(node);
      const text = bodyOf(node, authorName);
      // A comment with no text is a sticker or a photo reply. It is still a real
      // interaction, but there is nothing to record as its body and no way to
      // show it, so it is left out rather than stored blank.
      if (!text) continue;

      comments.push({
        commentId,
        postId,
        authorId: firstHrefMatch(node, PROFILE_ID_RE),
        authorName,
        text,
        commentedAt: timestampFrom(node, COMMENTS.timeAttrs),
      });
    }
  }

  return { comments, droppedNoId, droppedNoPost, matchedComments };
}

/** The permalink carries `comment_id=`; failing that, Facebook sometimes puts
 * the bare id on the element itself. */
function commentIdOf(node: El): string | null {
  for (const { href } of links(node)) {
    const fromHref = COMMENT_ID_RE.exec(href)?.[1];
    if (fromHref) return fromHref;
  }
  for (const attr of ['id', 'data-commentid', 'data-testid']) {
    const value = node.getAttribute(attr)?.trim();
    const match = value ? COMMENT_ID_ATTR_RE.exec(value)?.[1] : null;
    if (match) return match;
  }
  return null;
}

/** Facebook labels a comment "Comment by <name>" in the accessibility tree;
 * when it does not, the first link inside a comment is the author's profile. */
function authorNameOf(node: El): string {
  const label = (node.getAttribute('aria-label') ?? '').trim();
  const fromLabel = COMMENTS.commentLabelRe.exec(label)?.[1]?.trim();
  if (fromLabel) return fromLabel;

  const profileLink = links(node).find(({ href }) => PROFILE_ID_RE.test(href));
  const fromLink = profileLink ? textOf(profileLink.el) : '';
  return fromLink || '';
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
