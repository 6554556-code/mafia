// auth.js — вход/регистрация на встроенных инструментах Node.
// Ноль сторонних пакетов: node:sqlite (база) + crypto (пароли, токены).
// Вся возня с базой и паролями живёт здесь; движок игры этого не касается.

const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const path = require("path");

// База — простой файл рядом с игрой. Создастся сам при первом запуске.
const db = new DatabaseSync(path.join(__dirname, "mafia.db"));
// база общая с журналом и командой vip.js: если кто-то прямо сейчас пишет — подождать до 3 с, а не падать
db.exec("PRAGMA busy_timeout = 3000");
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
// Миграция: VIP. vip_until = до какого момента действует (метка времени в мс); NULL = бесплатный.
try { db.exec("ALTER TABLE users ADD COLUMN vip_until INTEGER"); } catch (_) {}
// Миграция: щиты. shields — купленные (не сгорают); shield_gift — день (МСК), когда уже взят подарочный щит.
try { db.exec("ALTER TABLE users ADD COLUMN shields INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN shield_gift TEXT"); } catch (_) {}
// Миграция: почта и согласия.
//   email_ok   — 1 = почта подтверждена (по ссылке из письма или входом с паролем из письма)
//   pd_consent — когда дано согласие на обработку персональных данных (метка времени); у старых игроков NULL
//   news       — 1 = согласие на новости и акции (рассылки); снимается в настройках
//   temp_pass / temp_until — запасной пароль из письма «Забыли пароль?»: старый при этом продолжает работать
for (const col of ["email_ok INTEGER NOT NULL DEFAULT 0", "pd_consent INTEGER", "news INTEGER NOT NULL DEFAULT 0", "temp_pass TEXT", "temp_until INTEGER"]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (_) {}
}
// Ключи из писем «подтверди почту». В базе — только отпечаток ключа, сам ключ живёт лишь в письме.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_tokens (
    hash    TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
`);
// Какие поля пользователя отдаём наружу (пароль и прочее — никогда)
const USER_COLS = "id, email, name, avatar, bio_age, bio_job, bio_hobby, vip_until, email_ok, news";

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
// Почты-однодневки: на них не подтвердить аккаунт всерьёз — регистрацию с ними не принимаем
const DISPOSABLE = new Set(("temp-mail.org temp-mail.io tempmail.com tempmail.net tempmail.plus tempmailo.com tempr.email 10minutemail.com 10minutemail.net "
  + "10minemail.com guerrillamail.com guerrillamail.net guerrillamail.org guerrillamailblock.com sharklasers.com grr.la pokemail.net spam4.me "
  + "mailinator.com mailinator.net maildrop.cc yopmail.com yopmail.net yopmail.fr cool.fr.nf jetable.fr.nf nospam.ze.tc nomail.xl.cx mega.zik.dj "
  + "throwawaymail.com trashmail.com trashmail.de trashmail.net getnada.com nada.email dispostable.com mailnesia.com mohmal.com emailondeck.com "
  + "fakeinbox.com fakemail.net mintemail.com mytemp.email tempail.com tempmailaddress.com burnermail.io inboxkitten.com mailpoof.com "
  + "dropmail.me 1secmail.com 1secmail.net 1secmail.org esiix.com wwjmp.com xojxe.com yoggm.com emltmp.com spymail.one minuteinbox.com "
  + "crazymailing.com tmail.ws tmpmail.org tmpmail.net mail.tm mailto.plus fexpost.com fexbox.org rover.info firemail.cc "
  + "linshiyouxiang.net 33mail.com anonaddy.me harakirimail.com mailcatch.com discard.email emailfake.com generator.email "
  + "tempmail.dev vusra.com tempm.com").split(/\s+/));
const isDisposable = (email) => DISPOSABLE.has(String(email).split("@")[1] || "");
// Игровой ник: 2–16 символов — буквы любого языка, цифры, пробел, дефис, подчёркивание.
function validName(n) { return /^[\p{L}\p{N} _-]{2,16}$/u.test(n); }

// ── Регистрация: заводит пользователя и сразу открывает сессию ──
function register(email, password, name, consent = {}) {
  email = normEmail(email);
  name = String(name || "").trim();
  password = String(password || "");
  if (!validEmail(email)) return { error: "Некорректная почта" };
  if (isDisposable(email)) return { error: "Временные почты не подходят — укажи свою настоящую: на неё придёт письмо" };
  if (!consent.pd) return { error: "Нужно согласие на обработку персональных данных" };
  if (password.length < 6)  return { error: "Пароль минимум 6 символов" };
  if (!validName(name))     return { error: "Ник: 2–16 символов — буквы, цифры, пробел, дефис или подчёркивание" };

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return { error: "Такая почта уже зарегистрирована" };
  const nameLower = name.toLowerCase();
  const nameTaken = db.prepare("SELECT id FROM users WHERE name_lower = ?").get(nameLower);
  if (nameTaken) return { error: "Этот ник уже занят" };

  const info = db.prepare(
    "INSERT INTO users (email, pass, name, name_lower, avatar, created, pd_consent, news) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(email, hashPassword(password), name, nameLower, randomNeutral(), Date.now(), Date.now(), consent.news ? 1 : 0);

  return startSession(info.lastInsertRowid);
}

// ── Вход ──
// allowTemp=false — запасной пароль из письма не проверяем (на эту почту уже было слишком много неверных попыток)
function login(email, password, allowTemp = true) {
  email = normEmail(email);
  password = String(password || "");
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  // одинаковый ответ на «нет почты» и «неверный пароль» — не подсказываем, что есть в базе
  if (!u) return { error: "Неверная почта или пароль" };
  if (verifyPassword(password, u.pass)) return startSession(u.id);
  // запасной пароль из письма: вошёл с ним — он становится основным, а почта считается подтверждённой (письмо-то дошло)
  if (allowTemp && u.temp_pass && u.temp_until > Date.now() && verifyPassword(password, u.temp_pass)) {
    db.prepare("UPDATE users SET pass = temp_pass, temp_pass = NULL, temp_until = NULL, email_ok = 1 WHERE id = ?").run(u.id);
    return { ...startSession(u.id), fromTemp: true };
  }
  return { error: "Неверная почта или пароль" };
}

// ── «Забыли пароль?»: придумываем запоминающийся пароль и кладём его ЗАПАСНЫМ на 24 часа.
//    Старый пароль продолжает работать — чужак, вписавший твою почту, ничего не сломает.
const PW_ADJ = ("Lucky Sleepy Sneaky Brave Blonde Silent Crafty Wild Shady Golden Midnight Cunning Lazy Grumpy Jolly Rusty Smooth Velvet "
  + "Crazy Fancy Tricky Happy Dizzy Hungry Loyal Secret Clever Funky Spicy Fluffy Witty Bold Rich Noble Cool Silly Sweet Sly Sharp Tipsy "
  + "Dapper Sassy Cheeky Mighty Royal Cosmic Sunny Stormy Frosty Neon").split(" ");
const PW_NOUN = ("Don Cop Boss Doctor Alibi Witness Godfather Sheriff Gangster Detective Mafioso Hustler Bandit Rose Cigar Whisper "
  + "Casino Diamond Shadow Tommy Vinnie Joker Ace Queen Fedora Martini Jazz Kitty Raven Fox Wolf Panther Tiger Bunny Pirate Ninja "
  + "Judge Rascal Baron Duchess Lady Hobo Moon Poker Saxophone Cadillac Croupier Spy").split(" ");
const pick = (a) => a[crypto.randomInt(a.length)];
function funPassword() {
  const n = String(crypto.randomInt(10, 100));
  return crypto.randomInt(6) === 0 ? `ILove${pick(PW_NOUN)}${n}` : `${pick(PW_ADJ)}${pick(PW_NOUN)}${n}`;
}
const TEMP_MS = 24 * 3600e3;
function issueTempPassword(email) {
  email = normEmail(email);
  const u = db.prepare("SELECT id, email, name FROM users WHERE email = ?").get(email);
  if (!u) return null;                                   // наружу всё равно отвечаем одинаково
  const password = funPassword();
  db.prepare("UPDATE users SET temp_pass = ?, temp_until = ? WHERE id = ?").run(hashPassword(password), Date.now() + TEMP_MS, u.id);
  return { user: u, password };
}

// ── Смена пароля в настройках: нужен текущий (или запасной из письма). Остальные входы на других устройствах закрываем. ──
function changePassword(userId, oldPass, newPass, keepToken) {
  oldPass = String(oldPass || ""); newPass = String(newPass || "");
  const u = db.prepare("SELECT pass, temp_pass, temp_until FROM users WHERE id = ?").get(userId);
  if (!u) return { error: "Нет такого игрока" };
  const okOld = verifyPassword(oldPass, u.pass) || (u.temp_pass && u.temp_until > Date.now() && verifyPassword(oldPass, u.temp_pass));
  if (!okOld) return { error: "Текущий пароль не подходит" };
  if (newPass.length < 6) return { error: "Новый пароль — минимум 6 символов" };
  db.prepare("UPDATE users SET pass = ?, temp_pass = NULL, temp_until = NULL WHERE id = ?").run(hashPassword(newPass), userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, String(keepToken || ""));
  return { ok: true };
}

// ── Подтверждение почты: одноразовый ключ на 7 дней, в базе только его отпечаток ──
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
function makeVerifyToken(userId) {
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare("DELETE FROM email_tokens WHERE user_id = ? OR expires < ?").run(userId, Date.now());   // старые ссылки этого игрока гаснут
  db.prepare("INSERT INTO email_tokens (hash, user_id, created, expires) VALUES (?, ?, ?, ?)").run(sha(token), userId, Date.now(), Date.now() + 7 * 24 * 3600e3);
  return token;
}
function confirmEmail(token) {
  const row = db.prepare("SELECT user_id, expires FROM email_tokens WHERE hash = ?").get(sha(token));
  if (!row || row.expires < Date.now()) return { error: "Ссылка устарела или уже использована" };
  db.prepare("UPDATE users SET email_ok = 1 WHERE id = ?").run(row.user_id);
  db.prepare("DELETE FROM email_tokens WHERE user_id = ?").run(row.user_id);
  return { userId: row.user_id };
}
function setNews(userId, on) {
  db.prepare("UPDATE users SET news = ? WHERE id = ?").run(on ? 1 : 0, userId);
  return { user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId) };
}
function userById(id) { return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) || null; }

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
    if (!/^\d{1,2}$/.test(age) || +age < 18 || +age > 99) return { error: "Возраст — число от 18 до 99 (или оставь пустым): игра 18+" };
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

// ── VIP ──
// Действует, пока vip_until в будущем. Выдаётся командой на сервере (vip.js), позже — оплатой.
function isVip(u) { return !!(u && u.vip_until && u.vip_until > Date.now()); }
const DAY = 24 * 3600 * 1000;
// Добавить дней: если VIP ещё идёт — продлеваем от его конца, иначе — от сейчас
function vipAdd(email, days) {
  email = normEmail(email); days = Number(days);
  if (!Number.isInteger(days) || days < 1 || days > 3660) return { error: "Дней — целое число от 1 до 3660" };
  const u = db.prepare("SELECT id, vip_until FROM users WHERE email = ?").get(email);
  if (!u) return { error: "Нет игрока с такой почтой: " + email };
  const from = u.vip_until && u.vip_until > Date.now() ? u.vip_until : Date.now();
  db.prepare("UPDATE users SET vip_until = ? WHERE id = ?").run(from + days * DAY, u.id);
  return { user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(u.id) };
}
function vipOff(email) {
  email = normEmail(email);
  const u = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!u) return { error: "Нет игрока с такой почтой: " + email };
  db.prepare("UPDATE users SET vip_until = NULL WHERE id = ?").run(u.id);
  return { user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(u.id) };
}
// все, у кого VIP когда-либо был выдан (и действующие, и истёкшие) — свежие сверху
function vipList() { return db.prepare(`SELECT ${USER_COLS} FROM users WHERE vip_until IS NOT NULL ORDER BY vip_until DESC`).all(); }

// ── Щиты ──
// Каждый день — 1 подарочный щит (не копится: не потратил сегодня — завтра снова один). Купленные — на балансе, не сгорают.
const mskDay = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
function shieldInfo(u) {
  const row = u && db.prepare("SELECT shields, shield_gift FROM users WHERE id = ?").get(u.id);
  if (!row) return { bought: 0, gift: 0, total: 0 };
  const gift = row.shield_gift === mskDay() ? 0 : 1;
  return { bought: row.shields || 0, gift, total: (row.shields || 0) + gift };
}
// Потратить один щит: сначала подарочный, потом купленный. Одним запросом к базе — двойной клик не спишет дважды.
function useShield(userId) {
  const today = mskDay();
  let r = db.prepare("UPDATE users SET shield_gift = ? WHERE id = ? AND (shield_gift IS NULL OR shield_gift != ?)").run(today, userId, today);
  if (!r.changes) r = db.prepare("UPDATE users SET shields = shields - 1 WHERE id = ? AND shields > 0").run(userId);
  if (!r.changes) return { error: "Щиты закончились" };
  return { info: shieldInfo({ id: userId }) };
}
function shieldAdd(email, n) {
  email = normEmail(email); n = Number(n);
  if (!Number.isInteger(n) || n < 1 || n > 1000) return { error: "Щитов — целое число от 1 до 1000" };
  const u = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!u) return { error: "Нет игрока с такой почтой: " + email };
  db.prepare("UPDATE users SET shields = shields + ? WHERE id = ?").run(n, u.id);
  return { user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(u.id), info: shieldInfo(u) };
}

module.exports = { issueTempPassword, changePassword, makeVerifyToken, confirmEmail, setNews, userById, funPassword, normEmail,
  shieldInfo, useShield, shieldAdd, register, login, logout, userByToken, tokenFromReq, rename, setAvatar, listAvatars, setBio, isVip, vipAdd, vipOff, vipList };
