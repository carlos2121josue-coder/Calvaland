CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  weekly_salary_cents INTEGER NOT NULL CHECK (weekly_salary_cents >= 0),
  regular_hours_per_day NUMERIC(4, 2) NOT NULL DEFAULT 8
    CHECK (regular_hours_per_day > 0 AND regular_hours_per_day <= 24),
  overtime_multiplier NUMERIC(4, 2) NOT NULL DEFAULT 1.5
    CHECK (overtime_multiplier >= 1 AND overtime_multiplier <= 5),
  days_worked INTEGER NOT NULL DEFAULT 0 CHECK (days_worked >= 0 AND days_worked <= 7),
  overtime_hours NUMERIC(5, 2) NOT NULL DEFAULT 0
    CHECK (overtime_hours >= 0 AND overtime_hours <= 80),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS days_worked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC(5, 2) NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_days_worked_check;
ALTER TABLE employees ADD CONSTRAINT employees_days_worked_check CHECK (days_worked >= 0 AND days_worked <= 7);
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_overtime_hours_check;
ALTER TABLE employees ADD CONSTRAINT employees_overtime_hours_check CHECK (overtime_hours >= 0 AND overtime_hours <= 80);

INSERT INTO employees (
  name, position, weekly_salary_cents, regular_hours_per_day,
  overtime_multiplier, days_worked, overtime_hours, is_demo, active
)
SELECT 'Trabajador de prueba', 'Preparación de pedidos', 20000, 8, 1.50, 5, 6, TRUE, TRUE
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE is_demo = TRUE);

UPDATE employees
SET weekly_salary_cents = 20000, days_worked = 5, overtime_hours = 6
WHERE is_demo = TRUE;

CREATE TABLE IF NOT EXISTS inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource TEXT NOT NULL UNIQUE CHECK (resource IN ('tables', 'chairs')),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  loaned INTEGER NOT NULL DEFAULT 0 CHECK (loaned >= 0),
  available INTEGER GENERATED ALWAYS AS (total - loaned) STORED,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (total >= loaned)
);

INSERT INTO inventory (resource, total)
VALUES ('tables', 120), ('chairs', 120)
ON CONFLICT (resource) DO NOTHING;

CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  contact_name TEXT,
  contact_email TEXT,
  guest_access_hash TEXT,
  reservation_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  tables INTEGER NOT NULL DEFAULT 0 CHECK (tables >= 0),
  chairs INTEGER NOT NULL DEFAULT 0 CHECK (chairs >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed')),
  payment_method TEXT NOT NULL DEFAULT 'demo'
    CHECK (payment_method IN ('demo', 'cash')),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_at TIMESTAMPTZ,
  reservation_email_sent_at TIMESTAMPTZ,
  receipt_email_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (tables + chairs > 0),
  CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time)
);

ALTER TABLE reservations ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_access_hash TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'demo';
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS reservation_email_sent_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS receipt_email_sent_at TIMESTAMPTZ;
UPDATE reservations SET paid_at = updated_at
WHERE payment_status = 'paid' AND paid_at IS NULL;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_payment_method_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_payment_method_check
  CHECK (payment_method IN ('demo', 'cash'));

CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id),
  provider TEXT NOT NULL DEFAULT 'mesalista_demo' CHECK (provider = 'mesalista_demo'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'cancelled')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  reservation_id UUID UNIQUE REFERENCES reservations(id),
  borrower_name TEXT NOT NULL,
  borrower_email TEXT NOT NULL DEFAULT '',
  loan_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  tables INTEGER NOT NULL DEFAULT 0 CHECK (tables >= 0),
  chairs INTEGER NOT NULL DEFAULT 0 CHECK (chairs >= 0),
  tables_returned INTEGER NOT NULL DEFAULT 0 CHECK (tables_returned >= 0),
  chairs_returned INTEGER NOT NULL DEFAULT 0 CHECK (chairs_returned >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'partially_returned', 'returned', 'overdue')),
  observations TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (tables + chairs > 0),
  CHECK (tables_returned <= tables AND chairs_returned <= chairs),
  CHECK (due_date >= loan_date)
);

ALTER TABLE loans ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS borrower_email TEXT NOT NULL DEFAULT '';
UPDATE loans l SET borrower_email = u.email
FROM users u WHERE l.user_id = u.id AND l.borrower_email = '';

CREATE TABLE IF NOT EXISTS loan_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loans(id),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  tables INTEGER NOT NULL DEFAULT 0 CHECK (tables >= 0),
  chairs INTEGER NOT NULL DEFAULT 0 CHECK (chairs >= 0),
  returned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (tables + chairs > 0)
);

CREATE TABLE IF NOT EXISTS movements (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  resource TEXT CHECK (resource IN ('tables', 'chairs')),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  operation TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  previous_state JSONB NOT NULL DEFAULT '{}'::JSONB,
  new_state JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE movements ADD COLUMN IF NOT EXISTS actor_email TEXT;

CREATE INDEX IF NOT EXISTS reservations_user_created_idx ON reservations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS employees_active_name_idx ON employees(active, name);
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_pending_idx
  ON payment_attempts(reservation_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS loans_user_due_idx ON loans(user_id, due_date);
CREATE INDEX IF NOT EXISTS loan_returns_loan_idx ON loan_returns(loan_id, returned_at DESC);
CREATE INDEX IF NOT EXISTS movements_created_idx ON movements(created_at DESC);
