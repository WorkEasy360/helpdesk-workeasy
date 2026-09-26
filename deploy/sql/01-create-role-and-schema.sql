-- ---------------------------------------------------------------------------
-- Digisoft360 Help Desk — own role + own schema inside an EXISTING shared database.
--
-- Run ONCE, as a user allowed to create roles (the RDS master user or one with
-- rds_superuser / CREATEROLE), connected to the existing database the help desk will
-- live in. From the EC2 host (psql only needs to exist for this one step):
--
--   docker run --rm -it -v "$PWD/sql:/sql:ro" postgres:16-alpine \
--     psql "host=<writer-endpoint> port=5432 dbname=<existing_db> user=<admin> sslmode=require" \
--          -v pw='<helpdesk_app password>' -v db='<existing_db>' \
--          -f /sql/01-create-role-and-schema.sql
--
-- What this touches: it creates ONE role and ONE schema, and grants that role CONNECT
-- on the database. It does not alter, grant on, or revoke from any existing object,
-- role or schema — in particular it leaves `public` and its PUBLIC grants exactly as
-- they are, so other products using this database are unaffected.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- 1. The application role. LOGIN only: no superuser, createdb, createrole or
--    replication. The password is passed with -v pw=... so it never lands in a file.
CREATE ROLE helpdesk_app LOGIN PASSWORD :'pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Keep the app from hogging the shared cluster: api + worker use 2 x connection_limit
-- (10 each in DATABASE_URL) plus the one-off migrate job.
ALTER ROLE helpdesk_app CONNECTION LIMIT 30;

-- 2. Its own schema, owned by the role, so Prisma can create/alter tables, enums and
--    indexes there (and only there) during `prisma migrate deploy`.
--    PostgreSQL 16+ (and RDS, where the admin is not a true superuser) only lets the
--    creator hand ownership to the role while it may SET ROLE to it, so that is granted
--    for this one statement and withdrawn again.
GRANT helpdesk_app TO CURRENT_USER WITH SET TRUE;
CREATE SCHEMA helpdesk AUTHORIZATION helpdesk_app;
GRANT helpdesk_app TO CURRENT_USER WITH SET FALSE;

-- 3. Unqualified names resolve to helpdesk first. Prisma already sets search_path from
--    ?schema=helpdesk; this covers psql sessions and anything else connecting as the role.
ALTER ROLE helpdesk_app SET search_path = helpdesk;

-- 4. Let the role connect to this database (PUBLIC usually has CONNECT already; this
--    is explicit in case the DBA has revoked it). Affects only helpdesk_app.
GRANT CONNECT ON DATABASE :"db" TO helpdesk_app;

-- ---------------------------------------------------------------------------
-- Deliberately NOT done here:
--
--  * REVOKE ... ON SCHEMA public FROM PUBLIC — that would change what EVERY role in
--    the shared database may do. Don't.
--  * REVOKE ALL ON SCHEMA public FROM helpdesk_app — a no-op: helpdesk_app holds no
--    direct grant on public; whatever it can do there comes from PUBLIC. Since
--    PostgreSQL 15, PUBLIC has only USAGE (not CREATE) on public, so on Aurora
--    PostgreSQL 15+ the role already cannot create objects in public. On 14 and older,
--    PUBLIC may still have CREATE on public; the app never uses it (every migration
--    runs in schema helpdesk), and removing it is a decision for the database owner,
--    not for this app.
--  * CREATE EXTENSION — the migrations need none (scripts/check-migrations.sh enforces it).
-- ---------------------------------------------------------------------------

-- Verify (as admin):
--   \dn+ helpdesk
--   SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolconnlimit, rolconfig
--     FROM pg_roles WHERE rolname = 'helpdesk_app';
