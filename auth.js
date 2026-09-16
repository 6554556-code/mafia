// auth.js — вход/регистрация на встроенных инструментах Node.
// Ноль сторонних пакетов: node:sqlite (база) + crypto (пароли, токены).
// Вся возня с базой и паролями живёт здесь; движок игры этого не касается.

const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const path = require("path");

// База — простой файл рядом с игрой. Создастся сам при первом запуске.
const db = new DatabaseSync(path.join(__dirname, "mafia.db"));

// Таблицы: пользователи и их сессии. IF NOT EXISTS — безопасно при каждом старте.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    pass       TEXT NOT NULL,
    name       TEXT NOT NULL,
    name_lower TEXT UNIQUE NOT NULL,
    created    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
`);

// ── Пароли: scrypt + случайная соль. В базе только хэш, никогда не сам пароль. ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(test, "hex");
  // сравнение, устойчивое к тайминг-атакам
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Нормализация и простая валидация ──
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
// Игровой ник: 2–16 символов — буквы любого языка, цифры, пробел, дефис, подчёркивание.
function validName(n) { return /^[\p{L}\p{N} _-]{2,16}$/u.test(n); }

// ── Регистрация: заводит пользователя и сразу открывает сессию ──
function register(email, password, name) {
  email = normEmail(email);
  name = String(name || "").trim();
  password = String(password || "");
  if (!validEmail(email)) return { error: "Некорректная почта" };
  if (password.length < 6)  return { error: "Пароль минимум 6 символов" };
  if (!validName(name))     return { error: "Ник: 2–16 символов — буквы, цифры, пробел, дефис или подчёркивание" };

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return { error: "Такая почта уже зарегистрирована" };
  const nameLower = name.toLowerCase();
  const nameTaken = db.prepare("SELECT id FROM users WHERE name_lower = ?").get(nameLower);
  if (nameTaken) return { error: "Этот ник уже занят" };

  const info = db.prepare(
    "INSERT INTO users (email, pass, name, name_lower, created) VALUES (?, ?, ?, ?, ?)"
  ).run(email, hashPassword(password), name, nameLower, Date.now());

  return startSession(info.lastInsertRowid);
}

// ── Вход ──
function login(email, password) {
  email = normEmail(email);
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  // одинаковый ответ на «нет почты» и «неверный пароль» — не подсказываем, что есть в базе
  if (!u || !verifyPassword(String(password || ""), u.pass)) {
    return { error: "Неверная почта или пароль" };
  }
  return startSession(u.id);
}

// ── Сессии (в базе — переживают перезапуск сервера) ──
function startSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)")
    .run(token, userId, Date.now());
  const user = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(userId);
  return { token, user };
}
function logout(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
function userByToken(token) {
  if (!token) return null;
  const s = db.prepare("SELECT user_id FROM sessions WHERE token = ?").get(token);
  if (!s) return null;
  return db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(s.user_id) || null;
}

// ── Достаём токен сессии из cookie входящего запроса ──
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function tokenFromReq(req) { return parseCookies(req).sid || null; }

module.exports = { register, login, logout, userByToken, tokenFromReq };
