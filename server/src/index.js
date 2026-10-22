import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { pool, initializeDatabase, inTransaction } from './db.js';
import { authenticate, createToken, hashPassword, requireAdmin, verifyPassword } from './auth.js';

const app = express();
const configuredOrigins = (process.env.WEB_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = new Set(
  [
    ...configuredOrigins,
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ].filter(Boolean).map((value) => {
    const origin = value.trim();
    return new URL(origin.includes('://') ? origin : `https://${origin}`).origin;
  }),
);
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
}));
app.use(express.json({ limit: '32kb' }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => { throw new HttpError(status, message); };
const positiveCount = (value) => Number.isInteger(value) && value >= 0;
const today = () => new Date().toISOString().slice(0, 10);
const hasResources = (tables, chairs) => tables + chairs > 0;
const validEmail = (value) => typeof value === 'string'
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const hashGuestKey = (key) => createHash('sha256').update(key).digest('hex');
const validDate = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = (value) => typeof value === 'string'
  && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

let databaseInitialization;
function ensureDatabase() {
  if (!databaseInitialization) {
    databaseInitialization = initializeDatabase().catch((error) => {
      databaseInitialization = null;
      throw error;
    });
  }
  return databaseInitialization;
}

app.use('/api', async (_req, _res, next) => {
  try {
    await ensureDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

function reservationPrice(tables, chairs, days) {
  const tablePrice = Number(process.env.PRICE_TABLE_CENTS ?? 0);
  const chairPrice = Number(process.env.PRICE_CHAIR_CENTS ?? 0);
  if (!Number.isInteger(tablePrice) || !Number.isInteger(chairPrice) || tablePrice < 0 || chairPrice < 0) {
    throw new Error('Las tarifas por recurso deben ser enteros no negativos en centavos.');
  }
  return (tables * tablePrice + chairs * chairPrice) * days;
}

async function logMovement(db, { actorId, actorEmail = null, resource = null, quantity, operation, entityType, entityId, previousState = {}, newState = {} }) {
  await db.query(
    `INSERT INTO movements (actor_id, actor_email, resource, quantity, operation, entity_type, entity_id, previous_state, new_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actorId, actorEmail, resource, quantity, operation, entityType, entityId, previousState, newState],
  );
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const base64Lines = (value) => Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');

async function sendWithGmailApi({ to, subject, html, text }) {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10000),
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || typeof tokenData.access_token !== 'string') {
    console.error('No se pudo renovar el acceso de Gmail:', { status: tokenResponse.status, error: tokenData.error });
    return { sent: false, reason: 'No se pudo autorizar Gmail. Revisa las credenciales OAuth y el permiso gmail.send en Vercel.' };
  }

  const boundary = `mesalista_${randomBytes(18).toString('hex')}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const mimeMessage = [
    `From: MesaLista <${process.env.GMAIL_USER}>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const raw = Buffer.from(mimeMessage, 'utf8').toString('base64url');
  const sendResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(10000),
  });
  const sendData = await sendResponse.json().catch(() => ({}));
  if (!sendResponse.ok) {
    console.error('Gmail API rechazó el correo:', {
      status: sendResponse.status,
      error: sendData.error?.status || sendData.error?.message,
    });
    return { sent: false, reason: 'Gmail no aceptó el envío. Verifica el permiso gmail.send y las credenciales OAuth.' };
  }
  return { sent: true };
}

async function sendReservationEmail(reservationId, type = 'receipt') {
  if (!['reservation', 'receipt'].includes(type)) {
    throw new Error(`Tipo de correo no válido: ${type}`);
  }
  const { rows } = await pool.query(
    `SELECT r.*, COALESCE(r.contact_name, u.name, 'Usuario') AS customer_name,
            COALESCE(r.contact_email, u.email) AS customer_email
     FROM reservations r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.id = $1`,
    [reservationId],
  );
  const reservation = rows[0];
  if (!reservation) fail(404, 'No se encontró la reserva para enviar el comprobante.');
  const sentAtColumn = type === 'receipt' ? 'receipt_email_sent_at' : 'reservation_email_sent_at';
  if (type === 'receipt' && reservation.payment_status !== 'paid') {
    fail(409, 'El comprobante solo se puede enviar después de confirmar el pago.');
  }
  if (reservation[sentAtColumn]) {
    return { sent: true, alreadySent: true, email: reservation.customer_email, type, sentAt: reservation[sentAtColumn] };
  }
  if (!reservation.customer_email) {
    return { sent: false, reason: 'La reserva no tiene un correo de destinatario.' };
  }
  const gmailSettings = [
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REFRESH_TOKEN,
    process.env.GMAIL_USER,
  ];
  const gmailConfigured = gmailSettings.every(Boolean);
  const resendConfigured = Boolean(process.env.RESEND_API_KEY && process.env.RECEIPT_FROM);
  if (gmailConfigured && !validEmail(process.env.GMAIL_USER)) {
    return { sent: false, reason: 'GMAIL_USER debe ser la dirección Gmail autorizada para Gmail API.' };
  }
  if (!gmailConfigured && !resendConfigured) {
    return {
      sent: false,
      reason: 'Configura GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN y GMAIL_USER en Vercel, o la configuración alternativa de Resend.',
    };
  }

  const currency = process.env.PAYMENT_CURRENCY || 'USD';
  const total = new Intl.NumberFormat('es', { style: 'currency', currency }).format(
    (Number(reservation.total_cents) || 0) / 100,
  );
  const paidAt = reservation.paid_at
    ? new Date(reservation.paid_at).toLocaleString('es')
    : 'Confirmado';
  const method = reservation.payment_method === 'cash'
    ? 'Efectivo confirmado por administración'
    : 'Pago de prueba (no realiza un cobro real)';
  const paymentStatus = reservation.payment_status === 'paid'
    ? 'Pago confirmado'
    : reservation.payment_method === 'cash'
      ? 'Pendiente de confirmación del efectivo'
      : reservation.payment_status === 'pending'
        ? 'Pendiente de pago'
        : 'Pago no iniciado';
  const isReceipt = type === 'receipt';
  const mailTitle = isReceipt ? 'Comprobante de pago' : 'Confirmación de reserva';
  const mailHeading = isReceipt ? 'PAGO CONFIRMADO' : 'RESERVA REGISTRADA';
  const folio = `ML-${String(reservation.id).slice(0, 8).toUpperCase()}`;
  const schedule = reservation.start_time
    ? `${String(reservation.start_time).slice(0, 5)}${reservation.end_time ? `–${String(reservation.end_time).slice(0, 5)}` : ''}`
    : 'Sin horario especificado';
  const safe = {
    name: escapeHtml(reservation.customer_name),
    email: escapeHtml(reservation.customer_email),
    folio: escapeHtml(folio),
    paidAt: escapeHtml(paidAt),
    eventDate: escapeHtml(new Date(`${String(reservation.reservation_date).slice(0, 10)}T12:00:00`).toLocaleDateString('es', {
      day: 'numeric', month: 'long', year: 'numeric',
    })),
    schedule: escapeHtml(schedule),
    tables: escapeHtml(reservation.tables),
    chairs: escapeHtml(reservation.chairs),
    total: escapeHtml(total),
    method: escapeHtml(method),
  };
  const text = [
    `${mailTitle} MesaLista`,
    `Folio: ${folio}`,
    `Responsable: ${reservation.customer_name} (${reservation.customer_email})`,
    `Fecha del evento: ${safe.eventDate}`,
    `Horario: ${schedule}`,
    `Mesas: ${reservation.tables} · Sillas: ${reservation.chairs}`,
    `Total: ${total}`,
    `Estado del pago: ${paymentStatus}`,
    `Método de pago: ${method}`,
    ...(isReceipt ? [`Fecha de pago: ${paidAt}`, 'Comprobante informativo; no sustituye una factura fiscal.'] : []),
  ].join('\n');
  const statusLine = isReceipt ? `<br><strong>Fecha de pago:</strong> ${safe.paidAt}` : `<br><strong>Estado del pago:</strong> ${escapeHtml(paymentStatus)}`;
  const footnote = isReceipt
    ? `Este es un comprobante informativo; no sustituye una factura fiscal. ${reservation.payment_method === 'cash' ? '' : 'El pago de prueba no realizó ningún cobro real.'}`
    : `Método de pago: ${safe.method}. ${reservation.payment_status === 'paid' ? 'Pago confirmado.' : 'Este correo confirma la reserva, no confirma la recepción del pago.'}`;
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f7f6;padding:28px;font-family:Arial,sans-serif;color:#263538"><main style="max-width:560px;margin:auto;background:#fff;border:1px solid #e4ebea;border-radius:14px;overflow:hidden"><header style="padding:22px 26px;background:#263538;color:#fff;font-weight:bold;letter-spacing:1px">MESA<span style="color:#a9dd70">LISTA</span><span style="float:right;font-size:12px;letter-spacing:0">COMPROBANTE</span></header><section style="padding:26px"><p style="margin:0;color:#328e7c;font-size:11px;font-weight:bold;letter-spacing:1px">${mailHeading}</p><h1 style="margin:8px 0 20px;font-size:24px">${mailTitle}</h1><p style="margin:0 0 18px;color:#657474">Hola ${safe.name}, ${isReceipt ? 'tu pago quedó registrado.' : 'registramos tu reserva.'} Aquí están los datos.</p><div style="padding:14px;background:#f4f7f6;border-radius:8px;line-height:1.8"><strong>Folio:</strong> ${safe.folio}<br><strong>Cuenta:</strong> ${safe.name} · ${safe.email}<br><strong>Fecha del evento:</strong> ${safe.eventDate}<br><strong>Horario:</strong> ${safe.schedule}<br><strong>Mesas:</strong> ${safe.tables} · <strong>Sillas:</strong> ${safe.chairs}<br><strong>Total:</strong> ${safe.total}${statusLine}<br><strong>Método:</strong> ${safe.method}</div><p style="margin:20px 0 0;color:#7c8989;font-size:11px;line-height:1.6">${footnote}</p></section></main></body></html>`;

  try {
    let emailResult;
    if (gmailConfigured) {
      emailResult = await sendWithGmailApi({
        to: reservation.customer_email,
        subject: `${mailTitle} MesaLista ${folio}`,
        html,
        text,
      });
    } else {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RECEIPT_FROM,
          to: [reservation.customer_email],
          subject: `${mailTitle} MesaLista ${folio}`,
          html,
          text,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error('No se pudo enviar el correo:', { reservationId, status: response.status, error: data.message || data.name });
        return { sent: false, reason: 'Resend rechazó el envío. Verifica la clave y el dominio remitente en Resend.' };
      }
      emailResult = { sent: true };
    }
    if (!emailResult.sent) {
      return emailResult;
    }
    const updated = await pool.query(
      `UPDATE reservations SET ${sentAtColumn} = NOW()
       WHERE id = $1 AND ${sentAtColumn} IS NULL
       RETURNING ${sentAtColumn}`,
      [reservationId],
    );
    return { sent: true, email: reservation.customer_email, type, sentAt: updated.rows[0]?.[sentAtColumn] || null };
  } catch (error) {
    console.error('Falló el envío del correo de reserva:', { reservationId, error: error.message });
    return { sent: false, reason: 'No se pudo enviar el correo. Revisa la configuración del proveedor y vuelve a intentarlo.' };
  }
}

async function getAvailability(db, date, startTime = null, endTime = null) {
  const result = await db.query(
    `SELECT i.resource, i.total,
            GREATEST(i.total - COALESCE(loans.loaned, 0) - COALESCE((
              SELECT SUM(CASE WHEN i.resource = 'tables' THEN r.tables ELSE r.chairs END)
              FROM reservations r
              WHERE r.reservation_date = $1
                AND r.status IN ('pending', 'confirmed')
                AND ($2::time IS NULL OR $3::time IS NULL OR r.start_time IS NULL OR r.end_time IS NULL
                     OR (r.start_time < $3::time AND r.end_time > $2::time))
            ), 0), 0)::INTEGER AS available,
            COALESCE((
              SELECT SUM(CASE WHEN i.resource = 'tables' THEN r.tables ELSE r.chairs END)
              FROM reservations r
              WHERE r.reservation_date = $1
                AND r.status IN ('pending', 'confirmed')
                AND ($2::time IS NULL OR $3::time IS NULL OR r.start_time IS NULL OR r.end_time IS NULL
                     OR (r.start_time < $3::time AND r.end_time > $2::time))
            ), 0)::INTEGER AS reserved,
            COALESCE(loans.loaned, 0)::INTEGER AS loaned
     FROM inventory i
     LEFT JOIN LATERAL (
       SELECT SUM(CASE WHEN i.resource = 'tables'
                       THEN l.tables - l.tables_returned
                       ELSE l.chairs - l.chairs_returned END)::INTEGER AS loaned
       FROM loans l
       WHERE l.loan_date <= $1
         AND l.status IN ('active', 'partially_returned', 'overdue')
         AND (l.due_date >= $1 OR l.due_date < CURRENT_DATE)
     ) loans ON TRUE
     ORDER BY i.resource`,
    [date, startTime, endTime],
  );
  return result.rows;
}

async function maxReservedInPeriod(db, { startDate, endDate, excludeReservationId = null }) {
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(interval_totals.tables), 0)::INTEGER AS tables,
            COALESCE(MAX(interval_totals.chairs), 0)::INTEGER AS chairs
     FROM (
       SELECT anchor.id, anchor.reservation_date,
              SUM(candidate.tables)::INTEGER AS tables,
              SUM(candidate.chairs)::INTEGER AS chairs
       FROM reservations anchor
       JOIN reservations candidate
         ON candidate.reservation_date = anchor.reservation_date
        AND candidate.status IN ('pending', 'confirmed')
        AND ($3::UUID IS NULL OR candidate.id <> $3::UUID)
        AND (
          candidate.start_time IS NULL OR candidate.end_time IS NULL
          OR anchor.start_time IS NULL OR anchor.end_time IS NULL
          OR (candidate.start_time < anchor.end_time AND candidate.end_time > anchor.start_time)
        )
       WHERE anchor.reservation_date BETWEEN $1 AND $2
         AND anchor.status IN ('pending', 'confirmed')
         AND ($3::UUID IS NULL OR anchor.id <> $3::UUID)
       GROUP BY anchor.id, anchor.reservation_date
     ) interval_totals`,
    [startDate, endDate, excludeReservationId],
  );
  return { tables: Number(rows[0].tables), chairs: Number(rows[0].chairs) };
}

async function assertLoanCapacity(db, { tables, chairs, startDate, dueDate, excludeReservationId = null }) {
  const reserved = await maxReservedInPeriod(db, { startDate, endDate: dueDate, excludeReservationId });
  const inventory = await db.query('SELECT resource, total, loaned FROM inventory');
  const stock = Object.fromEntries(inventory.rows.map((item) => [item.resource, item]));
  const availableTables = (stock.tables?.total ?? 0) - (stock.tables?.loaned ?? 0) - reserved.tables;
  const availableChairs = (stock.chairs?.total ?? 0) - (stock.chairs?.loaned ?? 0) - reserved.chairs;
  if (tables > availableTables || chairs > availableChairs) {
    fail(409, `El préstamo interferiría con reservas existentes: quedan ${Math.max(0, availableTables)} mesas y ${Math.max(0, availableChairs)} sillas disponibles para ese período.`);
  }
}

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'connected', paymentMode: 'demo' });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length < 2 || typeof email !== 'string'
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 10) {
    fail(400, 'Indica un nombre válido, un correo válido y una contraseña de al menos 10 caracteres.');
  }
  const hash = await hashPassword(password);
  let result;
  try {
    result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, LOWER($2), $3) RETURNING id, name, email, role',
      [name.trim(), email, hash],
    );
  } catch (error) {
    if (error.code === '23505') fail(409, 'Ya existe una cuenta con ese correo.');
    throw error;
  }
  const user = result.rows[0];
  res.status(201).json({ token: createToken(user), user });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') fail(400, 'Correo y contraseña son obligatorios.');
  const result = await pool.query(
    'SELECT id, name, email, role, password_hash FROM users WHERE email = LOWER($1)',
    [email],
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) fail(401, 'Correo o contraseña incorrectos.');
  res.json({ token: createToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/guest/availability', async (req, res) => {
  const { date, startTime = null, endTime = null } = req.query;
  if (!validDate(date) || date < today() || Boolean(startTime) !== Boolean(endTime)
    || (startTime && !validTime(startTime)) || (endTime && !validTime(endTime))
    || (startTime && endTime && endTime <= startTime)) {
    fail(400, 'Indica una fecha actual o futura y un horario válido.');
  }
  res.json({
    date,
    inventory: await getAvailability(pool, date, startTime, endTime),
    rates: {
      tables: Number(process.env.PRICE_TABLE_CENTS ?? 0),
      chairs: Number(process.env.PRICE_CHAIR_CENTS ?? 0),
      currency: process.env.PAYMENT_CURRENCY || 'USD',
    },
  });
});

app.post('/api/guest/reservations', async (req, res) => {
  const { name = '', email, reservationDate, startTime = null, endTime = null, tables = 0, chairs = 0, paymentMethod = 'demo' } = req.body ?? {};
  if (!validEmail(email) || typeof name !== 'string' || name.trim().length > 120
    || !validDate(reservationDate) || reservationDate < today()
    || !positiveCount(tables) || !positiveCount(chairs) || !hasResources(tables, chairs)
    || !['demo', 'cash'].includes(paymentMethod)
    || Boolean(startTime) !== Boolean(endTime)
    || (startTime && endTime && endTime <= startTime)
    || (startTime && !validTime(startTime))
    || (endTime && !validTime(endTime))) {
    fail(400, 'Revisa el correo, la fecha, las cantidades y el horario de la reserva.');
  }
  const guestKey = randomBytes(32).toString('hex');
  const keyHash = hashGuestKey(guestKey);
  const cents = reservationPrice(tables, chairs, 1);
  const reservation = await inTransaction(async (db) => {
    await db.query('SELECT resource FROM inventory ORDER BY resource FOR UPDATE');
    const currentAvailability = await getAvailability(db, reservationDate, startTime, endTime);
    const availabilityByResource = Object.fromEntries(currentAvailability.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', tables], ['chairs', chairs]]) {
      if (quantity > (availabilityByResource[resource]?.available ?? 0)) {
        fail(409, `Solo hay ${availabilityByResource[resource]?.available ?? 0} ${resource === 'tables' ? 'mesas' : 'sillas'} disponibles para ese horario.`);
      }
    }
    const created = await db.query(
      `INSERT INTO reservations
        (user_id, contact_name, contact_email, guest_access_hash, reservation_date, start_time, end_time, tables, chairs, total_cents, payment_method, payment_status)
       VALUES (NULL, $1, LOWER($2), $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [name.trim() || null, email, keyHash, reservationDate, startTime, endTime, tables, chairs, cents, paymentMethod, paymentMethod === 'cash' ? 'pending' : 'unpaid'],
    );
    const row = created.rows[0];
    for (const [resource, quantity] of [['tables', tables], ['chairs', chairs]]) {
      if (quantity) await logMovement(db, {
        actorId: null, actorEmail: email.trim().toLowerCase(), resource, quantity, operation: 'reservation',
        entityType: 'reservation', entityId: row.id,
        previousState: { status: null, available: availabilityByResource[resource].available },
        newState: { status: 'pending', payment_status: paymentMethod === 'cash' ? 'pending' : 'unpaid', payment_method: paymentMethod, available: availabilityByResource[resource].available - quantity },
      });
    }
    return row;
  });
  const reservationEmail = await sendReservationEmail(reservation.id, 'reservation');
  res.status(201).json({ reservation, guestKey, reservationEmail, paymentMode: 'demo' });
});

app.post('/api/guest/reservations/:id/demo-payment', async (req, res) => {
  const key = req.get('X-Reservation-Key');
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) fail(401, 'La clave temporal de la reserva no es válida.');
  const attempt = await inTransaction(async (db) => {
    const found = await db.query(
      'SELECT * FROM reservations WHERE id = $1 AND guest_access_hash = $2 FOR UPDATE',
      [req.params.id, hashGuestKey(key)],
    );
    const reservation = found.rows[0];
    if (!reservation) fail(404, 'No se encontró la reserva.');
    if (reservation.payment_method !== 'demo') fail(409, 'Esta reserva no usa el pago de prueba.');
    if (reservation.status !== 'pending' || reservation.payment_status === 'paid') fail(409, 'Esta reserva ya no admite un pago de demostración.');
    if (reservation.total_cents <= 0) fail(409, 'Esta reserva no requiere pago.');
    const existing = await db.query(
      `SELECT id, amount_cents, currency, status FROM payment_attempts
       WHERE reservation_id = $1 AND status = 'pending' FOR UPDATE`,
      [reservation.id],
    );
    if (existing.rows[0]) return existing.rows[0];
    const created = await db.query(
      `INSERT INTO payment_attempts (reservation_id, amount_cents, currency)
       VALUES ($1, $2, $3) RETURNING id, amount_cents, currency, status`,
      [reservation.id, reservation.total_cents, process.env.PAYMENT_CURRENCY || 'USD'],
    );
    await db.query(`UPDATE reservations SET payment_status = 'pending', updated_at = NOW() WHERE id = $1`, [reservation.id]);
    await logMovement(db, {
      actorId: null, actorEmail: reservation.contact_email, quantity: reservation.tables + reservation.chairs,
      operation: 'demo_payment_started', entityType: 'reservation', entityId: reservation.id,
      previousState: { payment_status: reservation.payment_status },
      newState: { payment_status: 'pending', provider: 'mesalista_demo' },
    });
    return created.rows[0];
  });
  res.json({ attempt, message: 'Simulación: no se realizará ningún cobro ni se solicitarán datos de pago.' });
});

app.post('/api/guest/payments/demo/complete', async (req, res) => {
  const { attemptId } = req.body ?? {};
  const key = req.get('X-Reservation-Key');
  if (typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attemptId)
    || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) {
    fail(400, 'La simulación o la clave temporal no es válida.');
  }
  const completed = await inTransaction(async (db) => {
    const found = await db.query(
      `SELECT p.*, r.id AS reservation_id, r.contact_email, r.payment_status, r.total_cents,
              r.tables, r.chairs, r.paid_at, r.status AS reservation_status
       FROM payment_attempts p JOIN reservations r ON r.id = p.reservation_id
       WHERE p.id = $1 AND r.guest_access_hash = $2 FOR UPDATE OF p, r`,
      [attemptId, hashGuestKey(key)],
    );
    const attempt = found.rows[0];
    if (!attempt) fail(404, 'No se encontró esta simulación de pago.');
    if (attempt.status === 'succeeded') {
      return { reservationId: attempt.reservation_id, status: 'succeeded', paidAt: attempt.paid_at };
    }
    if (attempt.status !== 'pending' || attempt.reservation_status !== 'pending') fail(409, 'La simulación ya no se puede completar.');
    await db.query(`UPDATE payment_attempts SET status = 'succeeded', completed_at = NOW() WHERE id = $1`, [attempt.id]);
    const paid = await db.query(
      `UPDATE reservations SET status = 'confirmed', payment_status = 'paid',
       paid_at = COALESCE(paid_at, NOW()), updated_at = NOW() WHERE id = $1
       RETURNING paid_at`,
      [attempt.reservation_id],
    );
    await logMovement(db, {
      actorId: null, actorEmail: attempt.contact_email, quantity: attempt.tables + attempt.chairs,
      operation: 'demo_payment_completed', entityType: 'reservation', entityId: attempt.reservation_id,
      previousState: { status: attempt.reservation_status, payment_status: attempt.payment_status },
      newState: { status: 'confirmed', payment_status: 'paid', provider: 'mesalista_demo', amount_cents: attempt.total_cents },
    });
    return { reservationId: attempt.reservation_id, status: 'succeeded', paidAt: paid.rows[0].paid_at };
  });
  const receiptEmail = await sendReservationEmail(completed.reservationId, 'receipt');
  res.json({ ...completed, receiptEmail, simulated: true });
});

app.post('/api/guest/payments/demo/cancel', async (req, res) => {
  const { attemptId } = req.body ?? {};
  const key = req.get('X-Reservation-Key');
  if (typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attemptId)
    || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) {
    fail(400, 'La simulación o la clave temporal no es válida.');
  }
  const result = await inTransaction(async (db) => {
    const found = await db.query(
      `SELECT p.*, r.id AS reservation_id, r.contact_email, r.payment_status, r.status AS reservation_status
       FROM payment_attempts p JOIN reservations r ON r.id = p.reservation_id
       WHERE p.id = $1 AND r.guest_access_hash = $2 FOR UPDATE OF p, r`,
      [attemptId, hashGuestKey(key)],
    );
    const attempt = found.rows[0];
    if (!attempt) fail(404, 'No se encontró esta simulación de pago.');
    if (attempt.status !== 'pending') return { status: attempt.status };
    await db.query(`UPDATE payment_attempts SET status = 'cancelled', completed_at = NOW() WHERE id = $1`, [attempt.id]);
    await db.query(
      `UPDATE reservations SET payment_status = 'unpaid', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [attempt.reservation_id],
    );
    await logMovement(db, {
      actorId: null, actorEmail: attempt.contact_email, quantity: 0, operation: 'demo_payment_cancelled',
      entityType: 'reservation', entityId: attempt.reservation_id,
      previousState: { payment_status: attempt.payment_status },
      newState: { payment_status: 'unpaid', provider: 'mesalista_demo' },
    });
    return { status: 'cancelled' };
  });
  res.json({ ...result, simulated: true });
});

app.use('/api', authenticate);

app.get('/api/me', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [req.auth.sub]);
  if (!rows[0]) fail(401, 'La cuenta ya no existe.');
  res.json({ user: rows[0] });
});

app.get('/api/dashboard', async (req, res) => {
  const [inventory, reservations, loans] = await Promise.all([
    getAvailability(pool, today()),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending
       FROM reservations ${req.auth.role === 'admin' ? '' : 'WHERE user_id = $1'}`,
      req.auth.role === 'admin' ? [] : [req.auth.sub],
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('active', 'partially_returned')) AS active,
              COUNT(*) FILTER (WHERE status = 'overdue' OR (status IN ('active', 'partially_returned') AND due_date < CURRENT_DATE)) AS overdue,
              COUNT(*) FILTER (WHERE status IN ('active', 'partially_returned', 'overdue')) AS returns_pending
       FROM loans ${req.auth.role === 'admin' ? '' : 'WHERE user_id = $1'}`,
      req.auth.role === 'admin' ? [] : [req.auth.sub],
    ),
  ]);
  res.json({
    inventory,
    reservationsPending: Number(reservations.rows[0].pending),
    loansActive: Number(loans.rows[0].active),
    loansOverdue: Number(loans.rows[0].overdue),
    returnsPending: Number(loans.rows[0].returns_pending),
    paymentMode: 'demo',
    rates: {
      tables: Number(process.env.PRICE_TABLE_CENTS ?? 0),
      chairs: Number(process.env.PRICE_CHAIR_CENTS ?? 0),
      currency: process.env.PAYMENT_CURRENCY || 'USD',
    },
  });
});

app.get('/api/availability', async (req, res) => {
  const { date, startTime = null, endTime = null } = req.query;
  if (!validDate(date) || date < today() || Boolean(startTime) !== Boolean(endTime)
    || (startTime && !validTime(startTime)) || (endTime && !validTime(endTime))) {
    fail(400, 'Indica una fecha actual o futura y un horario válido.');
  }
  res.json({ date, inventory: await getAvailability(pool, date, startTime, endTime) });
});

app.patch('/api/inventory/:resource', requireAdmin, async (req, res) => {
  const { resource } = req.params;
  const { total } = req.body ?? {};
  if (!['tables', 'chairs'].includes(resource) || !Number.isInteger(total) || total < 0) {
    fail(400, 'Recurso o cantidad total inválidos.');
  }
  const updated = await inTransaction(async (db) => {
    const current = await db.query('SELECT * FROM inventory WHERE resource = $1 FOR UPDATE', [resource]);
    const item = current.rows[0];
    if (!item) fail(404, 'No se encontró el recurso.');
    const reserved = await maxReservedInPeriod(db, { startDate: today(), endDate: '9999-12-31' });
    const required = item.loaned + reserved[resource];
    if (total < required) fail(409, `El total no puede ser menor que ${required} unidades prestadas o reservadas en fechas futuras.`);
    await db.query('UPDATE inventory SET total = $1, updated_at = NOW() WHERE resource = $2', [total, resource]);
    await logMovement(db, {
      actorId: req.auth.sub, resource, quantity: Math.abs(total - item.total), operation: 'inventory_adjustment',
      entityType: 'inventory', entityId: item.id,
      previousState: { total: item.total, available: item.available },
      newState: { total, available: total - item.loaned },
    });
    return (await db.query('SELECT resource, total, available, loaned FROM inventory WHERE resource = $1', [resource])).rows[0];
  });
  res.json({ inventory: updated });
});

app.get('/api/reservations', async (req, res) => {
  const admin = req.auth.role === 'admin';
  const result = await pool.query(
    `SELECT r.*, COALESCE(r.contact_name, u.name) AS user_name,
            COALESCE(r.contact_email, u.email) AS user_email
     FROM reservations r LEFT JOIN users u ON u.id = r.user_id
     ${admin ? '' : 'WHERE r.user_id = $1'}
     ORDER BY r.created_at DESC LIMIT 100`,
    admin ? [] : [req.auth.sub],
  );
  res.json({ reservations: result.rows });
});

app.post('/api/reservations/:id/receipt-email', async (req, res) => {
  const owned = await pool.query(
    `SELECT id FROM reservations
     WHERE id = $1 AND ($2::UUID IS NULL OR user_id = $2)`,
    [req.params.id, req.auth.role === 'admin' ? null : req.auth.sub],
  );
  if (!owned.rows[0]) fail(404, 'No se encontró esta reserva.');
  const receiptEmail = await sendReservationEmail(req.params.id, 'receipt');
  res.json({ receiptEmail });
});

app.post('/api/reservations/:id/reservation-email', async (req, res) => {
  const owned = await pool.query(
    `SELECT id FROM reservations
     WHERE id = $1 AND ($2::UUID IS NULL OR user_id = $2)`,
    [req.params.id, req.auth.role === 'admin' ? null : req.auth.sub],
  );
  if (!owned.rows[0]) fail(404, 'No se encontró esta reserva.');
  const reservationEmail = await sendReservationEmail(req.params.id, 'reservation');
  res.json({ reservationEmail });
});

app.post('/api/reservations', async (req, res) => {
  const { reservationDate, startTime = null, endTime = null, tables = 0, chairs = 0, paymentMethod = 'demo', userId = null } = req.body ?? {};
  if (!validDate(reservationDate) || reservationDate < today()
    || !positiveCount(tables) || !positiveCount(chairs) || !hasResources(tables, chairs)
    || !['demo', 'cash'].includes(paymentMethod)
    || (userId !== null && typeof userId !== 'string')
    || (userId && req.auth.role !== 'admin')
    || Boolean(startTime) !== Boolean(endTime)
    || (startTime && endTime && endTime <= startTime)
    || (startTime && !validTime(startTime))
    || (endTime && !validTime(endTime))) {
    fail(400, 'Revisa la fecha, las cantidades y el horario de la reserva.');
  }
  const cents = reservationPrice(tables, chairs, 1);
  const reservation = await inTransaction(async (db) => {
    const customerId = req.auth.role === 'admin' && userId ? userId : req.auth.sub;
    const customer = await db.query('SELECT id, name, email FROM users WHERE id = $1', [customerId]);
    if (!customer.rows[0]) fail(404, 'No se encontró la cuenta seleccionada para la reserva.');
    await db.query('SELECT resource FROM inventory ORDER BY resource FOR UPDATE');
    const currentAvailability = await getAvailability(db, reservationDate, startTime, endTime);
    const availabilityByResource = Object.fromEntries(currentAvailability.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', tables], ['chairs', chairs]]) {
      if (quantity > (availabilityByResource[resource]?.available ?? 0)) {
        fail(409, `Solo hay ${availabilityByResource[resource]?.available ?? 0} ${resource === 'tables' ? 'mesas' : 'sillas'} disponibles para ese horario.`);
      }
    }
    const created = await db.query(
      `INSERT INTO reservations (user_id, contact_name, contact_email, reservation_date, start_time, end_time, tables, chairs, total_cents, payment_method, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [customerId, customer.rows[0].name, customer.rows[0].email, reservationDate, startTime, endTime, tables, chairs, cents, paymentMethod, paymentMethod === 'cash' ? 'pending' : 'unpaid'],
    );
    const row = created.rows[0];
    for (const [resource, quantity] of [['tables', tables], ['chairs', chairs]]) {
      if (quantity) await logMovement(db, {
        actorId: req.auth.sub, resource, quantity, operation: 'reservation',
        entityType: 'reservation', entityId: row.id,
        previousState: { status: null, available: availabilityByResource[resource].available },
        newState: { status: 'pending', payment_status: paymentMethod === 'cash' ? 'pending' : 'unpaid', payment_method: paymentMethod, available: availabilityByResource[resource].available - quantity },
      });
    }
    return row;
  });
  const reservationEmail = await sendReservationEmail(reservation.id, 'reservation');
  res.status(201).json({ reservation, reservationEmail, paymentMode: paymentMethod });
});

app.post('/api/reservations/:id/cash-payment/confirm', requireAdmin, async (req, res) => {
  const result = await inTransaction(async (db) => {
    const found = await db.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [req.params.id]);
    const reservation = found.rows[0];
    if (!reservation) fail(404, 'No se encontró la reserva.');
    if (reservation.payment_method !== 'cash' || reservation.payment_status !== 'pending'
      || reservation.status !== 'pending') {
      fail(409, 'Esta reserva no tiene un pago en efectivo pendiente de confirmación.');
    }
    const paid = await db.query(
      `UPDATE reservations SET payment_status = 'paid', status = 'confirmed',
       paid_at = COALESCE(paid_at, NOW()), updated_at = NOW() WHERE id = $1
       RETURNING paid_at`,
      [reservation.id],
    );
    await logMovement(db, {
      actorId: req.auth.sub, quantity: reservation.tables + reservation.chairs,
      operation: 'cash_payment_confirmed', entityType: 'reservation', entityId: reservation.id,
      previousState: { status: reservation.status, payment_status: reservation.payment_status, payment_method: 'cash' },
      newState: { status: 'confirmed', payment_status: 'paid', payment_method: 'cash', amount_cents: reservation.total_cents },
    });
    return { reservationId: reservation.id, status: 'paid', paymentMethod: 'cash', paidAt: paid.rows[0].paid_at };
  });
  const receiptEmail = await sendReservationEmail(result.reservationId, 'receipt');
  res.json({ ...result, receiptEmail });
});

app.post('/api/reservations/:id/demo-payment', async (req, res) => {
  const attempt = await inTransaction(async (db) => {
    const found = await db.query(
      `SELECT * FROM reservations
       WHERE id = $1 AND ($2::UUID IS NULL OR user_id = $2) FOR UPDATE`,
      [req.params.id, req.auth.role === 'admin' ? null : req.auth.sub],
    );
    const reservation = found.rows[0];
    if (!reservation) fail(404, 'No se encontró la reserva.');
    if (reservation.payment_method !== 'demo') fail(409, 'Esta reserva no usa el pago de prueba.');
    if (reservation.status !== 'pending' || reservation.payment_status === 'paid') fail(409, 'Esta reserva ya no admite un pago de demostración.');
    if (reservation.total_cents <= 0) fail(409, 'Esta reserva no requiere pago.');
    const existing = await db.query(
      `SELECT id, amount_cents, currency, status FROM payment_attempts
       WHERE reservation_id = $1 AND status = 'pending' FOR UPDATE`,
      [reservation.id],
    );
    if (existing.rows[0]) return existing.rows[0];
    const created = await db.query(
      `INSERT INTO payment_attempts (reservation_id, amount_cents, currency)
       VALUES ($1, $2, $3) RETURNING id, amount_cents, currency, status`,
      [reservation.id, reservation.total_cents, process.env.PAYMENT_CURRENCY || 'USD'],
    );
    await db.query(
      `UPDATE reservations SET payment_status = 'pending', updated_at = NOW() WHERE id = $1`,
      [reservation.id],
    );
    await logMovement(db, {
      actorId: req.auth.sub, quantity: reservation.tables + reservation.chairs,
      operation: 'demo_payment_started', entityType: 'reservation', entityId: reservation.id,
      previousState: { payment_status: reservation.payment_status },
      newState: { payment_status: 'pending', provider: 'mesalista_demo' },
    });
    return created.rows[0];
  });
  res.json({
    attempt,
    message: 'Simulación: no se realizará ningún cobro ni se solicitarán datos de pago.',
  });
});

app.post('/api/payments/demo/complete', async (req, res) => {
  const { attemptId } = req.body ?? {};
  if (typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attemptId)) fail(400, 'Identificador de simulación no válido.');
  const completed = await inTransaction(async (db) => {
    const attemptResult = await db.query(
      `SELECT p.*, r.id AS reservation_id, r.user_id, r.status AS reservation_status,
              r.payment_status, r.total_cents, r.tables, r.chairs, r.paid_at
       FROM payment_attempts p
       JOIN reservations r ON r.id = p.reservation_id
       WHERE p.id = $1 AND ($2::UUID IS NULL OR r.user_id = $2)
       FOR UPDATE OF p, r`,
      [attemptId, req.auth.role === 'admin' ? null : req.auth.sub],
    );
    const attempt = attemptResult.rows[0];
    if (!attempt) fail(404, 'No se encontró esta simulación de pago.');
    if (attempt.status === 'succeeded' && attempt.payment_status === 'paid') {
      return { reservationId: attempt.reservation_id, status: 'paid', paidAt: attempt.paid_at };
    }
    if (attempt.status !== 'pending' || attempt.reservation_status !== 'pending'
      || attempt.amount_cents !== attempt.total_cents) {
      fail(409, 'La reserva o el importe cambiaron. No se registró ningún pago.');
    }
    await db.query(
      `UPDATE payment_attempts SET status = 'succeeded', completed_at = NOW() WHERE id = $1`,
      [attempt.id],
    );
    const paid = await db.query(
      `UPDATE reservations SET payment_status = 'paid', status = 'confirmed',
       paid_at = COALESCE(paid_at, NOW()), updated_at = NOW()
       WHERE id = $1 RETURNING paid_at`,
      [attempt.reservation_id],
    );
    await logMovement(db, {
      actorId: req.auth.sub, quantity: attempt.tables + attempt.chairs,
      operation: 'demo_payment_completed', entityType: 'reservation', entityId: attempt.reservation_id,
      previousState: { status: attempt.reservation_status, payment_status: 'pending' },
      newState: { status: 'confirmed', payment_status: 'paid', provider: 'mesalista_demo', amount_cents: attempt.amount_cents, currency: attempt.currency },
    });
    return { reservationId: attempt.reservation_id, status: 'paid', paidAt: paid.rows[0].paid_at };
  });
  const receiptEmail = await sendReservationEmail(completed.reservationId, 'receipt');
  res.json({ ...completed, receiptEmail, simulated: true });
});

app.post('/api/payments/demo/cancel', async (req, res) => {
  const { attemptId } = req.body ?? {};
  if (typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attemptId)) fail(400, 'Identificador de simulación no válido.');
  const result = await inTransaction(async (db) => {
    const locked = await db.query(
      `SELECT p.*, r.id AS reservation_id, r.user_id, r.status AS reservation_status, r.payment_status
       FROM payment_attempts p JOIN reservations r ON r.id = p.reservation_id
       WHERE p.id = $1 AND ($2::UUID IS NULL OR r.user_id = $2)
       FOR UPDATE OF p, r`,
      [attemptId, req.auth.role === 'admin' ? null : req.auth.sub],
    );
    const attempt = locked.rows[0];
    if (!attempt) fail(404, 'No se encontró esta simulación de pago.');
    if (attempt.status !== 'pending') return { status: attempt.status };
    await db.query(
      `UPDATE payment_attempts SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
      [attempt.id],
    );
    await db.query(
      `UPDATE reservations SET payment_status = 'unpaid', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [attempt.reservation_id],
    );
    await logMovement(db, {
      actorId: req.auth.sub, quantity: 0, operation: 'demo_payment_cancelled',
      entityType: 'reservation', entityId: attempt.reservation_id,
      previousState: { payment_status: 'pending' },
      newState: { payment_status: 'unpaid', provider: 'mesalista_demo' },
    });
    return { status: 'cancelled' };
  });
  res.json({ ...result, simulated: true });
});

app.post('/api/reservations/:id/cancel', async (req, res) => {
  const result = await inTransaction(async (db) => {
    await db.query('SELECT resource FROM inventory ORDER BY resource FOR UPDATE');
    const found = await db.query(
      `SELECT * FROM reservations WHERE id = $1 ${req.auth.role === 'admin' ? '' : 'AND user_id = $2'} FOR UPDATE`,
      req.auth.role === 'admin' ? [req.params.id] : [req.params.id, req.auth.sub],
    );
    const reservation = found.rows[0];
    if (!reservation) fail(404, 'No se encontró la reserva.');
    if (!['pending', 'confirmed'].includes(reservation.status) || reservation.payment_status === 'paid') fail(409, 'La reserva ya no se puede cancelar.');
    const before = await getAvailability(db, reservation.reservation_date, reservation.start_time, reservation.end_time);
    const beforeByResource = Object.fromEntries(before.map((item) => [item.resource, item]));
    await db.query(`UPDATE reservations SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [reservation.id]);
    await db.query(
      `UPDATE payment_attempts SET status = 'cancelled', completed_at = NOW()
       WHERE reservation_id = $1 AND status = 'pending'`,
      [reservation.id],
    );
    const after = await getAvailability(db, reservation.reservation_date, reservation.start_time, reservation.end_time);
    const afterByResource = Object.fromEntries(after.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', reservation.tables], ['chairs', reservation.chairs]]) {
      if (!quantity) continue;
      await logMovement(db, {
        actorId: req.auth.sub, resource, quantity, operation: 'reservation_cancelled',
        entityType: 'reservation', entityId: reservation.id,
        previousState: { status: reservation.status, available: beforeByResource[resource].available },
        newState: { status: 'cancelled', available: afterByResource[resource].available },
      });
    }
    return { id: reservation.id, status: 'cancelled' };
  });
  res.json({ reservation: result });
});

app.post('/api/loans', requireAdmin, async (req, res) => {
  const { userId = null, borrowerName, borrowerEmail, dueDate, tables = 0, chairs = 0, observations = '' } = req.body ?? {};
  if ((userId !== null && typeof userId !== 'string')
    || !validEmail(borrowerEmail) || typeof borrowerName !== 'string' || !borrowerName.trim()
    || !validDate(dueDate) || dueDate < today() || !positiveCount(tables) || !positiveCount(chairs)
    || !hasResources(tables, chairs) || typeof observations !== 'string') {
    fail(400, 'Revisa los datos del préstamo y su fecha de devolución.');
  }
  const loan = await inTransaction(async (db) => {
    const borrower = userId
      ? await db.query('SELECT id, email FROM users WHERE id = $1', [userId])
      : { rows: [] };
    if (userId && !borrower.rows[0]) fail(404, 'No se encontró la persona responsable.');
    if (borrower.rows[0] && borrower.rows[0].email.toLowerCase() !== borrowerEmail.trim().toLowerCase()) {
      fail(400, 'El correo no corresponde a la persona seleccionada.');
    }
    await db.query('SELECT resource FROM inventory ORDER BY resource FOR UPDATE');
    await assertLoanCapacity(db, { tables, chairs, startDate: today(), dueDate });
    const before = await getAvailability(db, today());
    const beforeByResource = Object.fromEntries(before.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', tables], ['chairs', chairs]]) {
      if (!quantity) continue;
      await db.query('UPDATE inventory SET loaned = loaned + $1, updated_at = NOW() WHERE resource = $2', [quantity, resource]);
    }
    const created = await db.query(
      `INSERT INTO loans (user_id, borrower_name, borrower_email, due_date, tables, chairs, observations)
       VALUES ($1, $2, LOWER($3), $4, $5, $6, $7) RETURNING *`,
      [userId, borrowerName.trim(), borrowerEmail.trim(), dueDate, tables, chairs, observations.trim()],
    );
    const after = await getAvailability(db, today());
    const afterByResource = Object.fromEntries(after.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', tables], ['chairs', chairs]]) {
      if (quantity) await logMovement(db, {
        actorId: req.auth.sub, resource, quantity, operation: 'loan',
        entityType: 'loan', entityId: created.rows[0].id,
        previousState: { available: beforeByResource[resource].available },
        newState: { status: 'active', available: afterByResource[resource].available },
      });
    }
    return created.rows[0];
  });
  res.status(201).json({ loan });
});

app.post('/api/loans/from-reservation/:id', requireAdmin, async (req, res) => {
  const { dueDate, observations = '' } = req.body ?? {};
  if (!validDate(dueDate) || dueDate < today() || typeof observations !== 'string') fail(400, 'Indica una fecha de devolución válida.');
  const loan = await inTransaction(async (db) => {
    await db.query('SELECT resource FROM inventory ORDER BY resource FOR UPDATE');
    const found = await db.query(
      `SELECT r.*, COALESCE(r.contact_name, u.name) AS user_name,
              COALESCE(r.contact_email, u.email) AS user_email
       FROM reservations r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.id = $1 FOR UPDATE OF r`,
      [req.params.id],
    );
    const reservation = found.rows[0];
    if (!reservation) fail(404, 'No se encontró la reserva.');
    if (reservation.status !== 'confirmed' || reservation.payment_status !== 'paid') fail(409, 'Solo se pueden prestar reservas confirmadas y pagadas.');
    if (reservation.reservation_date > today()) fail(409, 'El préstamo se puede registrar a partir de la fecha reservada.');
    await assertLoanCapacity(db, {
      tables: reservation.tables,
      chairs: reservation.chairs,
      startDate: reservation.reservation_date,
      dueDate,
      excludeReservationId: reservation.id,
    });
    const before = await getAvailability(db, reservation.reservation_date, reservation.start_time, reservation.end_time);
    const beforeByResource = Object.fromEntries(before.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', reservation.tables], ['chairs', reservation.chairs]]) {
      if (!quantity) continue;
      await db.query('UPDATE inventory SET loaned = loaned + $1, updated_at = NOW() WHERE resource = $2', [quantity, resource]);
    }
    const created = await db.query(
      `INSERT INTO loans (user_id, reservation_id, borrower_name, borrower_email, due_date, tables, chairs, observations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [reservation.user_id, reservation.id, reservation.user_name || 'Titular de reserva', reservation.user_email || '', dueDate, reservation.tables, reservation.chairs, observations.trim()],
    );
    await db.query(`UPDATE reservations SET status = 'completed', updated_at = NOW() WHERE id = $1`, [reservation.id]);
    const after = await getAvailability(db, reservation.reservation_date, reservation.start_time, reservation.end_time);
    const afterByResource = Object.fromEntries(after.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', reservation.tables], ['chairs', reservation.chairs]]) {
      if (quantity) await logMovement(db, {
        actorId: req.auth.sub, resource, quantity, operation: 'reservation_to_loan',
        entityType: 'loan', entityId: created.rows[0].id,
        previousState: { reservation_status: 'confirmed', available: beforeByResource[resource].available },
        newState: { loan_status: 'active', available: afterByResource[resource].available },
      });
    }
    return created.rows[0];
  });
  res.status(201).json({ loan });
});

app.get('/api/loans', async (req, res) => {
  const admin = req.auth.role === 'admin';
  const result = await pool.query(
    `SELECT l.*, COALESCE(l.borrower_email, u.email) AS user_email,
            GREATEST(l.tables - l.tables_returned, 0) AS tables_pending,
            GREATEST(l.chairs - l.chairs_returned, 0) AS chairs_pending,
            CASE WHEN l.status IN ('active', 'partially_returned') AND l.due_date < CURRENT_DATE THEN 'overdue' ELSE l.status END AS effective_status
     FROM loans l LEFT JOIN users u ON u.id = l.user_id
     ${admin ? '' : `WHERE l.user_id = $1
       OR (l.user_id IS NULL AND LOWER(l.borrower_email) = (
         SELECT LOWER(email) FROM users WHERE id = $1
       ))`}
     ORDER BY l.created_at DESC LIMIT 100`,
    admin ? [] : [req.auth.sub],
  );
  res.json({ loans: result.rows });
});

app.post('/api/loans/:id/returns', requireAdmin, async (req, res) => {
  const { tables = 0, chairs = 0 } = req.body ?? {};
  if (!positiveCount(tables) || !positiveCount(chairs) || !hasResources(tables, chairs)) {
    fail(400, 'Indica una cantidad válida para devolver.');
  }
  const loan = await inTransaction(async (db) => {
    const found = await db.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [req.params.id]);
    const current = found.rows[0];
    if (!current) fail(404, 'No se encontró el préstamo.');
    const tablesPending = current.tables - current.tables_returned;
    const chairsPending = current.chairs - current.chairs_returned;
    if (tables > tablesPending || chairs > chairsPending) fail(409, `La devolución supera lo pendiente (${tablesPending} mesas y ${chairsPending} sillas).`);
    const before = await getAvailability(db, today());
    const beforeByResource = Object.fromEntries(before.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', tables], ['chairs', chairs]]) {
      if (!quantity) continue;
      await db.query('UPDATE inventory SET loaned = loaned - $1, updated_at = NOW() WHERE resource = $2', [quantity, resource]);
    }
    const returnedTables = current.tables_returned + tables;
    const returnedChairs = current.chairs_returned + chairs;
    const status = returnedTables === current.tables && returnedChairs === current.chairs ? 'returned' : 'partially_returned';
    const updated = await db.query(
      `UPDATE loans SET tables_returned = $1, chairs_returned = $2, status = $3 WHERE id = $4 RETURNING *`,
      [returnedTables, returnedChairs, status, current.id],
    );
    await db.query(
      `INSERT INTO loan_returns (loan_id, actor_id, tables, chairs) VALUES ($1, $2, $3, $4)`,
      [current.id, req.auth.sub, tables, chairs],
    );
    const after = await getAvailability(db, today());
    const afterByResource = Object.fromEntries(after.map((item) => [item.resource, item]));
    for (const [resource, quantity] of [['tables', tables], ['chairs', chairs]]) {
      if (quantity) await logMovement(db, {
        actorId: req.auth.sub, resource, quantity,
        operation: status === 'returned' ? 'return' : 'partial_return',
        entityType: 'loan', entityId: current.id,
        previousState: { status: current.status, available: beforeByResource[resource].available },
        newState: { status, available: afterByResource[resource].available },
      });
    }
    return updated.rows[0];
  });
  res.json({ loan });
});

app.get('/api/movements', requireAdmin, async (_req, res) => {
  const result = await pool.query(
    `SELECT m.*, COALESCE(u.name, m.actor_email) AS actor_name
     FROM movements m LEFT JOIN users u ON u.id = m.actor_id
     ORDER BY m.created_at DESC LIMIT 200`,
  );
  res.json({ movements: result.rows });
});

app.get('/api/users', requireAdmin, async (_req, res) => {
  const result = await pool.query('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC');
  res.json({ users: result.rows });
});

app.patch('/api/users/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body ?? {};
  if (!['admin', 'user'].includes(role)) fail(400, 'El rol debe ser admin o user.');
  if (req.params.id === req.auth.sub) fail(409, 'No puedes cambiar tu propio rol. Pide a otro administrador que lo haga.');
  const updated = await inTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(740213)');
    const target = await db.query('SELECT id, name, email, role FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
    const user = target.rows[0];
    if (!user) fail(404, 'No se encontró el usuario.');
    if (user.role === 'admin' && role === 'user') {
      const admins = await db.query(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
      if (Number(admins.rows[0].count) < 2) fail(409, 'Debe permanecer al menos un administrador en el sistema.');
    }
    return (await db.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role',
      [role, user.id],
    )).rows[0];
  });
  res.json({ user: updated });
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Ocurrió un error inesperado en el servidor.' });
});

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3001);
  try {
    await ensureDatabase();
    app.listen(port, '0.0.0.0', () => console.log(`API lista en http://localhost:${port}`));
  } catch (error) {
    console.error('No se pudo iniciar la API:', error);
    process.exitCode = 1;
  }
}

export default app;
