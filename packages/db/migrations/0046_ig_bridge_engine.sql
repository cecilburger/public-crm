-- A second automation engine (Puppeteer) alongside the existing Playwright
-- one for the Instagram bridge — offered as an alternative in Pengaturan on
-- the theory that Instagram's bot detection may key off signals more
-- specific to one engine's default fingerprint than the other. One row per
-- tenant still, same as before: a tenant picks one engine to connect with,
-- not both at once.

alter table ig_bridge_connections add column if not exists engine text not null default 'playwright'
  check (engine in ('playwright', 'puppeteer'));
