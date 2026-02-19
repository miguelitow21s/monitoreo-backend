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
BEGIN
  INSERT INTO reports(restaurant_id, period_start, period_end, generated_by, url_pdf, url_excel, created_at)
  VALUES (restaurant_id, period_start, period_end, generated_by, '', '', NOW())
  RETURNING id INTO report_id;
  RETURN report_id;
END;
$$;

-- RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplies ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- SELECT: empleado solo ve sus turnos
CREATE POLICY "Empleado ve solo sus turnos" ON shifts
  FOR SELECT
  USING (employee_id = auth.uid());

-- INSERT: empleado solo puede crear turnos propios
CREATE POLICY "Empleado inserta solo sus turnos" ON shifts
  FOR INSERT
  WITH CHECK (employee_id = auth.uid());

-- SUPERVISORA
CREATE POLICY "Supervisora ve turnos" ON shifts
  FOR SELECT
  USING (auth.role() = 'supervisora');

-- SUPER ADMIN
CREATE POLICY "Super admin acceso total" ON shifts
  FOR ALL
  USING (auth.role() = 'super_admin');
-- (Repetir lógica para shift_photos, incidents, etc.)
