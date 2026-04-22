
\set ON_ERROR_STOP on
BEGIN;

 
 \set ON_ERROR_STOP on
 BEGIN;
 
 -- 001_init.sql
 -- ENUMS
 CREATE TYPE user_role AS ENUM ('super_admin', 'supervisora', 'empleado');
 CREATE TYPE shift_state AS ENUM ('activo', 'finalizado', 'aprobado', 'rechazado');
 CREATE TYPE photo_type AS ENUM ('inicio', 'fin');
 -- ROLES
 CREATE TABLE roles (
	 id SERIAL PRIMARY KEY,
	 name user_role UNIQUE NOT NULL
 );
 -- USERS (extiende auth.users)
 CREATE TABLE users (
	 id UUID PRIMARY KEY REFERENCES auth.users(id),
	 email TEXT NOT NULL,
	 role_id INTEGER REFERENCES roles(id) NOT NULL,
	 created_at TIMESTAMPTZ DEFAULT NOW(),
	 updated_at TIMESTAMPTZ DEFAULT NOW()
 );
 -- RESTAURANTS
 CREATE TABLE restaurants (
	 id SERIAL PRIMARY KEY,
	 name TEXT NOT NULL,
	 lat DOUBLE PRECISION NOT NULL,
	 lng DOUBLE PRECISION NOT NULL,
	 radius INTEGER NOT NULL,
	 created_at TIMESTAMPTZ DEFAULT NOW(),
	 updated_at TIMESTAMPTZ DEFAULT NOW()
 );
 -- SHIFTS
 CREATE TABLE shifts (
	 id SERIAL PRIMARY KEY,
	 employee_id UUID REFERENCES users(id) NOT NULL,
	 restaurant_id INTEGER REFERENCES restaurants(id) NOT NULL,
	 start_time TIMESTAMPTZ NOT NULL,
	 end_time TIMESTAMPTZ,
	 start_lat DOUBLE PRECISION NOT NULL,
	 start_lng DOUBLE PRECISION NOT NULL,
	 end_lat DOUBLE PRECISION,
	 end_lng DOUBLE PRECISION,
	 state shift_state NOT NULL DEFAULT 'activo',
	 approved_by UUID REFERENCES users(id),
	 rejected_by UUID REFERENCES users(id),
	 created_at TIMESTAMPTZ DEFAULT NOW(),
	 updated_at TIMESTAMPTZ DEFAULT NOW()
 );
 -- Un solo turno activo por empleado (índice único parcial)
 CREATE UNIQUE INDEX one_active_shift_per_employee
 ON shifts (employee_id)
 WHERE state = 'activo';
 -- SHIFT_PHOTOS
 CREATE TABLE shift_photos (
	 id SERIAL PRIMARY KEY,
	 shift_id INTEGER REFERENCES shifts(id) NOT NULL,
	 user_id UUID REFERENCES users(id) NOT NULL,
	 url TEXT NOT NULL,
	 type photo_type NOT NULL,
	 taken_at TIMESTAMPTZ NOT NULL,
	 lat DOUBLE PRECISION NOT NULL,
	 lng DOUBLE PRECISION NOT NULL,
	 created_at TIMESTAMPTZ DEFAULT NOW(),
	 UNIQUE (shift_id, type)
 );
 -- INCIDENTS
 CREATE TABLE incidents (
	 id SERIAL PRIMARY KEY,
	 shift_id INTEGER REFERENCES shifts(id) NOT NULL,
	 description TEXT NOT NULL,
	 created_at TIMESTAMPTZ DEFAULT NOW(),
	 created_by UUID REFERENCES users(id) NOT NULL
 );
 -- SUPPLIES
 CREATE TABLE supplies (
	 id SERIAL PRIMARY KEY,
	 name TEXT NOT NULL,
	 unit TEXT NOT NULL,
	 created_at TIMESTAMPTZ DEFAULT NOW()
 );
 -- SUPPLY_DELIVERIES
 CREATE TABLE supply_deliveries (
	 id SERIAL PRIMARY KEY,
	 supply_id INTEGER REFERENCES supplies(id) NOT NULL,
	 restaurant_id INTEGER REFERENCES restaurants(id) NOT NULL,
	 quantity INTEGER NOT NULL,
	 delivered_at TIMESTAMPTZ NOT NULL,
	 delivered_by UUID REFERENCES users(id) NOT NULL
 );
 -- AUDIT_LOGS
 CREATE TABLE audit_logs (
	 id SERIAL PRIMARY KEY,
	 user_id UUID REFERENCES users(id) NOT NULL,
	 action TEXT NOT NULL,
	 context JSONB NOT NULL,
	 request_id UUID NOT NULL,
	 created_at TIMESTAMPTZ DEFAULT NOW()
 );
 -- REPORTS
 CREATE TABLE reports (
	 id SERIAL PRIMARY KEY,
	 restaurant_id INTEGER REFERENCES restaurants(id) NOT NULL,
	 period_start DATE NOT NULL,
	 period_end DATE NOT NULL,
	 generated_by UUID REFERENCES users(id) NOT NULL,
	 url_pdf TEXT NOT NULL,
	 url_excel TEXT NOT NULL,
	 created_at TIMESTAMPTZ DEFAULT NOW()
 );
 -- ÍNDICES
 CREATE INDEX idx_shifts_employee_id ON shifts(employee_id);
 CREATE INDEX idx_shifts_restaurant_id ON shifts(restaurant_id);
 CREATE INDEX idx_shifts_start_time ON shifts(start_time);
 CREATE INDEX idx_shift_photos_shift_id ON shift_photos(shift_id);
 CREATE INDEX idx_incidents_shift_id ON incidents(shift_id);
 CREATE INDEX idx_supply_deliveries_restaurant_id ON supply_deliveries(restaurant_id);
 CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
 CREATE INDEX idx_reports_restaurant_id ON reports(restaurant_id);
 -- TRIGGERS DE AUDITORÍA
 CREATE OR REPLACE FUNCTION log_audit_trigger() RETURNS trigger AS $$
 BEGIN
	 INSERT INTO audit_logs(user_id, action, context, request_id, created_at)
	 VALUES (NEW.user_id, TG_OP, row_to_json(NEW), gen_random_uuid(), NOW());
	 RETURN NEW;
 END;
 $$ LANGUAGE plpgsql;
 CREATE TRIGGER audit_users AFTER INSERT OR UPDATE OR DELETE ON users
	 FOR EACH ROW EXECUTE FUNCTION log_audit_trigger();
 CREATE TRIGGER audit_shifts AFTER INSERT OR UPDATE OR DELETE ON shifts
	 FOR EACH ROW EXECUTE FUNCTION log_audit_trigger();
 CREATE TRIGGER audit_shift_photos AFTER INSERT OR UPDATE OR DELETE ON shift_photos
	 FOR EACH ROW EXECUTE FUNCTION log_audit_trigger();
 CREATE TRIGGER audit_incidents AFTER INSERT OR UPDATE OR DELETE ON incidents
	 FOR EACH ROW EXECUTE FUNCTION log_audit_trigger();
 CREATE TRIGGER audit_supplies AFTER INSERT OR UPDATE OR DELETE ON supplies
	 FOR EACH ROW EXECUTE FUNCTION log_audit_trigger();
 CREATE TRIGGER audit_supply_deliveries AFTER INSERT OR UPDATE OR DELETE ON supply_deliveries
	 FOR EACH ROW EXECUTE FUNCTION log_audit_trigger();
 CREATE TRIGGER audit_reports AFTER INSERT OR UPDATE OR DELETE ON reports
	 FOR EACH ROW EXECUTE FUNCTION log_audit_trigger();
 -- FUNCIONES RPC
 CREATE OR REPLACE FUNCTION start_shift(employee_id UUID, restaurant_id INTEGER, lat DOUBLE PRECISION, lng DOUBLE PRECISION)
 RETURNS INTEGER LANGUAGE plpgsql AS $$
 DECLARE
	 r_lat DOUBLE PRECISION;
	 r_lng DOUBLE PRECISION;
	 r_radius INTEGER;
	 active_count INTEGER;
	 shift_id INTEGER;
 BEGIN
	 SELECT lat, lng, radius INTO r_lat, r_lng, r_radius FROM restaurants WHERE id = restaurant_id;
	 IF earth_distance(ll_to_earth(r_lat, r_lng), ll_to_earth(lat, lng)) > r_radius THEN
		 RAISE EXCEPTION 'GPS fuera de radio';
	 END IF;
	 SELECT COUNT(*) INTO active_count FROM shifts WHERE employee_id = employee_id AND state = 'activo';
	 IF active_count > 0 THEN
		 RAISE EXCEPTION 'Ya existe un turno activo';
	 END IF;
	 INSERT INTO shifts(employee_id, restaurant_id, start_time, start_lat, start_lng, state)
	 VALUES (employee_id, restaurant_id, NOW(), lat, lng, 'activo') RETURNING id INTO shift_id;
	 RETURN shift_id;
 END;
 $$;
 CREATE OR REPLACE FUNCTION end_shift(shift_id INTEGER, lat DOUBLE PRECISION, lng DOUBLE PRECISION)
 RETURNS VOID LANGUAGE plpgsql AS $$
 DECLARE
	 r_lat DOUBLE PRECISION;
	 r_lng DOUBLE PRECISION;
	 r_radius INTEGER;
	 emp_id UUID;
 BEGIN
	 SELECT restaurant_id, employee_id INTO r_lat, emp_id FROM shifts WHERE id = shift_id;
	 SELECT lat, lng, radius INTO r_lat, r_lng, r_radius FROM restaurants WHERE id = r_lat;
	 IF earth_distance(ll_to_earth(r_lat, r_lng), ll_to_earth(lat, lng)) > r_radius THEN
		 RAISE EXCEPTION 'GPS fuera de radio';
	 END IF;
	 UPDATE shifts SET end_time = NOW(), end_lat = lat, end_lng = lng, state = 'finalizado', updated_at = NOW() WHERE id = shift_id;
 END;
 $$;
 CREATE OR REPLACE FUNCTION upload_evidence(shift_id INTEGER, user_id UUID, url TEXT, type photo_type, lat DOUBLE PRECISION, lng DOUBLE PRECISION)
 RETURNS VOID LANGUAGE plpgsql AS $$
 BEGIN
	 IF EXISTS (SELECT 1 FROM shift_photos WHERE shift_id = shift_id AND type = type) THEN
		 RAISE EXCEPTION 'Evidencia ya existe para este turno y tipo';
	 END IF;
	 INSERT INTO shift_photos(shift_id, user_id, url, type, taken_at, lat, lng, created_at) VALUES (shift_id, user_id, url, type, NOW(), lat, lng, NOW());
 END;
 $$;
 CREATE OR REPLACE FUNCTION approve_shift(shift_id INTEGER, supervisor_id UUID)
 RETURNS VOID LANGUAGE plpgsql AS $$
 BEGIN
	 UPDATE shifts SET state = 'aprobado', approved_by = supervisor_id, updated_at = NOW() WHERE id = shift_id;
 END;
 $$;
 CREATE OR REPLACE FUNCTION reject_shift(shift_id INTEGER, supervisor_id UUID)
 RETURNS VOID LANGUAGE plpgsql AS $$
 BEGIN
	 UPDATE shifts SET state = 'rechazado', rejected_by = supervisor_id, updated_at = NOW() WHERE id = shift_id;
 END;
 $$;
 CREATE OR REPLACE FUNCTION generate_report(restaurant_id INTEGER, period_start DATE, period_end DATE, generated_by UUID)
 RETURNS INTEGER LANGUAGE plpgsql AS $$
 DECLARE
	 report_id INTEGER;
 -- ...continúa el contenido real de las migraciones siguientes...
-- 006_structure.sql
begin;
create extension if not exists btree_gist;
create extension if not exists cube;
create extension if not exists earthdistance;
-- 1) ENUMS
do $$
begin
	if not exists (select 1 from pg_type where typname = 'incident_status') then
		create type public.incident_status as enum ('open','resolved','dismissed');
	end if;

	if not exists (select 1 from pg_type where typname = 'delivery_status') then
		create type public.delivery_status as enum ('registered','delivered','cancelled');
	end if;
end $$;
-- 2) COLUMNAS DE ESTADO TIPADAS (sin romper columnas existentes)
alter table public.incidents
	add column if not exists status_v2 public.incident_status;
update public.incidents
set status_v2 = coalesce(status_v2, 'open'::public.incident_status)
where status_v2 is null;
alter table public.incidents
	alter column status_v2 set default 'open'::public.incident_status;
alter table public.supply_deliveries
	add column if not exists status_v2 public.delivery_status;
update public.supply_deliveries
set status_v2 = coalesce(status_v2, 'registered'::public.delivery_status)
where status_v2 is null;
alter table public.supply_deliveries
	alter column status_v2 set default 'registered'::public.delivery_status;
-- 3) EVIDENCIA ANTIFRAUDE
alter table public.shifts
	add column if not exists start_evidence_hash text,
	add column if not exists start_evidence_mime_type text,
	add column if not exists start_evidence_size_bytes bigint,
	add column if not exists start_evidence_created_at timestamptz,
	add column if not exists start_evidence_uploaded_by uuid references public.users(id) on delete set null,
	add column if not exists end_evidence_hash text,
	add column if not exists end_evidence_mime_type text,
	add column if not exists end_evidence_size_bytes bigint,
	add column if not exists end_evidence_created_at timestamptz,
	add column if not exists end_evidence_uploaded_by uuid references public.users(id) on delete set null;
-- 4) REPORTES VERIFICABLES
alter table public.reports
	add column if not exists hash_documento text,
	add column if not exists generado_por uuid references public.users(id) on delete set null,
	add column if not exists generated_at timestamptz,
	add column if not exists filtros_json jsonb,
	add column if not exists file_path text;
update public.reports
set generated_at = coalesce(generated_at, now())
where generated_at is null;
-- 5) CHECKS
do $$
begin
	if not exists (
		select 1 from pg_constraint
		where conname = 'shifts_start_lat_check' and conrelid = 'public.shifts'::regclass
	) then
		alter table public.shifts
			add constraint shifts_start_lat_check
			check (start_lat is null or start_lat between -90 and 90);
	end if;

	if not exists (
		select 1 from pg_constraint
		where conname = 'shifts_start_lng_check' and conrelid = 'public.shifts'::regclass
	) then
		alter table public.shifts
			add constraint shifts_start_lng_check
			check (start_lng is null or start_lng between -180 and 180);
	end if;

	if not exists (
		select 1 from pg_constraint
		where conname = 'shifts_end_lat_check' and conrelid = 'public.shifts'::regclass
	) then
		alter table public.shifts
			add constraint shifts_end_lat_check
			check (end_lat is null or end_lat between -90 and 90);
	end if;

	if not exists (
		select 1 from pg_constraint
		where conname = 'shifts_end_lng_check' and conrelid = 'public.shifts'::regclass
	) then
		alter table public.shifts
			add constraint shifts_end_lng_check
			check (end_lng is null or end_lng between -180 and 180);
	end if;

	if not exists (
		select 1 from pg_constraint
		where conname = 'shifts_time_consistency_check' and conrelid = 'public.shifts'::regclass
	) then
		alter table public.shifts
			add constraint shifts_time_consistency_check
			check (end_time is null or end_time >= start_time);
	end if;

	if not exists (
		select 1 from pg_constraint
		where conname = 'supply_deliveries_quantity_positive_check' and conrelid = 'public.supply_deliveries'::regclass
	) then
		alter table public.supply_deliveries
			add constraint supply_deliveries_quantity_positive_check
			check (quantity > 0);
	end if;
end $$;
-- 6) INDICES
create index if not exists idx_shifts_employee_state_endtime
	on public.shifts (employee_id, state, end_time);
create index if not exists idx_shifts_restaurant_start_time
	on public.shifts (restaurant_id, start_time desc);
create index if not exists idx_incidents_shift_created_at
	on public.incidents (shift_id, created_at desc);
create index if not exists idx_supply_deliveries_restaurant_delivered_at
	on public.supply_deliveries (restaurant_id, delivered_at desc);
-- 7) UNIQUE PARCIAL ANTIFRAUDE (solo si no hay duplicados)
do $$
begin
	if exists (
		select 1
		from public.shifts
		where state = 'activo' and end_time is null
		group by employee_id
		having count(*) > 1
	) then
		raise notice 'No se crea uq_shifts_employee_active: existen duplicados activos';
	else
		if not exists (
			select 1 from pg_indexes
			where schemaname = 'public'
				and tablename = 'shifts'
				and indexname = 'uq_shifts_employee_active'
		) then
			execute 'create unique index uq_shifts_employee_active on public.shifts (employee_id) where state = ''activo'' and end_time is null';
		end if;
	end if;
end $$;
commit;

-- ...continúa el contenido real de las migraciones siguientes...
-- 007_security.sql
begin;
-- 0) Tablas requeridas por seguridad legal (idempotente)
create table if not exists public.legal_terms_versions (
	id bigserial primary key,
	code text not null unique,
	title text not null,
	content text not null,
	version text not null,
	is_active boolean not null default false,
	created_at timestamptz not null default now(),
	created_by uuid null references public.users(id) on delete set null
);
create table if not exists public.user_legal_acceptances (
	id bigserial primary key,
	user_id uuid not null references public.users(id) on delete cascade,
	legal_terms_id bigint not null references public.legal_terms_versions(id) on delete restrict,
	accepted_at timestamptz not null default now(),
	ip_address inet null,
	user_agent text null,
	unique (user_id, legal_terms_id)
);
create table if not exists public.shift_health_forms (
	id bigserial primary key,
	shift_id integer not null references public.shifts(id) on delete cascade,
	phase text not null check (phase in ('start', 'end')),
	fit_for_work boolean not null,
	declaration text null,
	recorded_at timestamptz not null default now(),
	recorded_by uuid not null references public.users(id) on delete restrict,
	unique (shift_id, phase)
);
-- 0.1) Columna requerida por policy de audit_logs
alter table public.audit_logs
	add column if not exists actor_user_id uuid;
-- 1) Helpers de seguridad (sin auth.role)
create or replace function public.actor_role_secure()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
	select r.name::text
	from public.users u
	join public.roles r on r.id = u.role_id
	where u.id = auth.uid()
	limit 1;
$$;
create or replace function public.is_supervisor_for_restaurant(p_restaurant_id integer)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
	select exists (
		select 1
		from public.restaurant_employees re
		where re.restaurant_id = p_restaurant_id
			and re.user_id = auth.uid()
	);
$$;
revoke execute on function public.actor_role_secure() from public;
revoke execute on function public.is_supervisor_for_restaurant(integer) from public;
grant execute on function public.actor_role_secure() to authenticated;
grant execute on function public.is_supervisor_for_restaurant(integer) to authenticated;
-- (continúa la migración 007 en el siguiente bloque)

-- ...continúa el contenido real de las migraciones siguientes...
 
COMMIT;
