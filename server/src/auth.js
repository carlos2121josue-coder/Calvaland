import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';

const secret = () => {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32
    || /^(CHANGE_THIS|replace-with)/i.test(process.env.JWT_SECRET)) {
    throw new Error('Configura JWT_SECRET con al menos 32 caracteres.');
  }
  return process.env.JWT_SECRET;
};

export const hashPassword = (password) => bcrypt.hash(password, 12);
export const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

export function createToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, secret(), { expiresIn: '12h' });
}

export async function authenticate(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  let claims;
  try {
    claims = jwt.verify(token, secret());
  } catch {
    return res.status(401).json({ error: 'La sesión expiró o no es válida.' });
  }
  try {
    const result = await pool.query('SELECT id, role FROM users WHERE id = $1', [claims.sub]);
    if (!result.rows[0]) return res.status(401).json({ error: 'La cuenta ya no existe.' });
    req.auth = { ...claims, sub: result.rows[0].id, role: result.rows[0].role };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') return res.status(403).json({ error: 'Esta acción requiere permisos de administrador.' });
  next();
}
