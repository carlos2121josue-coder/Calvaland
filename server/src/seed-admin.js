import 'dotenv/config';
import { pool } from './db.js';
import { hashPassword } from './auth.js';

const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!ADMIN_NAME || !ADMIN_EMAIL || ADMIN_EMAIL.toLowerCase() === 'admin@example.com'
  || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12 || /^CHANGE_THIS/i.test(ADMIN_PASSWORD)) {
  throw new Error('Configura ADMIN_NAME, ADMIN_EMAIL y ADMIN_PASSWORD (mínimo 12 caracteres) en .env.');
}

try {
  const hash = await hashPassword(ADMIN_PASSWORD);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, LOWER($2), $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = 'admin'`,
    [ADMIN_NAME, ADMIN_EMAIL, hash],
  );
  console.log(`Administrador listo: ${ADMIN_EMAIL}`);
} finally {
  await pool.end();
}
