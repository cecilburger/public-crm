import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';

const LOGIN_URL = 'https://www.instagram.com/accounts/login/';

export type LoginResult =
  | { status: 'ready'; username: string }
  | { status: 'challenge_required'; challengeType: 'two_factor' | 'checkpoint' | 'unknown' }
  | { status: 'failed'; error: string };

/**
 * Unofficial by construction: this drives the real instagram.com web UI with
 * a real (headless) Chromium profile, the same way `apps/wa-bridge` drives
 * WhatsApp Web — there is no supported "connect an account" API for this,
 * only the login form a person would use by hand. Instagram's own anti-abuse
 * systems watch for exactly this kind of automated login, so:
 *   - every tenant gets its own persistent Chromium profile (`userDataDir`),
 *     reused across restarts — a fresh login every time is the single
 *     biggest trigger for a "suspicious login" checkpoint, a repeated cold
 *     login is worse than one that resumes an existing cookie jar.
 *   - selectors below match the login form as of when this was written;
 *     Instagram changes this page's markup without notice, so a selector
 *     going stale here is expected maintenance, not a surprise.
 */
export class SessionManager {
  private contexts = new Map<string, BrowserContext>();
  private pendingChallenge = new Map<string, Page>();

  constructor(private authDir: string) {}

  private profileDir(tenantId: string): string {
    return path.join(this.authDir, tenantId);
  }

  /** Cheap, no browser involved — just "does this tenant have a saved profile". */
  async hasSession(tenantId: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(this.profileDir(tenantId));
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  private async closeContext(tenantId: string): Promise<void> {
    const ctx = this.contexts.get(tenantId);
    if (ctx) {
      this.contexts.delete(tenantId);
      this.pendingChallenge.delete(tenantId);
      await ctx.close().catch(() => {});
    }
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    try {
      const button = page.getByRole('button', { name: /Allow all cookies|Only allow essential/i }).first();
      await button.click({ timeout: 3000 });
    } catch {
      // No banner, or a shape this selector doesn't match — not worth failing the login over.
    }
  }

  /**
   * Reads the page for ~15s after submitting a form, classifying whatever
   * state it lands on. Polling the URL/DOM rather than racing several
   * `waitForSelector`s — Instagram's post-submit flow branches into enough
   * different shapes (home feed, "save info" dialog, 2FA, checkpoint, plain
   * inline error) that one flat poll loop is far easier to keep correct than
   * a pile of races.
   */
  private async classifyOutcome(page: Page): Promise<LoginResult> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const url = page.url();

      if (url.includes('/accounts/login/two_factor')) {
        return { status: 'challenge_required', challengeType: 'two_factor' };
      }
      if (url.includes('/challenge/')) {
        return { status: 'challenge_required', challengeType: 'checkpoint' };
      }
      if (!url.includes('/accounts/login')) {
        // Off the login page and onto anything else (home feed, "save info"
        // interstitial, onboarding) counts as signed in — dismiss whatever
        // dialog is in the way rather than trying to enumerate every one.
        try {
          await page.getByRole('button', { name: /Not now|Not Now/i }).first().click({ timeout: 2000 });
        } catch {
          // No such dialog — fine.
        }
        return { status: 'ready', username: '' };
      }

      const errorText = await page.locator('#slfErrorAlert, [role="alert"]').first()
        .textContent({ timeout: 500 }).catch(() => null);
      if (errorText && errorText.trim()) {
        return { status: 'failed', error: errorText.trim() };
      }

      await page.waitForTimeout(500);
    }
    return { status: 'failed', error: 'Waktu tunggu habis — halaman Instagram tidak merespons seperti yang diharapkan' };
  }

  async login(tenantId: string, username: string, password: string): Promise<LoginResult> {
    await this.closeContext(tenantId);

    const context = await chromium.launchPersistentContext(this.profileDir(tenantId), {
      headless: true,
      viewport: { width: 1280, height: 900 },
    });
    this.contexts.set(tenantId, context);

    const page = context.pages()[0] ?? await context.newPage();
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.dismissCookieBanner(page);

      const usernameInput = page.locator('input[name="username"]');
      await usernameInput.waitFor({ timeout: 10_000 });
      await usernameInput.fill(username);
      await page.locator('input[name="password"]').fill(password);
      await page.locator('button[type="submit"]').first().click();

      const result = await this.classifyOutcome(page);
      if (result.status === 'challenge_required') {
        this.pendingChallenge.set(tenantId, page);
      } else if (result.status === 'ready') {
        return { status: 'ready', username };
      } else {
        await this.closeContext(tenantId);
      }
      return result;
    } catch (err) {
      await this.closeContext(tenantId);
      return { status: 'failed', error: err instanceof Error ? err.message : 'Gagal membuka halaman login Instagram' };
    }
  }

  async submitChallenge(tenantId: string, code: string): Promise<LoginResult> {
    const page = this.pendingChallenge.get(tenantId);
    if (!page) return { status: 'failed', error: 'Tidak ada proses login yang menunggu kode' };

    try {
      const codeInput = page.locator(
        'input[name="verificationCode"], input[name="security_code"], input[aria-label*="code" i]',
      ).first();
      await codeInput.waitFor({ timeout: 10_000 });
      await codeInput.fill(code);
      await page.getByRole('button', { name: /Confirm|Submit|Next/i }).first().click();

      const result = await this.classifyOutcome(page);
      if (result.status !== 'challenge_required') this.pendingChallenge.delete(tenantId);
      if (result.status === 'failed') await this.closeContext(tenantId);
      return result;
    } catch (err) {
      await this.closeContext(tenantId);
      return { status: 'failed', error: err instanceof Error ? err.message : 'Gagal mengirim kode verifikasi' };
    }
  }

  async logout(tenantId: string): Promise<void> {
    await this.closeContext(tenantId);
    await fs.rm(this.profileDir(tenantId), { recursive: true, force: true }).catch(() => {});
  }
}
