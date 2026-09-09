import { z } from 'zod';

/**
 * Fail at boot, not at 2am. Every secret is required in production; development
 * gets defaults that are obviously not secrets.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().default(8080),

  DATABASE_URL: z.string().default('postgres://kirana:kirana@localhost:5432/kirana'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().default(20),
  /**
   * How the database is pooled in front of us.
   *
   * `transaction` means PgBouncer (or similar) hands a different server
   * connection to each transaction. That is safe for our tenant context — it is
   * set with `set_config(…, true)` and `set local role`, both of which end at
   * COMMIT — but it is *not* safe for named prepared statements, which are bound
   * to one server connection. Getting this wrong produces "prepared statement
   * does not exist" under load and nowhere else.
   */
  DATABASE_POOL_MODE: z.enum(['session', 'transaction']).default('session'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  /** 32 bytes, base64. Rotate by re-wrapping tenant DEKs — see docs/SECURITY.md. */
  KIRANA_KEK: z.string().default(Buffer.alloc(32, 7).toString('base64')),
  JWT_SECRET: z.string().min(32).default('dev-only-jwt-secret-change-me-000000'),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_S: z.coerce.number().int().default(60 * 60 * 24 * 30),

  META_APP_SECRET: z.string().default('dev-meta-app-secret'),
  META_VERIFY_TOKEN: z.string().default('dev-verify-token'),
  META_GRAPH_URL: z.string().default('https://graph.facebook.com/v21.0'),
  /**
   * Comma-separated CIDRs Meta's webhooks may come from. Empty means unset,
   * which allows any source — the signature is still required either way.
   */
  META_IP_ALLOWLIST: z.string().default(''),

  /**
   * The WhatsApp Web bridge (whatsapp-web.js + Puppeteer, QR-paired) — a
   * separate, unofficial channel from the Meta channel above. It runs as its
   * own service because a Chromium-backed session is heavy and crash-prone,
   * and one tenant's session dying must not touch the API or worker process.
   */
  WA_BRIDGE_URL: z.string().default('http://127.0.0.1:8090'),
  /** Shared secret between apps/api, apps/worker and apps/wa-bridge — this is
   * an internal service, never exposed publicly. */
  WA_BRIDGE_SECRET: z.string().default('dev-wa-bridge-secret-change-me'),

  /** Autopilot. With no ANTHROPIC_API_KEY the worker runs offline (see main.ts). */
  AUTOPILOT_MODEL: z.string().default('claude-opus-5'),
  AUTOPILOT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),

  /** Operations webhook for security alerts (Slack, PagerDuty…). Optional. */
  ALERT_WEBHOOK_URL: z.string().default(''),

  /**
   * SMTP connection string, e.g. smtps://user:pass@smtp.sendgrid.net:465.
   * Empty means email is logged rather than delivered — safe in development,
   * and loud about it.
   */
  /**
   * Bearer token protecting /metrics. Unset means the endpoint is open, which is
   * fine on a private network and careless on a public one — traffic volumes and
   * error rates are commercially interesting to a competitor.
   */
  METRICS_TOKEN: z.string().default(''),

  SMTP_URL: z.string().default(''),
  EMAIL_FROM: z.string().default('Kirana <halo@kirana.id>'),

  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(600),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    const weak = ['dev-only-jwt-secret-change-me-000000', 'dev-meta-app-secret', 'dev-verify-token',
                  'dev-wa-bridge-secret-change-me'];
    for (const [k, v] of Object.entries(parsed.data)) {
      if (typeof v === 'string' && weak.includes(v)) throw new Error(`${k} still holds its development default`);
    }
  }
  cached = parsed.data;
  return cached;
}
