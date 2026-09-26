import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, conflict, bridgeSessionKey, DEFAULT_DIVISION, type Actor } from '@kirana/core';
import {
  getIgBridgeConnection, setIgBridgeConnection, clearIgBridgeConnection, ensureInstagramBridgeChannel, channelHome,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * Pengaturan → Instagram: logs a tenant's Instagram account into
 * `apps/ig-bridge` — which speaks Instagram's own private mobile-app API via
 * `instagram-private-api` rather than driving a browser — by proxying the
 * real username/password through, once, over this request. Kirana's own
 * database never stores the password, only the username (for display) and
 * whatever status the bridge last reported. Gated behind `channel:manage`,
 * same tier as the WhatsApp Web pairing and SMTP settings.
 *
 * Every call here is synchronous end-to-end (unlike the WhatsApp bridge's
 * webhook-fed QR flow) — Instagram's login either resolves or asks for a
 * challenge code within the one request, so there is no separate event
 * pipeline to keep in sync, just "call the bridge, mirror what it said".
 *
 * One account per Marketing/AI division: the bridge files each division's
 * login under its own browser profile (`sessionOf`), and the connection row
 * this mirrors into is the request's division's.
 */
export function registerInstagramBridgeRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const bridgeCall = async <T>(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: T | null }> => {
    try {
      const res = await fetch(`${ctx.env.IG_BRIDGE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${ctx.env.IG_BRIDGE_SECRET}` },
      });
      const body = res.status === 204 ? null : await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body: body as T | null };
    } catch (err) {
      app.log.warn({ err, path }, 'ig-bridge service unreachable');
      return { ok: false, status: 502, body: null };
    }
  };

  type LoginResult =
    | { status: 'ready'; username: string }
    | { status: 'challenge_required'; challengeType: 'two_factor' | 'checkpoint' | 'unknown' }
    | { status: 'failed'; error: string };

  interface BridgeStatus {
    hasSession: boolean;
    awaitingLogin: boolean;
    username: string | null;
    captured: { sessionIdMasked: string; csrfToken: string | null; dsUserId: string | null; capturedAt: string } | null;
  }

  /** Marketing's profile is the bare tenant id (every profile that existed
   * before divisions); any other division's carries a suffix. */
  const sessionOf = (actor: Actor): string => bridgeSessionKey(actor.tenantId, actor.divisionKey ?? DEFAULT_DIVISION);

  /**
   * An Instagram handle is unique across the whole system
   * (`channels_provider_key`), so an account another division — or another
   * tenant — already holds has to be refused before the channel upsert runs:
   * that upsert would move the row, and under row-level security it cannot
   * even see the row it would collide with. A read over the control pool,
   * ids only.
   */
  const handleIsFree = async (actor: Actor, username: string): Promise<boolean> => {
    const home = await channelHome(ctx.control, 'instagram_bridge', username.trim());
    return !home || (home.tenantId === actor.tenantId && home.divisionId === actor.divisionId);
  };
  const CROSS_DIVISION = 'Akun Instagram ini sudah terhubung di divisi lain — putuskan di sana dulu';

  /** What every login request tells the bridge beside its own fields, so the
   * events it posts later can name the tenant without asking. */
  const identity = (actor: Actor) => ({ tenantId: actor.tenantId, sessionKey: sessionOf(actor) });

  /**
   * The stored row, reconciled against what the bridge can actually see.
   *
   * The password and cookie flows both settle inside their own request, so for
   * them this table was always current. The browser-login flow does not: the
   * operator is typing into Instagram on another machine, and the only thing
   * that knows when they finish is the bridge. Without reading through to it,
   * a connection would sit at `awaiting_login` in the console forever and the
   * operator would conclude it had failed.
   *
   * When the bridge cannot be reached the stored row is returned untouched
   * rather than overwritten — "the bridge is down" and "the session expired"
   * are different problems, and flattening one into the other sends the
   * operator to log in again for an outage.
   */
  app.get('/v1/instagram-bridge/status', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const stored = await ctx.asTenant(req, (tx) =>
      getIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }));

    const live = await bridgeCall<BridgeStatus>(`/internal/sessions/${sessionOf(actor)}/status`, { method: 'GET' });
    if (!live.ok || !live.body) return { ...stored, bridgeReachable: false, captured: null };

    const b = live.body;

    // A finished login on an account the other division already holds is
    // recorded as an error, never as a channel move.
    const refuse = async (username: string) => {
      await ctx.asTenant(req, (tx) =>
        setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'error', username, challengeType: null, lastError: CROSS_DIVISION, actorId: actor.userId,
        }));
      return { ...stored, status: 'error' as const, username, lastError: CROSS_DIVISION, bridgeReachable: true, captured: null };
    };

    // The transition this route exists for: a login window that has since been
    // finished. Writing it here means the console sees `ready` on its next poll
    // without the operator having to do anything else.
    // A session with no handle stays `awaiting_login` rather than being written
    // down as ready: `ensureInstagramBridgeChannel` keys the channel on the
    // username, and an empty one used to insert a second channel that split
    // the account's conversations in half. The bridge retries the lookup on
    // each of these polls, so this resolves itself within seconds.
    if (stored.status === 'awaiting_login' && b.hasSession && !b.awaitingLogin && b.username) {
      const username = b.username;
      if (!(await handleIsFree(actor, username))) return refuse(username);
      await ctx.asTenant(req, async (tx) => {
        await ensureInstagramBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { username });
        await setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'ready', username, challengeType: null, lastError: null, actorId: actor.userId,
        });
      });
      return { ...stored, status: 'ready' as const, username, bridgeReachable: true, captured: b.captured };
    }

    // A connection already marked ready but with no account name on it. The
    // first version of the browser-login flow could produce exactly this: a
    // healthy session stored with an empty username, which every screen
    // downstream rendered as "Terhubung sebagai @" and Chat IG read as "not
    // connected at all". Healed rather than left for the operator to notice.
    if (stored.status === 'ready' && !stored.username && b.username) {
      if (!(await handleIsFree(actor, b.username))) return refuse(b.username);
      await ctx.asTenant(req, async (tx) => {
        await ensureInstagramBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { username: b.username! });
        await setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'ready', username: b.username, challengeType: null, lastError: null, actorId: actor.userId,
        });
      });
      return { ...stored, username: b.username, bridgeReachable: true, captured: b.captured };
    }

    // The window was closed, or timed out, without a session ever appearing.
    // Checked by `!b.username`, not `!b.hasSession`: the bridge's `hasSession`
    // only asks whether the Chromium profile directory has anything in it at
    // all, which it does the moment the login window's browser launches —
    // true whether or not the operator ever finished logging in. A window
    // closed mid-login left `hasSession: true, username: null` here forever,
    // matching neither this branch nor the `ready` one above it, so the
    // console was stuck showing "menunggu login manual" with no window left
    // to finish it in and no way out short of restarting the bridge.
    if (stored.status === 'awaiting_login' && !b.awaitingLogin && !b.username) {
      await ctx.asTenant(req, (tx) =>
        setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'error', challengeType: null,
          lastError: 'Login lewat browser tidak selesai — jendelanya ditutup atau waktunya habis',
          actorId: actor.userId,
        }));
      return {
        ...stored, status: 'error' as const, bridgeReachable: true, captured: null,
        lastError: 'Login lewat browser tidak selesai — jendelanya ditutup atau waktunya habis',
      };
    }

    return { ...stored, bridgeReachable: true, captured: b.captured };
  });

  /**
   * Opens Instagram's own login page in a browser window on the bridge's
   * machine. No username, no password, no cookie: the operator authenticates
   * with Instagram directly and the session stays in the bridge's profile.
   *
   * Answers as soon as the window is open, not when the login finishes — the
   * console polls `/status` for that.
   */
  app.post('/v1/instagram-bridge/login-window', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');

    const call = await bridgeCall<{ status: string; error?: string }>(
      `/internal/sessions/${sessionOf(actor)}/login-window`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(identity(actor)),
      });
    if (!call.ok || !call.body) {
      throw invalid('Layanan Instagram Bridge tidak bisa dihubungi — pastikan sudah dijalankan (npm run dev:ig-bridge)');
    }

    await ctx.asTenant(req, (tx) =>
      setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: 'awaiting_login', challengeType: null, lastError: null, actorId: actor.userId,
      }));

    return {
      status: 'awaiting_login',
      // Said plainly because the window opens on whichever machine runs the
      // bridge, which is not necessarily the one the operator is reading this
      // on — confusing at exactly the wrong moment otherwise.
      instruction: 'Jendela browser sudah dibuka di mesin yang menjalankan ig-bridge. '
        + 'Selesaikan login Instagram di sana, termasuk 2FA atau verifikasi kalau diminta.',
    };
  });

  app.post('/v1/instagram-bridge/login', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({
      username: z.string().min(1).max(120), password: z.string().min(1).max(200),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Isi username dan password Instagram');
    // Refused before the bridge ever sees the password.
    if (!(await handleIsFree(actor, body.data.username))) throw conflict(CROSS_DIVISION);

    const call = await bridgeCall<LoginResult>(`/internal/sessions/${sessionOf(actor)}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: body.data.username, password: body.data.password, ...identity(actor) }),
    });
    if (!call.ok || !call.body) {
      throw invalid('Layanan Instagram Bridge tidak bisa dihubungi — pastikan sudah dijalankan (npm run dev:ig-bridge)');
    }
    const result = call.body;
    if (result.status === 'ready' && !(await handleIsFree(actor, result.username))) throw conflict(CROSS_DIVISION);

    await ctx.asTenant(req, async (tx) => {
      if (result.status === 'ready') {
        await ensureInstagramBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { username: result.username });
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'ready', username: result.username, challengeType: null, lastError: null, actorId: actor.userId,
        });
      }
      if (result.status === 'challenge_required') {
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'challenge_required', username: body.data.username,
          challengeType: result.challengeType, lastError: null, actorId: actor.userId,
        });
      }
      return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: 'error', username: undefined, challengeType: null,
        lastError: result.error, actorId: actor.userId,
      });
    });

    return result;
  });

  /**
   * The alternative to `/login`: a `sessionid` cookie lifted from a real,
   * manually-authenticated browser session (Instagram sees an ordinary
   * human login, never this route) instead of the account's password.
   * Resolves synchronously to `ready`/`failed` the same as `/login` — there
   * is no challenge step here, since importing an already-authenticated
   * session skips the login flow that would trigger one.
   */
  app.post('/v1/instagram-bridge/login-cookie', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({
      username: z.string().min(1).max(120), sessionId: z.string().min(1).max(4000),
      csrfToken: z.string().max(200).optional(), dsUserId: z.string().max(60).optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Isi username dan session cookie Instagram');
    if (!(await handleIsFree(actor, body.data.username))) throw conflict(CROSS_DIVISION);

    const call = await bridgeCall<LoginResult>(`/internal/sessions/${sessionOf(actor)}/login-cookie`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: body.data.username, sessionId: body.data.sessionId,
        csrfToken: body.data.csrfToken, dsUserId: body.data.dsUserId,
        ...identity(actor),
      }),
    });
    if (!call.ok || !call.body) {
      throw invalid('Layanan Instagram Bridge tidak bisa dihubungi — pastikan sudah dijalankan (npm run dev:ig-bridge)');
    }
    const result = call.body;
    if (result.status === 'ready' && !(await handleIsFree(actor, result.username))) throw conflict(CROSS_DIVISION);

    await ctx.asTenant(req, async (tx) => {
      if (result.status === 'ready') {
        await ensureInstagramBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { username: result.username });
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'ready', username: result.username, challengeType: null, lastError: null, actorId: actor.userId,
        });
      }
      return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: 'error', username: undefined, challengeType: null,
        lastError: result.status === 'failed' ? result.error : 'Gagal login dengan session cookie',
        actorId: actor.userId,
      });
    });

    return result;
  });

  app.post('/v1/instagram-bridge/challenge', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({ code: z.string().min(1).max(20) }).safeParse(req.body);
    if (!body.success) throw invalid('Isi kode verifikasi');

    const call = await bridgeCall<LoginResult>(`/internal/sessions/${sessionOf(actor)}/challenge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: body.data.code }),
    });
    if (!call.ok || !call.body) throw invalid('Layanan Instagram Bridge tidak bisa dihubungi');
    const result = call.body;
    if (result.status === 'ready' && !(await handleIsFree(actor, result.username))) throw conflict(CROSS_DIVISION);

    await ctx.asTenant(req, async (tx) => {
      if (result.status === 'ready') {
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'ready', username: result.username, challengeType: null, lastError: null, actorId: actor.userId,
        });
      }
      if (result.status === 'challenge_required') {
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'challenge_required', challengeType: result.challengeType,
          lastError: null, actorId: actor.userId,
        });
      }
      return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: 'error', challengeType: null, lastError: result.error, actorId: actor.userId,
      });
    });

    if (result.status === 'ready') {
      await ctx.asTenant(req, (tx) =>
        ensureInstagramBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { username: result.username }));
    }

    return result;
  });

  app.post('/v1/instagram-bridge/disconnect', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    await bridgeCall(`/internal/sessions/${sessionOf(actor)}`, { method: 'DELETE' });
    await ctx.asTenant(req, (tx) => clearIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
      actorId: actor.userId,
    }));
    return { ok: true };
  });
}
