import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = async (path, token, options = {}) => {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && token) {
    window.dispatchEvent(new Event('mesalista:session-expired'));
  }
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
};

const money = (cents, currency = 'USD') => new Intl.NumberFormat('es', {
  style: 'currency', currency, maximumFractionDigits: 2,
}).format((Number(cents) || 0) / 100);
const localDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const dateLabel = (value) => value
  ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—';

const statusNames = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
  completed: 'Finalizada',
  active: 'Activo',
  partially_returned: 'Devolución parcial',
  returned: 'Devuelto',
  overdue: 'Vencido',
  paid: 'Pagado',
  unpaid: 'Pago pendiente',
};

function inventoryIsEmpty(inventory) {
  if (!Array.isArray(inventory)) return false;
  const items = Object.fromEntries(inventory.map((item) => [item.resource, item]));
  return ['tables', 'chairs'].every((resource) => Number(items[resource]?.available) <= 0
    && items[resource]?.available !== undefined);
}

function InventoryUnavailableNotice({ inventory }) {
  if (!inventoryIsEmpty(inventory)) return null;
  return <div className="inventory-unavailable" role="alert">
    <strong>Actualmente no hay mesas ni sillas disponibles.</strong>
    <span>Espera a que el dueño agregue más.</span>
  </div>;
}

function QuantityControl({ label, value, max, onChange }) {
  const update = (amount) => onChange(Math.min(max, Math.max(0, Number(value) + amount)));
  const setFromInput = (event) => {
    const next = Number(event.target.value);
    onChange(Math.min(max, Math.max(0, Number.isFinite(next) ? next : 0)));
  };
  return <div className="quantity-control">
    <button type="button" aria-label={`Bajar cantidad de ${label.toLowerCase()}`} disabled={value <= 0} onClick={() => update(-1)}>↓</button>
    <input aria-label={`Cantidad de ${label.toLowerCase()}`} type="number" inputMode="numeric" min="0" max={max} step="1" value={value} onChange={setFromInput} />
    <button type="button" aria-label={`Subir cantidad de ${label.toLowerCase()}`} disabled={value >= max} onClick={() => update(1)}>↑</button>
  </div>;
}

function AuthScreen({ onLogin, theme, onToggleTheme, onGuestReservation, sessionExpired }) {
  const [register, setRegister] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api(`/auth/${register ? 'register' : 'login'}`, null, {
        method: 'POST', body: JSON.stringify(form),
      });
      onLogin(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand-row"><Brand /><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div>
        <div className="auth-intro">
          <span className="eyebrow">GESTIÓN DE EVENTOS SIN COMPLICACIONES</span>
          <h1>{register ? 'Crea tu cuenta' : 'Todo listo para tu próximo evento.'}</h1>
          <p>Reserva mesas y sillas, y mantén cada movimiento bajo control.</p>
        </div>
        {sessionExpired && <p className="form-error" role="alert">Tu sesión anterior expiró o dejó de ser válida. Inicia sesión de nuevo.</p>}
        <form onSubmit={submit} className="stack-form">
          {register && <label>Nombre completo<input required minLength="2" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>}
          <label>Correo electrónico<input required type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label>Contraseña<input required type="password" minLength={register ? 10 : 1} autoComplete={register ? 'new-password' : 'current-password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="button primary full" disabled={busy}>{busy ? 'Un momento…' : register ? 'Crear cuenta' : 'Iniciar sesión'} <span>→</span></button>
        </form>
        <button className="text-button auth-toggle" onClick={() => { setRegister(!register); setError(''); }}>
          {register ? '¿Ya tienes una cuenta? Inicia sesión' : '¿Primera vez aquí? Crea una cuenta'}
        </button>
        <button className="text-button auth-toggle" onClick={onGuestReservation}>Reservar solo con mi correo</button>
        <p className="auth-legal">Tus reservas y movimientos se guardan de forma segura.</p>
      </section>
      <aside className="auth-art"><img src="/venue.svg" alt="Mesas y sillas listas para un evento" /><div><span className="art-mark">M</span><p>Un espacio bien preparado<br /><strong>empieza aquí.</strong></p></div></aside>
    </main>
  );
}

function GuestReservationPage({ theme, onToggleTheme, onBack }) {
  const [form, setForm] = useState({ name: '', email: '' });
  const [tables, setTables] = useState(0);
  const [chairs, setChairs] = useState(0);
  const [date, setDate] = useState(localDate());
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('demo');
  const [availability, setAvailability] = useState(null);
  const [rates, setRates] = useState({ tables: 0, chairs: 0, currency: 'USD' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [guestReservation, setGuestReservation] = useState(null);
  const [guestKey, setGuestKey] = useState('');
  const [checkout, setCheckout] = useState(null);
  const [paid, setPaid] = useState(false);
  const [guestPaidAt, setGuestPaidAt] = useState(null);
  const [guestInvoiceOpen, setGuestInvoiceOpen] = useState(false);
  const [guestReceiptEmail, setGuestReceiptEmail] = useState(null);
  const [guestReservationEmail, setGuestReservationEmail] = useState(null);
  const total = tables * rates.tables + chairs * rates.chairs;
  const invalidHours = Boolean(start) !== Boolean(end) || Boolean(start && end && end <= start);

  useEffect(() => {
    let current = true;
    let firstLoad = true;
    let loadingAvailability = false;
    const loadAvailability = async () => {
      if (loadingAvailability || document.visibilityState === 'hidden') return;
      loadingAvailability = true;
      try {
        const params = new URLSearchParams({ date });
        if (start && end) {
          params.set('startTime', start);
          params.set('endTime', end);
        }
        if (Boolean(start) !== Boolean(end)) {
          setAvailability(null);
          setLoading(false);
          firstLoad = false;
          return;
        }
        const result = await api(`/guest/availability?${params}`, null);
        if (current) {
          setAvailability(result.inventory);
          setRates(result.rates);
          setError('');
        }
      } catch (err) {
        if (current) {
          setAvailability(null);
          setError(err.message);
        }
      } finally {
        if (current && firstLoad) {
          setLoading(false);
          firstLoad = false;
        }
        loadingAvailability = false;
      }
    };
    setLoading(true);
    loadAvailability();
    const timer = window.setInterval(loadAvailability, 8000);
    window.addEventListener('focus', loadAvailability);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', loadAvailability);
    };
  }, [date, start, end]);

  const items = Object.fromEntries((availability || []).map((item) => [item.resource, item]));
  const beginDemoPayment = async (reservation, key) => {
    const { attempt } = await api(`/guest/reservations/${reservation.id}/demo-payment`, null, {
      method: 'POST',
      headers: { 'X-Reservation-Key': key },
    });
    setCheckout({ ...reservation, paymentAttemptId: attempt.id });
  };
  const reserve = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api('/guest/reservations', null, {
        method: 'POST',
        body: JSON.stringify({
          ...form, reservationDate: date, startTime: start || null, endTime: end || null,
          tables: Number(tables), chairs: Number(chairs), paymentMethod,
        }),
      });
      setGuestReservation(result.reservation);
      setGuestKey(result.guestKey);
      setGuestReservationEmail(result.reservationEmail || null);
      if (paymentMethod === 'demo' && result.reservation.total_cents > 0) {
        await beginDemoPayment(result.reservation, result.guestKey);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return <main className="guest-page">
    <header className="guest-topbar"><Brand /><div className="guest-top-actions"><ThemeToggle theme={theme} onToggle={onToggleTheme} /><button className="text-button" onClick={onBack}>Iniciar sesión</button></div></header>
    <section className="guest-card panel">
      <PageHeading eyebrow="RESERVA SIN CUENTA" title="Reserva solo con tu correo" description="No necesitas crear una cuenta. Administración usará este correo para identificar la reserva y cualquier préstamo." />
      {guestReservation ? <div className="guest-confirmation" role="status">
        <span className="guest-confirmation-icon">{paid ? '✓' : '◷'}</span>
        <h2>{guestReservation.payment_method === 'cash' ? 'Pago en efectivo pendiente' : paid ? 'Pago de prueba completado' : 'Solicitud registrada'}</h2>
        <p>{paid
          ? 'La reserva quedó confirmada en la base de datos. Conserva este correo como referencia; no hay un portal público para consultar o cancelar reservas.'
          : guestReservation.payment_method === 'cash'
            ? 'Registramos la reserva a nombre de ' + guestReservation.contact_email + '. Los recursos quedan apartados; el pago y la confirmación quedan pendientes hasta que administración reciba el efectivo.'
            : 'La solicitud quedó registrada y los recursos están apartados. El administrador puede ver tu correo; no hay un portal público para consultar o cancelar reservas.'}</p>
        {guestReservationEmail && <p className={guestReservationEmail.sent ? 'receipt-email-success' : 'receipt-email-warning'}>
          {guestReservationEmail.sent
            ? `Enviamos la confirmación de la reserva a ${guestReservationEmail.email}.`
            : `La reserva se registró, pero no se pudo enviar la confirmación: ${guestReservationEmail.reason}`}
        </p>}
        {paid && guestReceiptEmail && <p className={guestReceiptEmail.sent ? 'receipt-email-success' : 'receipt-email-warning'}>
          {guestReceiptEmail.sent
            ? `También enviamos una copia del comprobante a ${guestReceiptEmail.email}.`
            : `El pago sí quedó confirmado, pero no se pudo enviar el correo: ${guestReceiptEmail.reason}`}
        </p>}
        {paid && <button className="table-action" onClick={() => setGuestInvoiceOpen(true)}>Ver comprobante</button>}
        {!paid && guestReservation.payment_method === 'demo' && guestKey && guestReservation.total_cents > 0 && <button className="button primary" disabled={busy} onClick={() => {
          setBusy(true);
          setError('');
          beginDemoPayment(guestReservation, guestKey).catch((err) => setError(err.message)).finally(() => setBusy(false));
        }}>Continuar al pago de prueba <span>→</span></button>}
      </div> : <form className="guest-form" onSubmit={reserve}>
        <div className="guest-contact-fields">
          <label>Correo electrónico<input type="email" required autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
          <label>Nombre <span className="optional">opcional</span><input autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        </div>
        <div className="form-two"><label>Fecha del evento<input type="date" required min={localDate()} value={date} onChange={(event) => setDate(event.target.value)} /></label><label>Hora de inicio <span className="optional">opcional</span><input type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>Hora de finalización <span className="optional">opcional</span><input type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div>
        {invalidHours && <p className="form-error">Completa ambas horas y asegúrate de que la finalización sea posterior al inicio.</p>}
        <fieldset className="payment-choice"><legend>Forma de pago</legend>
          <label className={`payment-choice-card ${paymentMethod === 'demo' ? 'selected' : ''}`}><input type="radio" name="guest-payment-method" value="demo" checked={paymentMethod === 'demo'} onChange={() => setPaymentMethod('demo')} /><span className="payment-choice-icon">P</span><span><strong>Pago de prueba</strong><small>No cobra dinero real</small></span><span className="choice-indicator" /></label>
          <label className={`payment-choice-card ${paymentMethod === 'cash' ? 'selected' : ''}`}><input type="radio" name="guest-payment-method" value="cash" checked={paymentMethod === 'cash'} onChange={() => setPaymentMethod('cash')} /><span className="payment-choice-icon cash-icon">$</span><span><strong>Efectivo</strong><small>Administración confirma el pago</small></span><span className="choice-indicator" /></label>
        </fieldset>
        <div className="guest-stock">
          <InventoryUnavailableNotice inventory={availability} />
          {[['tables', 'Mesas', tables, setTables, 'mint'], ['chairs', 'Sillas', chairs, setChairs, 'lavender']].map(([resource, label, count, setCount, tone]) => <div className="quantity-row" key={resource}>
            <div><span className={`quantity-symbol ${tone}`}>{resource === 'tables' ? '▤' : '▥'}</span><span><strong>{label}</strong><small>{items[resource]?.available ?? 0} disponibles</small></span></div>
            <QuantityControl label={label} value={count} max={items[resource]?.available ?? 0} onChange={setCount} />
          </div>)}
        </div>
        {total > 0 && <div className="price-row"><span>Estimado por el día</span><strong>{money(total, rates.currency)}</strong></div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary full" disabled={busy || loading || Boolean(error) || invalidHours || !Number(tables) && !Number(chairs)}>{busy ? 'Procesando…' : loading ? 'Consultando disponibilidad…' : total > 0 ? 'Continuar a demostración de pago' : 'Confirmar solicitud'} <span>→</span></button>
        <p className="secure-note">{paymentMethod === 'cash' ? 'La reserva queda pendiente hasta que administración confirme la recepción del efectivo.' : 'Pago de prueba claramente marcado como DEMO; no es PayPal y no realiza cobros reales.'}</p>
      </form>}
      {error && guestReservation && <p className="form-error" role="alert">{error}</p>}
    </section>
    {checkout && <DemoCheckout reservation={checkout} currency={rates.currency} token={null} guestKey={guestKey} onRun={async (action, success) => {
      setBusy(true);
      setError('');
      try {
        await action();
        if (success) setPaid(true);
        if (success) setGuestKey('');
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    }} onClose={(completed, payment) => {
      setCheckout(null);
      if (completed) {
        setPaid(true);
        setGuestPaidAt(payment?.paidAt || new Date().toISOString());
        setGuestReceiptEmail(payment?.receiptEmail || null);
        setGuestInvoiceOpen(true);
      }
    }} />}
    {guestInvoiceOpen && guestReservation && paid && <InvoiceDocument
      reservation={guestReservation}
      currency={rates.currency}
      customerName={guestReservation.contact_name || form.name || 'Invitado'}
      customerEmail={guestReservation.contact_email || form.email}
      paidAt={guestPaidAt}
      onClose={() => setGuestInvoiceOpen(false)}
    />}
  </main>;
}

function Brand() {
  return <div className="brand"><span className="brand-icon"><span /></span><span>Mesa<span>Lista</span></span></div>;
}

function App() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('mesalista-theme') || 'light'; } catch { return 'light'; }
  });
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem('mesalista-session')); } catch { return null; }
  });
  const [guestMode, setGuestMode] = useState(false);
  const [page, setPage] = useState('inicio');
  const [dashboard, setDashboard] = useState(null);
  const [reservations, setReservations] = useState([]);
  const [loans, setLoans] = useState([]);
  const [movements, setMovements] = useState([]);
  const [users, setUsers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [demoReservation, setDemoReservation] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);
  const [invoiceId, setInvoiceId] = useState(null);
  const [receiptEmailError, setReceiptEmailError] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = session?.user?.role === 'admin';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('mesalista-theme', theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    if (!session?.token) return;
    const [dash, reservationData, loanData] = await Promise.all([
      api('/dashboard', session.token),
      api('/reservations', session.token),
      api('/loans', session.token),
    ]);
    setDashboard(dash);
    setReservations(reservationData.reservations);
    setLoans(loanData.loans);
  }, [session]);

  const refreshAdmin = useCallback(async () => {
    if (!session?.token || session.user?.role !== 'admin') return;
    const [history, userData, employeeData] = await Promise.all([
      api('/movements', session.token),
      api('/users', session.token),
      api('/employees', session.token),
    ]);
    setMovements(history.movements);
    setUsers(userData.users);
    setEmployees(employeeData.employees);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    localStorage.setItem('mesalista-session', JSON.stringify(session));
    Promise.all([refresh(), refreshAdmin()]).catch((err) => setError(err.message));
  }, [session, refresh, refreshAdmin]);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId || invoiceId) return;
    const paidReservations = reservations.filter((reservation) => reservation.payment_status === 'paid'
      && (!isAdmin || reservation.user_id === userId));
    if (!paidReservations.length) return;
    let dismissed = [];
    try {
      const stored = JSON.parse(localStorage.getItem(`mesalista-dismissed-invoices:${userId}`) || '[]');
      if (Array.isArray(stored)) dismissed = stored;
    } catch {
      dismissed = [];
    }
    const nextInvoice = paidReservations.find((reservation) => !dismissed.includes(reservation.id));
    if (nextInvoice) setInvoiceId(nextInvoice.id);
  }, [session?.user?.id, isAdmin, invoiceId, reservations]);

  useEffect(() => {
    const handleExpiredSession = () => {
      localStorage.removeItem('mesalista-session');
      setSession(null);
      setDashboard(null);
      setReservations([]);
      setLoans([]);
      setMovements([]);
      setUsers([]);
      setEmployees([]);
      setDemoReservation(null);
      setInvoiceId(null);
      setSessionExpired(true);
      setError('');
      setNotice('');
    };
    window.addEventListener('mesalista:session-expired', handleExpiredSession);
    return () => window.removeEventListener('mesalista:session-expired', handleExpiredSession);
  }, []);

  useEffect(() => {
    if (!session?.token) return undefined;
    let updating = false;
    const sync = () => {
      if (updating || document.visibilityState === 'hidden') return;
      updating = true;
      Promise.all([refresh(), refreshAdmin()])
        .catch((err) => setError(err.message))
        .finally(() => { updating = false; });
    };
    const timer = window.setInterval(sync, 8000);
    window.addEventListener('focus', sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
    };
  }, [session?.token, refresh, refreshAdmin]);

  useEffect(() => {
    if (!notice && !error) return undefined;
    const timeout = setTimeout(() => { setNotice(''); setError(''); }, 6500);
    return () => clearTimeout(timeout);
  }, [notice, error]);

  const login = (value) => {
    localStorage.setItem('mesalista-session', JSON.stringify(value));
    setSessionExpired(false);
    setEmployees([]);
    setSession(value);
  };
  const logout = () => {
    localStorage.removeItem('mesalista-session');
    setSession(null);
    setDashboard(null);
    setEmployees([]);
    setInvoiceId(null);
  };
  const dismissInvoice = (reservationId) => {
    setReceiptEmailError('');
    if (session?.user?.id) {
      const key = `mesalista-dismissed-invoices:${session.user.id}`;
      let dismissed = [];
      try {
        const stored = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(stored)) dismissed = stored;
      } catch {
        dismissed = [];
      }
      if (!dismissed.includes(reservationId)) {
        localStorage.setItem(key, JSON.stringify([...dismissed, reservationId]));
      }
    }
    setInvoiceId(null);
  };
  const run = async (action, success, onError) => {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      const emailResult = result?.reservationEmail || result?.receiptEmail;
      if (emailResult?.sent) {
        setNotice(result?.reservationEmail
          ? `Reserva guardada. Enviamos la confirmación a ${emailResult.email}.`
          : `Comprobante enviado a ${emailResult.email}.`);
      } else if (emailResult && !emailResult.sent) {
        setError(`${result?.reservationEmail ? 'La reserva se guardó' : 'El pago se confirmó'}, pero no se pudo enviar el correo: ${emailResult.reason}`);
      } else if (success) {
        setNotice(success);
      }
      await refresh();
      if (isAdmin) await refreshAdmin();
      return result ?? true;
    } catch (err) {
      setError(err.message);
      onError?.(err.message);
      try {
        await refresh();
      } catch (refreshError) {
        setError(`${err.message} No se pudo actualizar el panel: ${refreshError.message}`);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  const emailReceipt = async (reservationId) => {
    setReceiptEmailError('');
    const result = await run(
      () => api(`/reservations/${reservationId}/receipt-email`, session.token, { method: 'POST', body: '{}' }),
      undefined,
      setReceiptEmailError,
    );
    if (!result || result === true) return;
    if (result.receiptEmail?.sent) {
      setNotice(`Comprobante enviado a ${result.receiptEmail.email}.`);
      setReservations((current) => current.map((reservation) => reservation.id === reservationId
        ? { ...reservation, receipt_email_sent_at: result.receiptEmail.sentAt || new Date().toISOString() }
        : reservation));
    } else {
      const reason = result.receiptEmail?.reason || 'No se pudo enviar el comprobante por correo.';
      setReceiptEmailError(reason);
      setError(reason);
    }
  };
  const emailReservation = async (reservationId, type) => {
    const path = type === 'receipt' ? 'receipt-email' : 'reservation-email';
    const result = await run(
      () => api(`/reservations/${reservationId}/${path}`, session.token, { method: 'POST', body: '{}' }),
    );
    if (!result || result === true) return;
    const emailResult = result.receiptEmail || result.reservationEmail;
    if (emailResult?.sent) {
      setNotice(`Correo enviado a ${emailResult.email}.`);
      const sentAtField = type === 'receipt' ? 'receipt_email_sent_at' : 'reservation_email_sent_at';
      setReservations((current) => current.map((reservation) => reservation.id === reservationId
        ? { ...reservation, [sentAtField]: emailResult.sentAt || new Date().toISOString() }
        : reservation));
    } else {
      setError(emailResult?.reason || 'No se pudo enviar el correo.');
    }
  };
  const showReceiptEmailResult = (receiptEmail) => {
    if (receiptEmail?.sent) {
      setNotice(`Comprobante enviado a ${receiptEmail.email}.`);
    } else {
      setError(`Pago confirmado, pero no se pudo enviar el comprobante: ${receiptEmail?.reason || 'revisa la configuración de correo'}`);
    }
  };

  if (!session && guestMode) return <GuestReservationPage
    theme={theme}
    onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    onBack={() => setGuestMode(false)}
  />;
  if (!session) return <AuthScreen
    onLogin={login}
    theme={theme}
    onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    onGuestReservation={() => setGuestMode(true)}
    sessionExpired={sessionExpired}
  />;
  const nav = [
    { id: 'inicio', label: 'Resumen', icon: '⌂' },
    { id: 'reservas', label: 'Reservas', icon: '▦' },
    { id: 'prestamos', label: 'Préstamos', icon: '↗' },
    ...(isAdmin ? [
      { id: 'trabajadores', label: 'Trabajadores', icon: '♙' },
      { id: 'salarios', label: 'Salarios', icon: '$' },
    ] : []),
    ...(isAdmin ? [{ id: 'historial', label: 'Historial', icon: '◷' }] : []),
  ];
  const invoiceReservation = reservations.find((reservation) => reservation.id === invoiceId);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="nav-label">MENÚ PRINCIPAL</div>
        <nav>{nav.map((item) => <button key={item.id} className={`nav-link ${page === item.id ? 'selected' : ''}`} onClick={() => setPage(item.id)}><span className="nav-icon">{item.icon}</span>{item.label}{page === item.id && <span className="nav-dot" />}</button>)}</nav>
        <div className="sidebar-spacer" />
        <div className="help-card"><span className="help-spark">✳</span><strong>¿Necesitas ayuda?</strong><p>Consulta con el equipo de administración.</p></div>
        <button className="profile" onClick={logout}><span className="avatar">{session.user.name.slice(0, 1).toUpperCase()}</span><span className="profile-name"><strong>{session.user.name}</strong><small>{isAdmin ? 'Administrador' : 'Usuario'}</small></span><span className="logout-icon">↪</span></button>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><Brand /></div>
          <div className="crumb">Workspace <span>/</span> <strong>{nav.find((item) => item.id === page)?.label}</strong></div>
          <div className="top-actions"><span className="today-label">{new Date().toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' })}</span><button className="icon-button" aria-label="Actualizar" onClick={() => refresh().catch((err) => setError(err.message))}>⟳</button><ThemeToggle theme={theme} onToggle={() => setTheme(theme === 'dark' ? 'light' : 'dark')} /><span className="avatar small">{session.user.name.slice(0, 1).toUpperCase()}</span></div>
        </header>
        <div className="content">
          <InventoryUnavailableNotice inventory={dashboard?.inventory} />
          {error && <div className="toast error-toast" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
          {notice && <div className="toast success-toast" role="status">{notice}<button onClick={() => setNotice('')}>×</button></div>}
          {page === 'inicio' && <Dashboard dashboard={dashboard} isAdmin={isAdmin} reservations={reservations} loans={loans} onGo={setPage} onRun={run} token={session.token} />}
          {page === 'reservas' && <Reservations dashboard={dashboard} reservations={reservations} users={users} currentUser={session.user} busy={busy} onRun={run} token={session.token} isAdmin={isAdmin} onDemoPayment={setDemoReservation} onShowInvoice={setInvoiceId} onReceiptEmail={showReceiptEmailResult} onEmailReservation={emailReservation} />}
          {page === 'prestamos' && <Loans loans={loans} users={users} reservations={reservations} isAdmin={isAdmin} busy={busy} onRun={run} token={session.token} />}
          {page === 'trabajadores' && isAdmin && <Employees employees={employees} busy={busy} onRun={run} token={session.token} />}
          {page === 'salarios' && isAdmin && <Salaries employees={employees} busy={busy} onRun={run} token={session.token} />}
          {page === 'historial' && isAdmin && <History movements={movements} users={users} onRun={run} token={session.token} onRefresh={refreshAdmin} />}
          <footer className="footer">MesaLista <span>·</span> Inventario claro, eventos tranquilos</footer>
        </div>
      </main>
      {demoReservation && <DemoCheckout reservation={demoReservation} currency={dashboard?.rates.currency || 'USD'} token={session.token} onRun={run} onClose={(completed, payment) => {
        setDemoReservation(null);
        if (completed && payment?.receiptEmail) showReceiptEmailResult(payment.receiptEmail);
      }} />}
      {invoiceReservation && <InvoiceDocument
        reservation={invoiceReservation}
        currency={dashboard?.rates.currency || 'USD'}
        customerName={invoiceReservation.user_name || invoiceReservation.contact_name
          || (invoiceReservation.user_id === session.user.id ? session.user.name : 'Usuario')}
        customerEmail={invoiceReservation.user_email || invoiceReservation.contact_email
          || (invoiceReservation.user_id === session.user.id ? session.user.email : '—')}
        onClose={() => dismissInvoice(invoiceId)}
        onEmailReceipt={() => emailReceipt(invoiceReservation.id)}
        receiptEmailError={receiptEmailError}
        receiptEmailBusy={busy}
      />}
    </div>
  );
}

function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark';
  return <button className="theme-toggle" type="button" aria-label={dark ? 'Activar modo claro' : 'Activar modo oscuro'} title={dark ? 'Modo claro' : 'Modo oscuro'} onClick={onToggle}>
    <span aria-hidden="true">{dark ? '☀' : '☾'}</span><span className="theme-toggle-label">{dark ? 'Claro' : 'Oscuro'}</span>
  </button>;
}

function PageHeading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function Dashboard({ dashboard, isAdmin, reservations, loans, onGo, onRun, token }) {
  if (!dashboard) return <div className="loading"><span className="spinner" /> Cargando tu espacio…</div>;
  const items = Object.fromEntries(dashboard.inventory.map((item) => [item.resource, item]));
  const tables = items.tables || { total: 0, available: 0, reserved: 0, loaned: 0 };
  const chairs = items.chairs || { total: 0, available: 0, reserved: 0, loaned: 0 };
  return <>
    <PageHeading eyebrow="TU ESPACIO DE GESTIÓN" title={`Hola, ${sessionName()}`} description="Un vistazo claro a tu inventario y a todo lo que está en movimiento." action={<button className="button primary" onClick={() => onGo('reservas')}><span>＋</span> Nueva reserva</button>} />
    <section className="hero-banner">
      <div className="hero-copy"><span className="hero-kicker"><span className="live-dot" /> TODO EN ORDEN</span><h2>Prepara el espacio.<br />Nosotros cuidamos los detalles.</h2><p>Consulta disponibilidad y organiza tus recursos desde un solo lugar.</p><button className="hero-link" onClick={() => onGo('reservas')}>Ver disponibilidad <span>→</span></button></div>
      <img src="/venue.svg" alt="Mesas y sillas organizadas para un evento" className="hero-illustration" />
      <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" />
    </section>
    <div className="section-head"><div><h2>Inventario disponible</h2><p>Actualizado automáticamente con cada movimiento</p></div><span className="sync-label"><span className="live-dot" /> En vivo</span></div>
    <section className="resource-grid">
      <ResourceCard title="Mesas" item={tables} icon="▤" tone="mint" isAdmin={isAdmin} onRun={onRun} token={token} />
      <ResourceCard title="Sillas" item={chairs} icon="▥" tone="lavender" isAdmin={isAdmin} onRun={onRun} token={token} />
    </section>
    <section className="metric-grid">
      <Metric label="Reservas pendientes" value={dashboard.reservationsPending} icon="◷" tone="peach" />
      <Metric label="Préstamos activos" value={dashboard.loansActive} icon="↗" tone="blue" />
      <Metric label="Préstamos vencidos" value={dashboard.loansOverdue} icon="!" tone="rose" />
      <Metric label="Devoluciones pendientes" value={dashboard.returnsPending} icon="↩" tone="yellow" />
    </section>
    <section className="lower-grid">
      <div className="panel">
        <div className="panel-heading"><div><h2>Próximos movimientos</h2><p>Lo que está pasando con tus recursos</p></div><button className="text-button" onClick={() => onGo('reservas')}>Ver todo →</button></div>
        {reservations.length === 0 && loans.length === 0 ? <EmptyState text="Todavía no hay movimientos. Tu próxima reserva empieza aquí." /> : <div className="activity-list">{[...reservations.slice(0, 3).map((item) => ({ ...item, kind: 'Reserva', when: item.reservation_date })), ...loans.slice(0, 3).map((item) => ({ ...item, kind: 'Préstamo', when: item.due_date }))].slice(0, 5).map((item) => <div className="activity-row" key={`${item.kind}-${item.id}`}><span className={`activity-icon ${item.kind === 'Reserva' ? 'activity-violet' : 'activity-teal'}`}>{item.kind === 'Reserva' ? '▦' : '↗'}</span><div className="activity-main"><strong>{item.kind} de recursos</strong><small>{Number(item.tables) > 0 ? `${item.tables} mesas` : ''}{Number(item.tables) && Number(item.chairs) ? ' · ' : ''}{Number(item.chairs) > 0 ? `${item.chairs} sillas` : ''}</small></div><span className="activity-date">{dateLabel(item.when)}</span><Status status={item.effective_status || item.status} /></div>)}</div>}
      </div>
      <div className="panel quick-panel"><div className="panel-heading"><div><h2>Acciones rápidas</h2><p>Atajos para tu día a día</p></div></div><button className="quick-action" onClick={() => onGo('reservas')}><span className="quick-icon mint">▦</span><span><strong>Hacer una reserva</strong><small>Elige fecha y cantidades</small></span><span className="quick-arrow">→</span></button><button className="quick-action" onClick={() => onGo('prestamos')}><span className="quick-icon lavender">↗</span><span><strong>Consultar préstamos</strong><small>Revisa fechas de devolución</small></span><span className="quick-arrow">→</span></button>{!isAdmin && <div className="payment-note"><span>◇</span><div><strong>Checkout de prueba</strong><small>Solo cambia el estado; no cobra dinero</small></div><span className="payment-word">DEMO</span></div>}</div>
    </section>
  </>;
}

function sessionName() {
  try { return JSON.parse(localStorage.getItem('mesalista-session'))?.user?.name?.split(' ')[0] || 'bienvenido'; } catch { return 'bienvenido'; }
}

function ResourceCard({ title, item, icon, tone, isAdmin, onRun, token }) {
  const [total, setTotal] = useState(item.total);
  useEffect(() => setTotal(item.total), [item.total]);
  const percentage = item.total ? Math.round(item.available / item.total * 100) : 0;
  return <article className={`resource-card ${tone}`}><div className="resource-top"><span className={`resource-icon ${tone}`}>{icon}</span><span className="resource-label">{title}</span><span className="resource-menu">{isAdmin ? 'ADMIN' : '···'}</span></div><div className="resource-number">{item.available}<span> / {item.total}</span></div><div className="resource-caption">disponibles para hoy</div><div className="progress-track"><span style={{ width: `${percentage}%` }} /></div><div className="resource-stats"><span><i className="legend-dot available-dot" />Disponibles <strong>{item.available}</strong></span><span><i className="legend-dot reserved-dot" />Reservadas hoy <strong>{item.reserved}</strong></span><span><i className="legend-dot loaned-dot" />Prestadas hoy <strong>{item.loaned}</strong></span></div>{isAdmin && <div className="inventory-edit"><label>Unidades totales<input type="number" min={item.reserved + item.loaned} value={total} onChange={(event) => setTotal(Number(event.target.value))} /></label><button className="table-action" disabled={total === item.total} onClick={() => onRun(() => api(`/inventory/${item.resource}`, token, { method: 'PATCH', body: JSON.stringify({ total }) }), 'Inventario actualizado correctamente.')}>Guardar</button></div>}</article>;
}

function Metric({ label, value, icon, tone }) {
  return <article className="metric-card"><span className={`metric-icon ${tone}`}>{icon}</span><div><span className="metric-value">{value}</span><span className="metric-label">{label}</span></div><span className="metric-corner">↗</span></article>;
}

function Reservations({ dashboard, reservations, users, currentUser, busy, onRun, token, isAdmin, onDemoPayment, onShowInvoice, onReceiptEmail, onEmailReservation }) {
  const [tables, setTables] = useState(0);
  const [chairs, setChairs] = useState(0);
  const [date, setDate] = useState(localDate());
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('demo');
  const [customerId, setCustomerId] = useState(currentUser.id);
  const [dueDates, setDueDates] = useState({});
  const [availability, setAvailability] = useState(null);
  const [availabilityError, setAvailabilityError] = useState('');
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  useEffect(() => {
    if (!dashboard) return;
    if (Boolean(start) !== Boolean(end)) {
      setAvailability(null);
      setAvailabilityLoading(false);
      return;
    }
    const params = new URLSearchParams({ date });
    if (start && end) {
      params.set('startTime', start);
      params.set('endTime', end);
    }
    let current = true;
    setAvailability(null);
    setAvailabilityLoading(true);
    api(`/availability?${params}`, token)
      .then((result) => {
        if (current) {
          setAvailability(result.inventory);
          setAvailabilityError('');
        }
      })
      .catch((err) => {
        if (current) {
          setAvailability(null);
          setAvailabilityError(err.message);
        }
      })
      .finally(() => {
        if (current) setAvailabilityLoading(false);
      });
    return () => { current = false; };
  }, [dashboard, date, start, end, token]);
  const items = Object.fromEntries((availability || dashboard?.inventory || []).map((item) => [item.resource, item]));
  const rates = dashboard?.rates || { tables: 0, chairs: 0, currency: 'USD' };
  const total = tables * rates.tables + chairs * rates.chairs;
  const invalidHours = Boolean(start) !== Boolean(end) || Boolean(start && end && end <= start);
  const reserve = (event) => {
    event.preventDefault();
    onRun(async () => {
      const result = await api('/reservations', token, {
        method: 'POST',
        body: JSON.stringify({
          reservationDate: date, startTime: start || null, endTime: end || null,
          tables: Number(tables), chairs: Number(chairs), paymentMethod,
          ...(isAdmin ? { userId: customerId } : {}),
        }),
      });
      const { reservation } = result;
      if (paymentMethod === 'demo' && reservation.total_cents > 0) {
        const { attempt } = await api(`/reservations/${reservation.id}/demo-payment`, token, { method: 'POST', body: '{}' });
        onDemoPayment({ ...reservation, paymentAttemptId: attempt.id, contact_email: reservation.contact_email || currentUser.email });
      }
      return { reservationEmail: result.reservationEmail };
    }, paymentMethod === 'cash'
      ? 'Reserva guardada. El pago en efectivo queda pendiente de confirmación administrativa.'
      : total > 0 ? '' : 'Reserva registrada como pendiente.');
  };
  return <>
    <PageHeading eyebrow="PLANIFICA CON TIEMPO" title="Reservas" description="Elige los recursos que necesitas y consulta el estado de tus solicitudes." />
    <div className="booking-layout">
      <form className="panel booking-form" onSubmit={reserve}>
        <div className="panel-heading booking-heading"><div><h2>Solicitar una reserva</h2><p>Los recursos quedan apartados al enviar la solicitud.</p></div><div className="booking-heading-actions"><span className="demo-payment-brand" aria-label="Simulador local, no es PayPal"><span className="demo-payment-mark">P</span><span>PayPal<small>DEMO</small></span></span><span className="step-pill">01 / 01</span></div></div>
        <label>Fecha del evento<input type="date" required min={localDate()} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {isAdmin
          ? <label>Correo de la cuenta registrada<select required value={customerId} onChange={(event) => setCustomerId(event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</select></label>
          : <label>Correo de tu cuenta<input type="email" value={currentUser.email} readOnly /></label>}
        <div className="form-two"><label>Hora de inicio <span className="optional">opcional</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label><label>Hora de finalización <span className="optional">opcional</span><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label></div>
        {invalidHours && <p className="form-error">Completa ambas horas y asegúrate de que la finalización sea posterior al inicio.</p>}
        {availabilityError && <p className="form-error" role="alert">{availabilityError}</p>}
        <InventoryUnavailableNotice inventory={availability} />
        <div className="form-divider" />
        <div className="quantity-row"><div><span className="quantity-symbol mint">▤</span><span><strong>Mesas</strong><small>{items.tables?.available ?? 0} disponibles</small></span></div><QuantityControl label="Mesas" value={tables} max={items.tables?.available ?? 0} onChange={setTables} /></div>
        <div className="quantity-row"><div><span className="quantity-symbol lavender">▥</span><span><strong>Sillas</strong><small>{items.chairs?.available ?? 0} disponibles</small></span></div><QuantityControl label="Sillas" value={chairs} max={items.chairs?.available ?? 0} onChange={setChairs} /></div>
        <fieldset className="payment-choice"><legend>Forma de pago</legend>
          <label className={`payment-choice-card ${paymentMethod === 'demo' ? 'selected' : ''}`}><input type="radio" name="account-payment-method" value="demo" checked={paymentMethod === 'demo'} onChange={() => setPaymentMethod('demo')} /><span className="payment-choice-icon">P</span><span><strong>Pago de prueba</strong><small>No es PayPal ni cobra dinero real</small></span><span className="choice-indicator" /></label>
          <label className={`payment-choice-card ${paymentMethod === 'cash' ? 'selected' : ''}`}><input type="radio" name="account-payment-method" value="cash" checked={paymentMethod === 'cash'} onChange={() => setPaymentMethod('cash')} /><span className="payment-choice-icon cash-icon">$</span><span><strong>Efectivo</strong><small>Se confirma al recibirlo</small></span><span className="choice-indicator" /></label>
        </fieldset>
        {total > 0 && <div className="price-row"><span>Estimado por el día</span><strong>{money(total, rates.currency)}</strong></div>}
        <button className="button primary full" disabled={busy || availabilityLoading || Boolean(availabilityError) || invalidHours || !Number(tables) && !Number(chairs)}>{busy ? 'Procesando…' : availabilityLoading ? 'Consultando disponibilidad…' : paymentMethod === 'cash' ? 'Reservar y pagar en efectivo' : total > 0 ? 'Continuar a demostración de pago' : 'Confirmar solicitud'} <span>→</span></button>
        <p className="secure-note">{paymentMethod === 'cash' ? 'La reserva queda pendiente hasta que administración confirme la recepción del efectivo.' : 'Pago de prueba: no es PayPal ni realiza cobros reales.'}</p>
      </form>
      <aside className="panel availability-panel"><div className="panel-heading"><div><h2>Disponibilidad</h2><p>{dateLabel(date)}{start && end ? ` · ${start}–${end}` : ''}</p></div><span className="sync-label"><span className="live-dot" /> {availabilityLoading ? 'Consultando' : 'Actualizado'}</span></div><div className="availability-art"><img src="/venue.svg" alt="Ilustración de mesas y sillas" /></div><div className="availability-item"><span className="resource-icon mint">▤</span><span><strong>Mesas</strong><small>En inventario</small></span><strong>{availabilityLoading ? '—' : items.tables?.available ?? 0}<small> disponibles</small></strong></div><div className="availability-item"><span className="resource-icon lavender">▥</span><span><strong>Sillas</strong><small>En inventario</small></span><strong>{availabilityLoading ? '—' : items.chairs?.available ?? 0}<small> disponibles</small></strong></div><div className="availability-tip"><span>✳</span><p>La disponibilidad se calcula para la fecha y horario seleccionados. Puedes cancelar si el pago aún no se ha completado.</p></div></aside>
    </div>
    <section className="panel list-panel">
      <div className="panel-heading">
        <div><h2>{isAdmin ? 'Todas las reservas' : 'Tus reservas'}</h2><p>Consulta estados, pagos y próximas fechas</p></div>
        <span className="count-pill">{reservations.length} en total</span>
      </div>
      {reservations.length ? <div className="table-wrap">
        <table>
          <thead><tr>{isAdmin && <th>Responsable</th>}<th>Fecha</th><th>Recursos</th><th>Importe</th><th>Pago</th><th>Estado</th><th>Acción</th></tr></thead>
          <tbody>{reservations.map((reservation) => <tr key={reservation.id}>
            {isAdmin && <td><strong>{reservation.user_name || 'Reserva sin cuenta'}</strong><small className="cell-sub">{reservation.user_email}</small></td>}
            <td>{dateLabel(reservation.reservation_date)}</td>
            <td>{reservation.tables} mesas · {reservation.chairs} sillas</td>
            <td>{money(reservation.total_cents, dashboard?.rates.currency)}</td>
            <td><span className="payment-method-label">{reservation.payment_method === 'cash' ? 'Efectivo' : 'Pago de prueba'}</span><small className="cell-sub"><Status status={reservation.payment_status} /></small></td>
            <td><Status status={reservation.status} /></td>
            <td><div className="reservation-row-actions">
              <ReservationActions
                reservation={reservation}
                isAdmin={isAdmin}
                dueDate={dueDates[reservation.id] || ''}
                onDueDateChange={(value) => setDueDates({ ...dueDates, [reservation.id]: value })}
                token={token}
                onRun={onRun}
                onDemoPayment={onDemoPayment}
                onShowInvoice={onShowInvoice}
                onReceiptEmail={onReceiptEmail}
              />
              {reservation.payment_status === 'paid' && (isAdmin || reservation.user_id === currentUser.id)
                && <button className="table-action" onClick={() => onShowInvoice(reservation.id)}>Ver comprobante</button>}
              {reservation.payment_status === 'paid' && !reservation.receipt_email_sent_at
                ? <button className="table-action" disabled={busy} onClick={() => onEmailReservation(reservation.id, 'receipt')}>Enviar comprobante por correo</button>
                : !reservation.reservation_email_sent_at && <button className="table-action" disabled={busy} onClick={() => onEmailReservation(reservation.id, 'reservation')}>Enviar confirmación por correo</button>}
            </div></td>
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState text="Aún no tienes reservas. Solicita la primera cuando quieras." />}
    </section>
  </>;
}

function ReservationActions({ reservation, isAdmin, dueDate, onDueDateChange, token, onRun, onDemoPayment, onShowInvoice, onReceiptEmail }) {
  const cancel = () => {
    if (!window.confirm('¿Cancelar esta reserva? Los recursos volverán a estar disponibles.')) return;
    onRun(
      () => api(`/reservations/${reservation.id}/cancel`, token, { method: 'POST', body: '{}' }),
      'La reserva se canceló y los recursos están disponibles nuevamente.',
    );
  };
  if (isAdmin && reservation.payment_method === 'cash'
    && reservation.status === 'pending' && reservation.payment_status === 'pending') {
    return <button className="table-action" onClick={async () => {
      const confirmed = await onRun(
        async () => {
          const result = await api(`/reservations/${reservation.id}/cash-payment/confirm`, token, { method: 'POST', body: '{}' });
          return result;
        },
        'Pago en efectivo confirmado y registrado en el historial.',
      );
      if (confirmed && confirmed !== true) {
        onReceiptEmail(confirmed.receiptEmail);
        onShowInvoice(reservation.id);
      }
    }}>Confirmar efectivo</button>;
  }
  if (isAdmin && reservation.status === 'confirmed' && reservation.payment_status === 'paid') {
    return <div className="return-controls">
      <input
        aria-label="Fecha de devolución prevista"
        type="date"
        min={localDate()}
        value={dueDate}
        onChange={(event) => onDueDateChange(event.target.value)}
      />
      <button
        className="table-action"
        disabled={!dueDate || reservation.reservation_date > localDate()}
        title={reservation.reservation_date > localDate() ? 'Se puede registrar desde la fecha de la reserva.' : ''}
        onClick={() => onRun(
          () => api(`/loans/from-reservation/${reservation.id}`, token, {
            method: 'POST', body: JSON.stringify({ dueDate }),
          }),
          'Reserva convertida en préstamo.',
        )}
      >Prestar</button>
    </div>;
  }
  if (!['pending', 'confirmed'].includes(reservation.status) || reservation.payment_status === 'paid') return '—';
  if (!isAdmin && reservation.payment_status === 'pending' && reservation.payment_method === 'demo') {
    return <div className="action-stack">
      <button className="table-action" onClick={() => onRun(async () => {
        const { attempt } = await api(`/reservations/${reservation.id}/demo-payment`, token, {
          method: 'POST', body: '{}',
        });
        onDemoPayment({ ...reservation, paymentAttemptId: attempt.id });
      }, '')}>Probar pago</button>
      <button className="table-action cancel-action" onClick={cancel}>Cancelar</button>
    </div>;
  }
  if (!isAdmin && reservation.payment_method === 'cash'
    && reservation.status === 'pending' && reservation.payment_status === 'pending') {
    return <div className="action-stack"><span className="payment-pending-label">Esperando recepción de efectivo</span><button className="table-action cancel-action" onClick={cancel}>Cancelar</button></div>;
  }
  return <button className="table-action cancel-action" onClick={cancel}>Cancelar</button>;
}

function DemoCheckout({ reservation, currency, token, guestKey = null, onRun, onClose }) {
  const paymentPrefix = guestKey ? '/guest/payments/demo' : '/payments/demo';
  const keyHeaders = guestKey ? { 'X-Reservation-Key': guestKey } : undefined;
  return <div className="demo-backdrop">
    <section className="demo-checkout" role="dialog" aria-modal="true" aria-labelledby="demo-title">
      <div className="demo-brand"><span className="demo-brand-mark">M</span><span>MesaLista <strong>Pay</strong></span><span className="demo-lock">▣ Pago de prueba</span></div>
      <div className="demo-ribbon">SIMULACIÓN LOCAL <span>·</span> NO ES PAYPAL NI SE REALIZA UN COBRO</div>
      <div className="demo-body">
        <span className="eyebrow">RESERVA DE MOBILIARIO</span>
        <h2 id="demo-title">Revisa tu solicitud</h2>
        <p className="demo-description">Simulador propio de MesaLista. No es una página de PayPal ni un procesador de pagos; no introduzcas datos bancarios.</p>
        <div className="demo-summary">
          <span><strong>Mesas y sillas</strong><small>Reserva para el {dateLabel(reservation.reservation_date)}</small></span>
          <span className="demo-total">{money(reservation.total_cents, currency)}</span>
        </div>
        {reservation.contact_email && <div className="demo-account-email"><span>Correo de la reserva</span><strong>{reservation.contact_email}</strong></div>}
        <div className="demo-explainer"><span>ⓘ</span><p>Al simular la aprobación, la reserva quedará marcada como pagada <strong>solo dentro de esta base de datos de prueba</strong>. No se transferirá dinero.</p></div>
        <button className="button primary full demo-approve" onClick={() => onRun(async () => {
          const payment = await api(`${paymentPrefix}/complete`, token, {
            method: 'POST', body: JSON.stringify({ attemptId: reservation.paymentAttemptId }), headers: keyHeaders,
          });
          onClose(true, payment);
        }, '')}>Simular aprobación del pago <span>→</span></button>
        <button className="demo-cancel" onClick={() => onRun(async () => {
          await api(`${paymentPrefix}/cancel`, token, {
            method: 'POST', body: JSON.stringify({ attemptId: reservation.paymentAttemptId }), headers: keyHeaders,
          });
          onClose(false);
        }, 'La simulación se canceló. No se hizo ningún cobro.')}>Volver sin pagar</button>
        <p className="demo-disclaimer">Entorno de demostración. No se solicitan ni almacenan tarjetas, contraseñas o credenciales de pago.</p>
      </div>
    </section>
  </div>;
}

function InvoiceDocument({ reservation, currency, customerName, customerEmail, paidAt = reservation.paid_at, onClose, onEmailReceipt, receiptEmailBusy = false, receiptEmailError = '' }) {
  const paymentMethod = reservation.payment_method === 'cash'
    ? 'Efectivo confirmado por administración'
    : 'Pago de prueba simulado';
  return <div className="invoice-backdrop">
    <section className="invoice-document" role="dialog" aria-modal="true" aria-labelledby="invoice-title">
      <div className="invoice-actions">
        <span className="invoice-kicker">MESA<span>LISTA</span> · COMPROBANTE</span>
        <button className="invoice-close" type="button" aria-label="Cerrar comprobante" onClick={onClose}>×</button>
      </div>
      <div className="invoice-heading">
        <div><span className="eyebrow">PAGO CONFIRMADO</span><h2 id="invoice-title">Comprobante de pago</h2></div>
        <span className="invoice-check" aria-hidden="true">✓</span>
      </div>
      <div className="invoice-meta">
        <div><span>Folio</span><strong>ML-{String(reservation.id).slice(0, 8).toUpperCase()}</strong></div>
        <div><span>Fecha de pago</span><strong>{paidAt ? new Date(paidAt).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : 'Confirmado'}</strong></div>
      </div>
      <div className="invoice-customer">
        <span>RESPONSABLE</span><strong>{customerName || reservation.user_name || reservation.contact_name || 'Usuario'}</strong>
        <small>{customerEmail || reservation.user_email || reservation.contact_email || '—'}</small>
      </div>
      <div className="invoice-reservation">
        <div><span>Fecha del evento</span><strong>{dateLabel(reservation.reservation_date)}</strong></div>
        {reservation.start_time && <div><span>Horario</span><strong>{String(reservation.start_time).slice(0, 5)}{reservation.end_time ? `–${String(reservation.end_time).slice(0, 5)}` : ''}</strong></div>}
      </div>
      <div className="invoice-items">
        <div className="invoice-table-head"><span>Recurso</span><span>Cantidad</span></div>
        {Number(reservation.tables) > 0 && <div><span>Mesas</span><strong>{reservation.tables}</strong></div>}
        {Number(reservation.chairs) > 0 && <div><span>Sillas</span><strong>{reservation.chairs}</strong></div>}
      </div>
      <div className="invoice-total"><span>Total confirmado</span><strong>{money(reservation.total_cents, currency)}</strong></div>
      <div className="invoice-payment"><span>Método de pago</span><strong>{paymentMethod}</strong></div>
      <p className={reservation.receipt_email_sent_at ? 'invoice-email-status sent' : 'invoice-email-status'}>
        {reservation.receipt_email_sent_at
          ? `Copia enviada por correo a ${customerEmail || reservation.user_email || reservation.contact_email}.`
          : 'La copia por correo todavía no se ha enviado.'}
      </p>
      {receiptEmailError && <p className="form-error" role="alert">{receiptEmailError}</p>}
      <p className="invoice-disclaimer">Comprobante informativo; no sustituye una factura fiscal. {reservation.payment_method !== 'cash' && 'El pago de prueba no realizó ningún cobro real.'}</p>
      <div className="invoice-footer">
        <button className="button primary" type="button" onClick={() => window.print()}>Imprimir comprobante</button>
        {!reservation.receipt_email_sent_at && onEmailReceipt && <button className="table-action" type="button" disabled={receiptEmailBusy} onClick={onEmailReceipt}>
          {receiptEmailBusy ? 'Enviando…' : 'Enviar por correo'}
        </button>}
        <button className="text-button" type="button" onClick={onClose}>Cerrar</button>
      </div>
    </section>
  </div>;
}

function Loans({ loans, users, reservations, isAdmin, busy, onRun, token }) {
  const [form, setForm] = useState({ responsible: '', userId: null, borrowerName: '', borrowerEmail: '', dueDate: '', tables: 0, chairs: 0, observations: '' });
  const [returns, setReturns] = useState({});
  const [dueDates, setDueDates] = useState({});
  const registeredEmails = new Set(users.map((user) => user.email.toLowerCase()));
  const contacts = [
    ...users.map((user) => ({ key: `user:${user.id}`, userId: user.id, name: user.name, email: user.email })),
    ...reservations
      .filter((reservation) => reservation.user_email && !registeredEmails.has(reservation.user_email.toLowerCase()))
      .map((reservation) => ({
        key: `email:${reservation.user_email.toLowerCase()}`,
        userId: null,
        name: reservation.user_name || reservation.user_email.split('@')[0],
        email: reservation.user_email,
      })),
  ].filter((contact, index, all) => all.findIndex((item) => item.email.toLowerCase() === contact.email.toLowerCase()) === index);
  const createLoan = (event) => {
    event.preventDefault();
    onRun(async () => {
      await api('/loans', token, { method: 'POST', body: JSON.stringify({ ...form, tables: Number(form.tables), chairs: Number(form.chairs) }) });
      setForm({ responsible: '', userId: null, borrowerName: '', borrowerEmail: '', dueDate: '', tables: 0, chairs: 0, observations: '' });
    }, 'El préstamo se registró y el inventario fue actualizado.');
  };
  return <>
    <PageHeading eyebrow="SEGUIMIENTO DE RECURSOS" title="Préstamos" description={isAdmin ? 'Registra entregas y controla las devoluciones de cada recurso.' : 'Consulta tus préstamos y las fechas previstas de devolución.'} />
    {isAdmin && <form className="panel loan-create" onSubmit={createLoan}>
      <div className="panel-heading"><div><h2>Registrar préstamo</h2><p>Elige una cuenta o el correo registrado en una reserva.</p></div><span className="step-pill">ADMIN</span></div>
      <div className="loan-fields">
        <label>Responsable<select required value={form.responsible} onChange={(event) => {
          const contact = contacts.find((item) => item.key === event.target.value);
          setForm({ ...form, responsible: event.target.value, userId: contact?.userId || null, borrowerName: contact?.name || '', borrowerEmail: contact?.email || '' });
        }}><option value="">Selecciona una persona o correo</option>{contacts.map((contact) => <option key={contact.key} value={contact.key}>{contact.name} · {contact.email}</option>)}</select></label>
        <label>Devolución prevista<input required type="date" min={localDate()} value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} /></label>
        <label>Mesas<input type="number" min="0" value={form.tables} onChange={(event) => setForm({ ...form, tables: event.target.value })} /></label>
        <label>Sillas<input type="number" min="0" value={form.chairs} onChange={(event) => setForm({ ...form, chairs: event.target.value })} /></label>
        <label className="wide-field">Observaciones<input value={form.observations} onChange={(event) => setForm({ ...form, observations: event.target.value })} placeholder="Notas para la entrega (opcional)" /></label>
      </div>
      <button className="button primary" disabled={busy || !form.responsible || !form.tables && !form.chairs}>Registrar préstamo <span>→</span></button>
    </form>}
    <section className="panel list-panel"><div className="panel-heading"><div><h2>{isAdmin ? 'Todos los préstamos' : 'Tus préstamos'}</h2><p>El inventario se actualiza con cada devolución</p></div><span className="count-pill">{loans.length} registros</span></div>{loans.length ? <div className="table-wrap"><table><thead><tr><th>Responsable</th><th>Préstamo original</th><th>Devuelto</th><th>Devolución prevista</th><th>Pendiente</th><th>Estado</th>{isAdmin && <th>Registrar devolución</th>}</tr></thead><tbody>{loans.map((loan) => { const data = returns[loan.id] || { tables: 0, chairs: 0 }; return <tr key={loan.id}><td><strong>{loan.borrower_name}</strong><small className="cell-sub">{loan.user_email}</small></td><td>{loan.tables} mesas · {loan.chairs} sillas</td><td>{loan.tables_returned} mesas · {loan.chairs_returned} sillas</td><td>{dateLabel(loan.due_date)}</td><td>{loan.tables_pending} mesas · {loan.chairs_pending} sillas</td><td><Status status={loan.effective_status} /></td>{isAdmin && <td>{loan.effective_status !== 'returned' ? <div className="return-controls"><input aria-label="Mesas devueltas" type="number" min="0" max={loan.tables_pending} value={data.tables} onChange={(e) => setReturns({ ...returns, [loan.id]: { ...data, tables: Number(e.target.value) } })} /><input aria-label="Sillas devueltas" type="number" min="0" max={loan.chairs_pending} value={data.chairs} onChange={(e) => setReturns({ ...returns, [loan.id]: { ...data, chairs: Number(e.target.value) } })} /><button className="table-action" disabled={busy || !data.tables && !data.chairs} onClick={() => onRun(async () => { await api(`/loans/${loan.id}/returns`, token, { method: 'POST', body: JSON.stringify(data) }); setReturns((current) => ({ ...current, [loan.id]: { tables: 0, chairs: 0 } })); }, 'Devolución registrada. El inventario disponible ya fue actualizado.')}>Recibir</button></div> : 'Completo'}</td>}</tr>; })}</tbody></table></div> : <EmptyState text="No hay préstamos registrados por ahora." />}</section>
  </>;
}

function Employees({ employees, busy, onRun, token }) {
  const emptyForm = { name: '', position: '' };
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const activeEmployees = employees.filter((employee) => employee.active);
  const saveEmployee = async (event) => {
    event.preventDefault();
    const existingEmployee = employees.find((employee) => employee.id === editingId);
    const payload = {
      name: form.name.trim(),
      position: form.position.trim(),
      weeklySalaryCents: Number(existingEmployee?.weekly_salary_cents) || 0,
      regularHoursPerDay: Number(existingEmployee?.regular_hours_per_day) || 8,
      overtimeMultiplier: Number(existingEmployee?.overtime_multiplier) || 1.5,
      ...(editingId ? { active: existingEmployee?.active ?? true } : {}),
    };
    const path = editingId ? `/employees/${editingId}` : '/employees';
    const result = await onRun(
      () => api(path, token, {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      }),
      editingId ? 'Trabajador actualizado.' : 'Trabajador agregado.',
    );
    if (result && result !== true) {
      setForm(emptyForm);
      setEditingId(null);
    }
  };
  const startEditing = (employee) => {
    setEditingId(employee.id);
    setForm({
      name: employee.name,
      position: employee.position,
    });
  };
  const setActive = (employee, active) => onRun(
    () => api(`/employees/${employee.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        name: employee.name,
        position: employee.position,
        weeklySalaryCents: Number(employee.weekly_salary_cents),
        regularHoursPerDay: Number(employee.regular_hours_per_day),
        overtimeMultiplier: Number(employee.overtime_multiplier),
        active,
      }),
    }),
    active ? 'Trabajador reactivado.' : 'Trabajador archivado.',
  );

  return <>
    <PageHeading
      eyebrow="ADMINISTRACIÓN"
      title="Trabajadores"
      description="Agrega y administra las personas que forman parte de tu equipo."
    />
    <form className="panel employee-form" onSubmit={saveEmployee}>
      <div className="panel-heading"><div><h2>{editingId ? 'Editar trabajador' : 'Agregar trabajador'}</h2><p>Los datos de salario se configuran aparte, en la pestaña Salarios.</p></div><span className="step-pill">ADMIN</span></div>
      <div className="employee-fields">
        <label>Nombre completo<input required maxLength="120" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Puesto o función <span className="optional">opcional</span><input maxLength="120" value={form.position} onChange={(event) => setForm({ ...form, position: event.target.value })} /></label>
      </div>
      <div className="employee-form-actions">
        <button className="button primary" disabled={busy || !form.name.trim()}>{editingId ? 'Guardar cambios' : 'Agregar trabajador'} <span>→</span></button>
        {editingId && <button className="text-button" type="button" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancelar edición</button>}
      </div>
    </form>

    <section className="panel list-panel">
      <div className="panel-heading"><div><h2>Lista de trabajadores</h2><p>Administra nombres, puestos y estado del personal.</p></div><span className="count-pill">{activeEmployees.length} activos</span></div>
      {employees.length ? <div className="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>Puesto</th><th>Estado</th><th>Acciones</th></tr></thead>
        <tbody>{employees.map((employee) => <tr key={employee.id}>
          <td><strong>{employee.name}</strong></td>
          <td>{employee.position || '—'}</td>
          <td><span className={`employee-state ${employee.active ? 'active' : 'archived'}`}>{employee.active ? 'Activo' : 'Archivado'}</span></td>
          <td><div className="employee-row-actions">
            <button className="table-action" type="button" onClick={() => startEditing(employee)}>Editar</button>
            <button className="table-action" type="button" onClick={() => setActive(employee, !employee.active)}>{employee.active ? 'Archivar' : 'Reactivar'}</button>
          </div></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState text="Todavía no hay trabajadores. Agrégalos en el formulario de arriba." />}
    </section>
  </>;
}

function Salaries({ employees, busy, onRun, token }) {
  const activeEmployees = employees.filter((employee) => employee.active);
  const [salaryDrafts, setSalaryDrafts] = useState({});
  useEffect(() => {
    setSalaryDrafts((current) => Object.fromEntries(activeEmployees.map((employee) => [
      employee.id,
      {
        weeklySalary: (Number(employee.weekly_salary_cents) / 100).toFixed(2),
        regularHoursPerDay: String(Number(employee.regular_hours_per_day)),
        overtimeMultiplier: String(Number(employee.overtime_multiplier)),
        overtimeHours: current[employee.id]?.overtimeHours || '0',
      },
    ])));
  }, [employees]);
  const updateDraft = (employeeId, field, value) => {
    setSalaryDrafts((current) => ({
      ...current,
      [employeeId]: { ...current[employeeId], [field]: value },
    }));
  };
  const saveSalary = (employee) => {
    const draft = salaryDrafts[employee.id];
    const weeklySalary = Number(draft?.weeklySalary);
    const regularHoursPerDay = Number(draft?.regularHoursPerDay);
    const overtimeMultiplier = Number(draft?.overtimeMultiplier);
    if (!Number.isFinite(weeklySalary) || weeklySalary < 0
      || !Number.isFinite(regularHoursPerDay) || regularHoursPerDay <= 0 || regularHoursPerDay > 24
      || !Number.isFinite(overtimeMultiplier) || overtimeMultiplier < 1 || overtimeMultiplier > 5) {
      return;
    }
    return onRun(
      () => api(`/employees/${employee.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({
          name: employee.name,
          position: employee.position,
          weeklySalaryCents: Math.round(weeklySalary * 100),
          regularHoursPerDay,
          overtimeMultiplier,
          active: employee.active,
        }),
      }),
      `Salario de ${employee.name} actualizado.`,
    );
  };
  const salaryEstimate = (employee, draft) => {
    const weeklySalaryCents = Math.round((Number(draft?.weeklySalary) || 0) * 100);
    const regularWeeklyHours = Number(draft?.regularHoursPerDay) * 5;
    const regularHourlyCents = regularWeeklyHours > 0 ? weeklySalaryCents / regularWeeklyHours : 0;
    const overtimeHours = Math.min(80, Math.max(0, Number(draft?.overtimeHours) || 0));
    const overtimePayCents = Math.round(regularHourlyCents * Number(draft?.overtimeMultiplier) * overtimeHours);
    return { weeklySalaryCents, overtimePayCents, totalCents: weeklySalaryCents + overtimePayCents };
  };

  return <>
    <PageHeading
      eyebrow="ADMINISTRACIÓN"
      title="Salarios"
      description="Configura el pago de cinco días y calcula aparte cuánto correspondería por horas extra."
    />
    <section className="panel list-panel">
      <div className="panel-heading"><div><h2>Configuración y estimación salarial</h2><p>Guarda el salario semanal, las horas normales y el multiplicador de cada trabajador.</p></div><span className="count-pill">USD · 5 días</span></div>
      {activeEmployees.length ? <div className="table-wrap"><table>
        <thead><tr><th>Trabajador</th><th>Salario base semanal</th><th>Horas normales/día</th><th>Multiplicador extra</th><th>Horas extra a calcular</th><th>Pago extra estimado</th><th>Total estimado</th><th>Acción</th></tr></thead>
        <tbody>{activeEmployees.map((employee) => {
          const draft = salaryDrafts[employee.id] || {
            weeklySalary: (Number(employee.weekly_salary_cents) / 100).toFixed(2),
            regularHoursPerDay: String(Number(employee.regular_hours_per_day)),
            overtimeMultiplier: String(Number(employee.overtime_multiplier)),
            overtimeHours: '0',
          };
          const estimate = salaryEstimate(employee, draft);
          return <tr key={employee.id}>
            <td><strong>{employee.name}</strong><small className="cell-sub">{employee.position || 'Trabajador'}</small></td>
            <td><label className="salary-input"><span>US$</span><input aria-label={`Salario semanal de ${employee.name}`} type="number" min="0" max="10000000" step="0.01" value={draft.weeklySalary} onChange={(event) => updateDraft(employee.id, 'weeklySalary', event.target.value)} /></label></td>
            <td><label className="salary-input"><input aria-label={`Horas normales diarias de ${employee.name}`} type="number" min="0.25" max="24" step="0.25" value={draft.regularHoursPerDay} onChange={(event) => updateDraft(employee.id, 'regularHoursPerDay', event.target.value)} /><span>h</span></label></td>
            <td><label className="salary-input"><input aria-label={`Multiplicador de hora extra de ${employee.name}`} type="number" min="1" max="5" step="0.05" value={draft.overtimeMultiplier} onChange={(event) => updateDraft(employee.id, 'overtimeMultiplier', event.target.value)} /><span>×</span></label></td>
            <td><label className="salary-input"><input aria-label={`Horas extra a calcular para ${employee.name}`} type="number" min="0" max="80" step="0.25" value={draft.overtimeHours} onChange={(event) => updateDraft(employee.id, 'overtimeHours', event.target.value)} /><span>h</span></label></td>
            <td>{money(estimate.overtimePayCents, 'USD')}</td>
            <td><strong>{money(estimate.totalCents, 'USD')}</strong></td>
            <td><button className="table-action" type="button" disabled={busy} onClick={() => saveSalary(employee)}>Guardar salario</button></td>
          </tr>;
        })}</tbody>
      </table></div> : <EmptyState text="Agrega y activa trabajadores en la pestaña Trabajadores para configurar sus salarios." />}
      <p className="employee-disclaimer">Cálculo: salario semanal ÷ (5 × horas normales al día) × multiplicador × horas extra. La estimación no registra pagos ni asistencia y no sustituye la nómina o las reglas laborales aplicables.</p>
    </section>
  </>;
}

function History({ movements, users, onRun, token, onRefresh }) {
  const operationNames = {
    reservation: 'Reserva',
    reservation_cancelled: 'Cancelación',
    loan: 'Préstamo',
    return: 'Devolución',
    partial_return: 'Devolución parcial',
    inventory_adjustment: 'Ajuste de inventario',
    reservation_payment_confirmed: 'Pago confirmado',
    demo_payment_started: 'Pago de prueba iniciado',
    demo_payment_completed: 'Pago de prueba aprobado',
    demo_payment_cancelled: 'Pago de prueba cancelado',
    cash_payment_confirmed: 'Efectivo recibido',
    reservation_to_loan: 'Reserva a préstamo',
  };
  const formatState = (state = {}) => {
    const labels = { total: 'total', available: 'disponibles', status: 'estado', payment_status: 'pago', loan_status: 'préstamo', amount_cents: 'importe (centavos)', currency: 'moneda' };
    const entries = Object.entries(state);
    return entries.length
      ? entries.map(([key, value]) => `${labels[key] || key}: ${value ?? '—'}`).join(' · ')
      : '—';
  };
  return <>
    <PageHeading eyebrow="TRAZABILIDAD COMPLETA" title="Historial de movimientos" description="Cada operación registra quién la hizo, cuándo ocurrió y cómo cambió el inventario." />
    <section className="panel list-panel">
      <div className="panel-heading">
        <div><h2>Actividad reciente</h2><p>Actualización automática cada 8 segundos · Últimos 200 movimientos</p></div>
      <div className="history-actions"><span className="count-pill">{movements.length} registros</span><button className="table-action" onClick={() => onRun(onRefresh)}>Actualizar</button></div>
      </div>
      {movements.length ? <div className="table-wrap"><table>
        <thead><tr><th>Fecha y hora</th><th>Operación</th><th>Recurso</th><th>Cantidad</th><th>Realizado por</th><th>Estado anterior</th><th>Estado posterior</th></tr></thead>
        <tbody>{movements.map((item) => <tr key={item.id}>
          <td>{new Date(item.created_at).toLocaleString('es')}</td>
          <td><strong>{operationNames[item.operation] || item.operation}</strong></td>
          <td>{item.resource === 'tables' ? 'Mesas' : item.resource === 'chairs' ? 'Sillas' : '—'}</td>
          <td>{item.quantity}</td>
          <td>{item.actor_name || 'Sistema'}</td>
          <td className="history-state">{formatState(item.previous_state)}</td>
          <td className="history-state">{formatState(item.new_state)}</td>
        </tr>)}</tbody>
      </table></div> : <EmptyState text="No hay movimientos registrados todavía. Las reservas, los pagos de prueba, préstamos, devoluciones y ajustes aparecerán aquí." />}
    </section>
    <section className="panel list-panel">
      <div className="panel-heading"><div><h2>Usuarios y permisos</h2><p>Administra las cuentas registradas</p></div><span className="count-pill">{users.length} usuarios</span></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>Correo</th><th>Cuenta creada</th><th>Rol</th></tr></thead>
        <tbody>{users.map((user) => <tr key={user.id}>
          <td>{user.name}</td><td>{user.email}</td><td>{dateLabel(user.created_at)}</td>
          <td><select className="role-select" aria-label={`Rol para ${user.name}`} value={user.role} onChange={(event) => onRun(() => api(`/users/${user.id}/role`, token, { method: 'PATCH', body: JSON.stringify({ role: event.target.value }) }), 'Permisos actualizados.')}><option value="user">Usuario</option><option value="admin">Administrador</option></select></td>
        </tr>)}</tbody>
      </table></div>
    </section>
  </>;
}

function Status({ status }) {
  const key = status || 'pending';
  return <span className={`status status-${key}`}>{statusNames[key] || key}</span>;
}

function EmptyState({ text }) {
  return <div className="empty-state"><span>▧</span><p>{text}</p></div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
