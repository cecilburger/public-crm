-- A fourth state for the Instagram bridge: the operator is logging in by hand.
--
-- The three states this table has had until now all describe something the
-- bridge did on the operator's behalf with credentials it was handed. The
-- browser-login flow has no credential at all: a real Chromium window opens on
-- the machine running the bridge, the operator types into Instagram's own login
-- form, and the bridge waits. That wait can last minutes — a password, a 2FA
-- code from a phone, sometimes a checkpoint — and it is neither 'ready' nor
-- 'error' nor 'disconnected' while it lasts.
--
-- Without a state of its own the console has nothing true to show during those
-- minutes. 'disconnected' would invite the operator to start over on top of the
-- window already waiting for them, and 'ready' would be a lie the next sweep
-- would have to take back.
--
-- Distinct from 'challenge_required', which means the opposite thing: there the
-- bridge is driving the login and is blocked waiting for a code to be typed
-- into the CRM. Here the CRM is not in the loop at all.
alter table ig_bridge_connections drop constraint if exists ig_bridge_connections_status_check;
alter table ig_bridge_connections add constraint ig_bridge_connections_status_check
  check (status in ('disconnected', 'awaiting_login', 'challenge_required', 'ready', 'error'));
