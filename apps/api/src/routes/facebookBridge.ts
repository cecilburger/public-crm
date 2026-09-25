import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { invalid, notFound, conflict, bridgeSessionKey, DEFAULT_DIVISION, type Actor } from '@kirana/core';
import {
  getFbBridgeConnection, setFbBridgeConnection, clearFbBridgeConnection, clearCommentDmError,
  ensureMessengerBridgeChannel, listFacebookComments, getFacebookComment, audit, channelHome,
  type FbBridgeConnection, type FacebookCommentRow,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * Pengaturan → Facebook: connects a tenant's Page to `apps/fb-bridge`.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT TAKE: a username, a password, a
 * session cookie, or any other credential. Unlike the Instagram bridge — which
 * proxies a real password through on its way to a login form — connecting
 * Facebook here only tells the bridge *which Page* to watch. The bridge then
 * opens a real browser window on the operator's machine and they log in by
 * hand, including any checkpoint or two-factor prompt. Nothing that could
 * authenticate as the account ever crosses this boundary or reaches this
 * database.
 *
 * That also makes the flow asynchronous, where Instagram's is synchronous: a
 * human login takes minutes, so `/connect` returns `awaiting_login` at once and
 * the console polls `/status`. Gated behind `channel:manage`, the same tier as
 * WhatsApp Web pairing and SMTP settings.
 *
 * Messenger replies do not go through here: they take the ordinary
 * conversation route and the outbound worker's `messenger_bridge` branch. The
 * only actions in this file are the two comment routes at the bottom, and they
 * enqueue rather than act — the worker's claim decides whether anything reaches
 * the bridge.
 */
/** Comments already logged as handed to a console (`fb_comment_inbox_visible`). */
const inboxShown = new Set<string>();
const INBOX_SHOWN_LIMIT = 5_000;

export function registerFacebookBridgeRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const bridgeCall = async <T>(path: string, init: RequestInit): Promise<{ ok: boolean; body: T | null }> => {
    try {
      const res = await fetch(`${ctx.env.FB_BRIDGE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${ctx.env.FB_BRIDGE_SECRET}` },
      });
      const body = res.status === 204 ? null : await res.json().catch(() => null);
      return { ok: res.ok, body: body as T | null };
    } catch (err) {
      app.log.warn({ err, path }, 'fb-bridge service unreachable');
      return { ok: false, body: null };
    }
  };

  interface BridgeState {
    status: FbBridgeConnection['status'];
    pageId: string | null;
    pageName: string | null;
    lastError: string | null;
  }

  /**
   * The bridge files each division's Page under its own browser profile:
   * Marketing's is the bare tenant id (every profile that existed before
   * divisions), any other division's carries a suffix. Derived rather than
   * read back, so a connect that has not written its row yet still addresses
   * the right profile.
   */
  const sessionOf = (actor: Actor): string => bridgeSessionKey(actor.tenantId, actor.divisionKey ?? DEFAULT_DIVISION);

  /**
   * A Page id is unique across the whole system (`channels_provider_key`), so
   * connecting one that another division — or another tenant — already holds
   * has to be refused before the channel upsert runs: that upsert would move
   * the row, and under row-level security it cannot even see the row it
   * would collide with. A read over the control pool, ids only.
   */
  const pageIsFree = async (actor: Actor, pageId: string): Promise<boolean> => {
    const home = await channelHome(ctx.control, 'messenger_bridge', pageId);
    return !home || (home.tenantId === actor.tenantId && home.divisionId === actor.divisionId);
  };
  const CROSS_DIVISION = 'Halaman ini sudah terhubung di divisi lain — putuskan di sana dulu';

  /**
   * The bridge is the source of truth for session state — it is the only thing
   * that can see whether the Chromium profile still holds a live login. This
   * database row is a cache of what it last said, refreshed on every read so
   * the console shows the real state rather than the state at connect time.
   *
   * When the bridge cannot be reached, the cached row is returned as-is with
   * the failure attached rather than overwritten: "the bridge is down" and "the
   * session expired" are different problems with different fixes, and flatting
   * one into the other would send the operator to re-login for an outage.
   */
  app.get('/v1/facebook-bridge/status', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const stored = await ctx.asTenant(req, (tx) =>
      getFbBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }));

    const live = await bridgeCall<BridgeState>(`/internal/sessions/${sessionOf(actor)}/status`, { method: 'GET' });
    if (!live.ok || !live.body) {
      return {
        ...stored,
        bridgeReachable: false,
        lastError: stored.lastError
          ?? 'Layanan Facebook Bridge tidak bisa dihubungi — pastikan sudah dijalankan (npm run dev:fb-bridge)',
      };
    }

    if (live.body.status !== stored.status || live.body.lastError !== stored.lastError) {
      await ctx.asTenant(req, (tx) =>
        setFbBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: live.body!.status,
          lastError: live.body!.lastError,
          lastSeenAt: live.body!.status === 'ready' ? new Date() : null,
          actorId: actor.userId,
        }));
    }

    /**
     * "Connected" has to mean the channel exists, and until this it did not.
     *
     * The bridge reports `ready` from the profile on its own disk, which
     * survives the CRM database being rebuilt — and this route then wrote that
     * status into a connection row while `ensureMessengerBridgeChannel` ran
     * only in `/connect`. The console read the row as connected, hid the
     * connect form, and left the operator with nothing but Disconnect (which
     * deletes the logged-in profile). Every inbound message meanwhile failed in
     * the worker with "no messenger_bridge channel" — a customer nobody
     * answers. Confirmed live.
     *
     * Idempotent, so it costs one no-op statement on a healthy workspace and
     * repairs a broken one the next time anybody opens the page.
     */
    const pageId = live.body.pageId ?? stored.pageId;
    const pageName = live.body.pageName ?? stored.pageName;
    // Never repaired across a division: a Page that another division holds
    // is that division's, and this one shows the conflict instead.
    if (live.body.status === 'ready' && pageId && pageName) {
      if (!(await pageIsFree(actor, pageId))) {
        return { ...stored, ...live.body, bridgeReachable: true, lastError: CROSS_DIVISION };
      }
      await ctx.asTenant(req, (tx) =>
        ensureMessengerBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          pageId, pageName, status: 'connected',
        }));
    }

    return { ...stored, ...live.body, bridgeReachable: true };
  });

  /**
   * Asks the bridge to open a login window for this tenant's Page.
   *
   * The channel row is created here, before the login has succeeded, on
   * purpose: the first message can arrive seconds after the operator finishes,
   * and the worker refuses to invent a channel for an event whose Page nobody
   * configured. Creating it up front with status 'connecting' means the very
   * first message lands correctly instead of failing once and needing a replay.
   */
  app.post('/v1/facebook-bridge/connect', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({
      pageId: z.string().min(1).max(120),
      pageName: z.string().min(1).max(200),
      /**
       * The Business Suite asset id, for a Page whose inbox lives there rather
       * than on messenger.com. Optional, and its absence is meaningful: a
       * connection without one is read as a personal account. Constrained to
       * digits because every Business Suite URL interpolates it, and a
       * malformed value produces a page that loads and holds nobody's
       * conversations.
       */
      assetId: z.string().regex(/^\d{6,}$/).max(40).optional(),
    }).safeParse(req.body);
    if (!body.success) {
      throw invalid('Isi ID dan nama Halaman Facebook yang mau dihubungkan');
    }

    // Refused before a login window is opened for it: nothing to clean up.
    if (!(await pageIsFree(actor, body.data.pageId))) throw conflict(CROSS_DIVISION);

    const sessionKey = sessionOf(actor);
    const call = await bridgeCall<BridgeState>(`/internal/sessions/${sessionKey}/login-window`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // The bridge keeps both beside the profile, so every event it later
      // posts can name the tenant without asking.
      body: JSON.stringify({ ...body.data, tenantId: actor.tenantId, sessionKey }),
    });
    if (!call.ok || !call.body) {
      throw invalid('Layanan Facebook Bridge tidak bisa dihubungi — pastikan sudah dijalankan (npm run dev:fb-bridge)');
    }

    await ctx.asTenant(req, async (tx) => {
      await ensureMessengerBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        pageId: body.data.pageId, pageName: body.data.pageName,
        status: call.body!.status === 'ready' ? 'connected' : 'connecting',
      });
      await setFbBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: call.body!.status, pageId: body.data.pageId, pageName: body.data.pageName,
        // Written as null rather than left undefined when absent, so
        // reconnecting a Page as a personal account really does clear it. Left
        // undefined it would keep an asset id the operator just removed, and
        // the bridge would go on reading a Business Suite inbox.
        assetId: body.data.assetId ?? null,
        lastError: call.body!.lastError, actorId: actor.userId,
      });
    });

    return {
      ...call.body,
      // Said plainly because the window opens on whichever machine runs the
      // bridge, which is not necessarily the machine the operator is reading
      // this on — a detail that is otherwise confusing at exactly the wrong moment.
      instruction: 'Jendela browser sudah dibuka di mesin yang menjalankan fb-bridge. '
        + 'Selesaikan login Facebook di sana secara manual, termasuk 2FA atau checkpoint kalau diminta.',
    };
  });

  /** Deletes the stored browser profile on the bridge as well as clearing the
   * row here — a disconnect that left a live logged-in profile on disk would be
   * a lie about what was revoked. */
  app.post('/v1/facebook-bridge/disconnect', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    await bridgeCall(`/internal/sessions/${sessionOf(actor)}`, { method: 'DELETE' });
    await ctx.asTenant(req, (tx) =>
      clearFbBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { actorId: actor.userId }));
    return { ok: true };
  });

  /**
   * Inbound Page comments.
   *
   * Read-only. Acting on a comment is a separate, explicit request (the routes
   * at the bottom of this file), never a side effect of reading one. Comments
   * are not conversations and this endpoint does not pretend otherwise.
   */
  app.get('/v1/facebook-bridge/comments', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      postId: z.string().max(120).optional(),
    }).safeParse(req.query);
    if (!query.success) throw invalid('Parameter tidak valid');

    const comments = await ctx.asTenant(req, (tx) =>
      listFacebookComments({ tx, tenantId: actor.tenantId, kek: ctx.kek }, query.data));
    return { comments };
  });

  /**
   * The same comments, for the inbox rather than for settings.
   *
   * A separate route because of one word. The settings listing above is guarded
   * by `channel:manage`, which belongs to admins and owners. The inbox belongs
   * to agents, and an agent holds `conversation:read` and not `channel:manage`
   * — so reusing that route would 403 for exactly the people the inbox is for,
   * and take the whole page down with it rather than hiding one section.
   *
   * Widening the settings route instead would have handed every agent the
   * permission that also exposes connection state and the disconnect control.
   * Reading what a customer wrote in public is not the same authority as
   * managing the channel it arrived on.
   */
  app.get('/v1/inbox/comments', async (req) => {
    const actor = ctx.guard(req, 'conversation:read');
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).safeParse(req.query);
    if (!query.success) throw invalid('Parameter tidak valid');

    const comments = await ctx.asTenant(req, (tx) =>
      listFacebookComments({ tx, tenantId: actor.tenantId, kek: ctx.kek }, query.data));
    // The last boundary of the inbound trace: the first time each comment is
    // actually handed to a console. Once per comment per process, ids only.
    for (const c of comments) {
      if (inboxShown.has(c.id)) continue;
      if (inboxShown.size >= INBOX_SHOWN_LIMIT) inboxShown.clear();
      inboxShown.add(c.id);
      req.log.info({
        event: 'fb_comment_inbox_visible', tenantId: actor.tenantId, divisionId: c.divisionId,
        rowId: c.id, postId: c.postId, commentId: c.commentId, parentCommentId: c.parentCommentId,
      }, 'fb_comment_inbox_visible');
    }
    return { comments };
  });

  /* ------------------------------------------------ acting on a comment */

  /**
   * An agent acting on one comment by hand: a reply on the post, or a private
   * message to its author.
   *
   * Both routes enqueue and do nothing else. The comment's status is not
   * touched here — the processor's claim moves it, inside the transaction that
   * makes a retry, a restart or a double-click unable to reply twice — and a
   * route that moved it first would race that claim, or record as replied
   * something the bridge then refused. What *is* decided here is whether the
   * request can possibly succeed, so the agent hears "already replied" now
   * rather than watching a job that quietly does nothing.
   *
   * The states allowed are exactly the states the claims accept: 'new' for a
   * reply, 'public_replied' with no dm_error for a message. 'failed' is refused
   * as well, and that is deliberate. The state machine makes a failed reply
   * terminal — retyping a reply the bridge typed but never saw is how a
   * customer's post ends up with two — so a 202 for it would enqueue a job the
   * claim refuses. The stored error goes back instead, and the agent can look
   * at Facebook and decide by hand.
   *
   * Guarded by `conversation:write`, the tier that sends a Messenger reply: a
   * viewer reads the inbox and does not speak for the Page. Independent of
   * FB_COMMENT_AUTO_DM on purpose — that flag stops the *system* choosing to
   * act, and says nothing about an agent choosing to.
   */
  interface CommentAction {
    /** The worker's COMMENT_REPLY_QUEUE / COMMENT_DM_QUEUE, spelled out here the
     * way every other queue name in the API is; the route test pins the two
     * spellings together so they cannot drift apart. */
    queue: 'facebook.comment.reply' | 'facebook.comment.dm';
    auditAction: string;
    /** Why this comment cannot take the action right now, or null when it can. */
    refusal(comment: FacebookCommentRow): string | null;
    /** True for the private message: an agent asking again may clear a
     * recorded failure, which the automated sweep may never do. */
    clearsDmError?: boolean;
  }

  const IN_FLIGHT = 'Komentar ini sedang diproses — tunggu sebentar';
  const TERMINAL = 'tidak bisa diulang dari sini — periksa di Facebook sebelum bertindak manual';

  const replyRefusal = (c: FacebookCommentRow): string | null => {
    switch (c.status) {
      case 'new': return null;
      case 'public_reply_pending': case 'dm_pending': return IN_FLIGHT;
      case 'public_replied': case 'dm_sent': return 'Komentar ini sudah dibalas secara publik';
      case 'failed':
        return `Balasan publik untuk komentar ini sudah pernah gagal (${c.publicReplyError ?? 'tanpa keterangan'}) dan ${TERMINAL}`;
    }
  };

  const dmRefusal = (c: FacebookCommentRow): string | null => {
    switch (c.status) {
      case 'public_replied':
        // A recorded failure no longer refuses a PERSON. The automated sweep
        // still treats it as terminal — `claimCommentForDm` refuses while
        // `dm_error` is set, and a loop must never re-send to a customer on
        // its own — but an agent can open Facebook, see whether anything went,
        // and decide. Refusing them left the comment behind an enabled button
        // that could never do anything, which is what happened live once the
        // environmental cause had already been fixed. The reset is deliberate
        // and audited: see `clearsDmError` in `enqueueCommentAction`.
        return null;
      case 'new': return 'Balas komentar ini secara publik dulu — pesan pribadi hanya bisa menyusul balasan publik';
      case 'public_reply_pending': case 'dm_pending': return IN_FLIGHT;
      case 'dm_sent': return 'Pesan pribadi untuk komentar ini sudah terkirim';
      case 'failed': return 'Balasan publik untuk komentar ini gagal, jadi tidak ada pesan pribadi yang bisa menyusul';
    }
  };

  const enqueueCommentAction = async (req: FastifyRequest, reply: FastifyReply, action: CommentAction) => {
    const actor = ctx.guard(req, 'conversation:write');
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!params.success) throw notFound('Comment');
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) throw invalid('Isi teks pesannya, paling banyak 2000 karakter');

    await ctx.asTenant(req, async (tx) => {
      const comment = await getFacebookComment({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { id: params.data.id });
      // Row-level security already hides another tenant's row, so a wrong id
      // and somebody else's id are the same answer — which is the point.
      if (!comment) throw notFound('Comment');
      const refusal = action.refusal(comment);
      if (refusal) throw conflict(refusal);

      // Who asked, recorded before the job exists. The worker writes no audit
      // row of its own, and a reply under the Page's name on a customer's post
      // is exactly the kind of action an audit has to be able to attribute.
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: action.auditAction,
        resourceType: 'facebook_comment', resourceId: comment.id,
        meta: { commentId: comment.commentId, postId: comment.postId, from: comment.status },
      });

      // A person asking again is allowed to clear a recorded failure; the
      // automated sweep is not. `claimCommentForDm` refuses while `dm_error`
      // is set — right for a loop that must never re-send to a customer on its
      // own, wrong for an agent who can open Facebook and check first. Without
      // this the comment sat behind an enabled button that could never do
      // anything, which is what happened live after an environmental failure
      // that had since been fixed.
      if (action.clearsDmError) {
        await clearCommentDmError({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { id: comment.id });
      }
    });

    // Dispatched after the transaction, as every other queued action is: a job
    // that ran before its audit row committed would be attributed to nobody.
    // `commentId` is the row id — the key the claim functions take — and not
    // Facebook's comment id, which the processor reads off the row itself.
    await ctx.dispatch({
      queue: action.queue,
      payload: { tenantId: actor.tenantId, commentId: params.data.id, text: body.data.text },
    });
    return reply.status(202).send({ queued: true });
  };

  app.post('/v1/facebook-bridge/comments/:id/reply-public', (req, reply) =>
    enqueueCommentAction(req, reply, {
      queue: 'facebook.comment.reply', auditAction: 'facebook_comment.reply_requested', refusal: replyRefusal,
    }));

  app.post('/v1/facebook-bridge/comments/:id/send-dm', (req, reply) =>
    enqueueCommentAction(req, reply, {
      queue: 'facebook.comment.dm', auditAction: 'facebook_comment.dm_requested', refusal: dmRefusal,
      clearsDmError: true,
    }));
}
