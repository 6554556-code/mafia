// auth.js — вход/регистрация на встроенных инструментах Node.
// Ноль сторонних пакетов: node:sqlite (база) + crypto (пароли, токены).
// Вся возня с базой и паролями живёт здесь; движок игры этого не касается.

const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const path = require("path");

// База — простой файл рядом с игрой. Создастся сам при первом запуске.
const db = new DatabaseSync(path.join(__dirname, "mafia.db"));
const fs = require("fs");
const AVA_DIR = path.join(__dirname, "public", "avatars");

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

// Миграция: колонка avatar. База НЕ пересоздаётся — ALTER тихо игнорится, если колонка уже есть.
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT"); } catch (_) {}
// Миграция: «о себе» (возраст / кто по жизни / увлечения). Всё необязательно, пустое = NULL.
for (const col of ["bio_age INTEGER", "bio_job TEXT", "bio_hobby TEXT"]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (_) {}
}
// Какие поля пользователя отдаём наружу (пароль и прочее — никогда)
const USER_COLS = "id, email, name, avatar, bio_age, bio_job, bio_hobby";

// Список .png в папке avatars/<sub>, в виде "<sub>/файл.png"
function listDir(sub) {
  try { return fs.readdirSync(path.join(AVA_DIR, sub)).filter((f) => /\.png$/i.test(f)).map((f) => sub + "/" + f).sort(); }
  catch (_) { return []; }
}
function randomNeutral() {
  const list = listDir("neutral");
  return list.length ? list[(Math.random() * list.length) | 0] : null;
}
// Разовая раздача случайного нейтрального лица тем, у кого его ещё нет (аккаунты до этой фичи)
try {
  for (const u of db.prepare("SELECT id FROM users WHERE avatar IS NULL").all()) {
    const a = randomNeutral(); if (a) db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(a, u.id);
  }
} catch (_) {}

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
    "INSERT INTO users (email, pass, name, name_lower, avatar, created) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(email, hashPassword(password), name, nameLower, randomNeutral(), Date.now());

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
  const user = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId);
  return { token, user };
}
function logout(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
function userByToken(token) {
  if (!token) return null;
  const s = db.prepare("SELECT user_id FROM sessions WHERE token = ?").get(token);
  if (!s) return null;
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(s.user_id) || null;
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

// ── Смена ника (те же правила, что при регистрации: длина, набор, уникальность) ──
function rename(userId, newName) {
  newName = String(newName || "").trim();
  if (!validName(newName)) return { error: "Ник: 2–16 символов — буквы, цифры, пробел, дефис или подчёркивание" };
  const newLower = newName.toLowerCase();
  const taken = db.prepare("SELECT id FROM users WHERE name_lower = ? AND id != ?").get(newLower, userId);
  if (taken) return { error: "Этот ник уже занят" };
  db.prepare("UPDATE users SET name = ?, name_lower = ? WHERE id = ?").run(newName, newLower, userId);
  return { user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId) };
}

// ── Аватары ──
// Сохранить выбор лица. Пускаем только male/female/neutral (не characters),
// только простое имя файла (без слешей и «..») и только если файл реально есть.
function setAvatar(userId, file) {
  file = String(file || "");
  if (!/^(male|female|neutral)\/[A-Za-z0-9_.-]+\.png$/.test(file)) return { error: "Недопустимое лицо" };
  if (!fs.existsSync(path.join(AVA_DIR, file))) return { error: "Такого лица нет" };
  db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(file, userId);
  return { user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId) };
}
// ── «О себе»: три необязательных поля ──
// Текст попадает в промпт ИИ, поэтому чистим строго: одна строка, без служебных символов,
// без скобок/кавычек (ими можно «закрыть» досье и дописать свои указания), до 40 символов.
function cleanBio(v) {
  return String(v ?? "").replace(/[\p{C}<>{}\[\]`"«»\\]/gu, " ").replace(/\s+/g, " ").trim();
}
function setBio(userId, bio) {
  bio = bio || {};
  let age = String(bio.age ?? "").trim();
  if (age === "") age = null;
  else {
    if (!/^\d{1,2}$/.test(age) || +age < 10 || +age > 99) return { error: "Возраст — число от 10 до 99 (или оставь пустым)" };
    age = +age;
  }
  const job = cleanBio(bio.job), hobby = cleanBio(bio.hobby);
  if (job.length > 40 || hobby.length > 40) return { error: "Не больше 40 символов в поле" };
  db.prepare("UPDATE users SET bio_age = ?, bio_job = ?, bio_hobby = ? WHERE id = ?")
    .run(age, job || null, hobby || null, userId);
  return { user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId) };
}

// Лица для сетки выбора: две группы — мужские и женские (свободные, без ИИшных из characters)
function listAvatars() { return { male: listDir("male"), female: listDir("female") }; }

module.exports = { register, login, logout, userByToken, tokenFromReq, rename, setAvatar, listAvatars, setBio };
