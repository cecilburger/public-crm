-- Credentials for the roles the migrations create.
--
-- Roles are defined in migration 0001 (schema); passwords are granted here
-- (deployment). In production these come from the secret manager and this file
-- is not used — see docs/SECURITY.md, "Database credentials".
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kirana_app') then
    create role kirana_app login password 'kirana-app-local';
  else
    alter role kirana_app login password 'kirana-app-local';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'kirana_ingest') then
    create role kirana_ingest login password 'kirana-ingest-local';
  else
    alter role kirana_ingest login password 'kirana-ingest-local';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'kirana_provisioner') then
    create role kirana_provisioner login password 'kirana-provisioner-local';
  else
    alter role kirana_provisioner login password 'kirana-provisioner-local';
  end if;
end $$;

-- None of these may create tables, and none of them own anything.
revoke create on schema public from public;
