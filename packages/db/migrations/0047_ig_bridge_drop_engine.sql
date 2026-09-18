-- The Instagram bridge is no longer a choice between automation engines —
-- Playwright and Puppeteer (both driving the real instagram.com web UI, and
-- both eventually blocked by the same kinds of detection: a login form
-- field Playwright disagreed was visible, inbox rows with no navigable id,
-- headless Chromium rendering a blank page for an otherwise-valid session)
-- are replaced outright by `instagram-private-api` + `instagram_mqtt`,
-- which speak Instagram's own private mobile-app API and its real-time MQTT
-- channel instead of driving a browser at all. One engine, so the column
-- recording which one a tenant picked no longer means anything.

alter table ig_bridge_connections drop column if exists engine;
