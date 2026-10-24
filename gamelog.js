// gamelog.js — журнал партий для теста «играют ли люди».
// Пишет в ту же базу mafia.db две таблицы: партии и слова игрока.
// Движок только зовёт три функции; сводку и выгрузку делает stats.js.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(path.join(__dirname, "mafia.db"));
// база общая с игрой: если она прямо сейчас пишет — подождать до 3 с, а не падать с «database is locked»
db.exec("PRAGMA busy_timeout = 3000");

// IF NOT EXISTS — безопасно при каждом старте, живые таблицы не трогаются
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    role      TEXT NOT NULL,
    started   INTEGER NOT NULL,
    finished  INTEGER,            -- NULL = не доиграна (брошена или идёт сейчас)
    winner    TEXT,               -- town / mafia / maniac
    won       INTEGER,            -- 1 = сторона игрока победила
    days      INTEGER,
    alive     INTEGER,            -- 1 = игрок дожил до конца
    msgs      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS game_msgs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    ts      INTEGER NOT NULL,
    day     INTEGER,
    kind    TEXT NOT NULL,        -- say / vote / whisper / whisper_reply / doc_whisper / mafia_say
    target  TEXT,                 -- кому/за кого (если есть)
    text    TEXT
  );
  CREATE TABLE IF NOT EXISTS ai_calls (
    ts       INTEGER NOT NULL,
    ms       INTEGER NOT NULL,      -- сколько длился запрос к модели
    provider TEXT,                  -- кто ответил: openrouter/Morph, deepseek, …
    ok       INTEGER NOT NULL       -- 1 = ответ получен, 0 = сдались после всех повторов
  );
  CREATE INDEX IF NOT EXISTS ai_calls_ts ON ai_calls(ts);
`);

// Журнал не должен ронять игру: любая ошибка записи — только строчка в консоль
function safe(fn) {
  return (...a) => { try { return fn(...a); } catch (e) { console.error("журнал партий:", e.message); return null; } };
}

// Миграция: была ли партия сыграна в VIP (1) или бесплатно (0). Старые партии — NULL (до VIP, значит бесплатные).
try { db.exec("ALTER TABLE games ADD COLUMN vip INTEGER"); } catch (_) {}
// Миграция: сколько игроков было за столом. Старые партии — NULL (это была восьмёрка).
try { db.exec("ALTER TABLE games ADD COLUMN size INTEGER"); } catch (_) {}
// Миграция: партию завершили досрочно (VIP-кнопка). finished при этом остаётся пустым — в таблицу и лимит не идёт.
try { db.exec("ALTER TABLE games ADD COLUMN quit INTEGER"); } catch (_) {}
// Миграция: щиты в партии — сколько поставлено и сколько раз реально спасли
try { db.exec("ALTER TABLE games ADD COLUMN shields INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE games ADD COLUMN shield_saves INTEGER NOT NULL DEFAULT 0"); } catch (_) {}

const startGame = safe((userId, userName, role, vip, size) =>
  Number(db.prepare("INSERT INTO games (user_id, user_name, role, started, vip, size) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, userName, role, Date.now(), vip ? 1 : 0, size || 8).lastInsertRowid));

const logMsg = safe((gameId, userId, day, kind, target, text) => {
  if (!gameId) return;
  text = text ? String(text).slice(0, 500) : null;
  target = target ? String(target).slice(0, 40) : null;
  db.prepare("INSERT INTO game_msgs (game_id, user_id, ts, day, kind, target, text) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(gameId, userId, Date.now(), day ?? null, kind, target, text);
  if (text) db.prepare("UPDATE games SET msgs = msgs + 1 WHERE id = ?").run(gameId);
});

const SIDE = { mafia: "mafia", maniac: "maniac" };   // остальные роли — за деревню (town)
const finishGame = safe((gameId, role, winner, days, alive) => {
  if (!gameId) return;
  const won = (SIDE[role] || "town") === winner ? 1 : 0;
  db.prepare("UPDATE games SET finished = ?, winner = ?, won = ?, days = ?, alive = ? WHERE id = ?")
    .run(Date.now(), winner, won, days, alive ? 1 : 0, gameId);
});

const shieldUsed = safe((gameId) => { if (gameId) db.prepare("UPDATE games SET shields = shields + 1 WHERE id = ?").run(gameId); });
const shieldSaved = safe((gameId) => { if (gameId) db.prepare("UPDATE games SET shield_saves = shield_saves + 1 WHERE id = ?").run(gameId); });

const quitGame = safe((gameId) => {
  if (!gameId) return;
  db.prepare("UPDATE games SET quit = ? WHERE id = ? AND finished IS NULL").run(Date.now(), gameId);
});

// Спидометр: каждый запрос к ИИ — длительность и кто ответил (для сводки «скорость ИИ за сутки»)
const logAiCall = safe((ms, provider, ok) =>
  db.prepare("INSERT INTO ai_calls (ts, ms, provider, ok) VALUES (?, ?, ?, ?)").run(Date.now(), Math.round(ms), provider || null, ok ? 1 : 0));

// ── Очки турнирной таблицы ──
// Стороны: деревня (мирный, доктор, комиссар) и «плохие» (мафия, маньяк).
//   2 — твоя сторона победила и ты дожил;  1 — твоя сторона победила, но тебя уже нет.
//   Маньяк: дожил до победы мафии — тоже 2 (плохие победили вместе); погиб до победы мафии — 0.
//   Мафия при победе маньяка-одиночки: дожила — 2, нет — 0 (маньяк побеждает сам за себя).
function pointsFor(role, winner, alive) {
  if (winner === "town") return !SIDE[role] ? (alive ? 2 : 1) : 0;   // деревня: мирный, доктор, комиссар, путана, бомж
  if (winner === "mafia") {
    if (role === "mafia") return alive ? 2 : 1;
    if (role === "maniac") return alive ? 2 : 0;
    return 0;
  }
  if (winner === "maniac") {
    if (role === "maniac") return 2;
    if (role === "mafia") return alive ? 2 : 0;
    return 0;
  }
  return 0;
}

// Начало текущей недели — понедельник 00:00 по Москве (МСК = UTC+3 круглый год)
function weekStart(now = Date.now()) {
  const MSK = 3 * 3600e3;
  const d = new Date(now + MSK);                       // «московские» часы в UTC-полях
  const dow = (d.getUTCDay() + 6) % 7;                 // 0 = понедельник
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - MSK;
}

// Таблица: только доигранные партии; ник и лицо — текущие из аккаунта (после смены ника — новые)
let lbCache = { key: "", at: 0, rows: null };
function leaderboardRows(period) {
  const since = period === "week" ? weekStart() : 0;
  const key = period + ":" + since;
  if (lbCache.key === key && Date.now() - lbCache.at < 15000) return lbCache.rows;   // не считаем чаще раза в 15 с
  const games = db.prepare("SELECT user_id, role, winner, alive FROM games WHERE finished IS NOT NULL AND started >= ?").all(since);
  const by = new Map();
  for (const g of games) {
    const pts = pointsFor(g.role, g.winner, g.alive);
    const r = by.get(g.user_id) || { userId: g.user_id, points: 0, games: 0, wins: 0 };
    r.points += pts; r.games++; if (pts > 0) r.wins++;
    by.set(g.user_id, r);
  }
  const users = new Map(db.prepare("SELECT id, name, avatar FROM users").all().map((u) => [u.id, u]));
  const rows = [...by.values()]
    .filter((r) => users.has(r.userId))
    .map((r) => ({ ...r, name: users.get(r.userId).name, avatar: users.get(r.userId).avatar, winPct: Math.round((100 * r.wins) / r.games) }))
    .sort((a, b) => b.points - a.points || a.games - b.games || a.userId - b.userId);   // больше очков; при равенстве — меньше партий
  rows.forEach((r, i) => (r.rank = i + 1));
  lbCache = { key, at: Date.now(), rows };
  return rows;
}
function leaderboard(period, userId, top = 20) {
  const rows = leaderboardRows(period);
  const pub = (r) => r && { rank: r.rank, name: r.name, avatar: r.avatar, points: r.points, games: r.games, winPct: r.winPct, me: r.userId === userId };
  return { period, top: rows.slice(0, top).map(pub), me: pub(rows.find((r) => r.userId === userId)) || null, total: rows.length };
}
function invalidateLeaderboard() { lbCache.key = ""; }

// ── Дневной лимит бесплатных партий ──
// Начало текущих суток по Москве (00:00 МСК)
function dayStart(now = Date.now()) {
  const MSK = 3 * 3600e3;
  const d = new Date(now + MSK);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - MSK;
}
// Сколько БЕСПЛАТНЫХ партий игрок ДОИГРАЛ сегодня (по моменту окончания). Брошенные и VIP-партии не считаются.
function finishedToday(userId) {
  try { return db.prepare("SELECT COUNT(*) AS n FROM games WHERE user_id = ? AND finished >= ? AND (vip IS NULL OR vip = 0)").get(userId, dayStart()).n; }
  catch (e) { console.error("журнал партий:", e.message); return 0; }   // журнал сломался — лимит не мешает играть
}

module.exports = { db, startGame, logMsg, finishGame, quitGame, shieldUsed, shieldSaved, logAiCall, pointsFor, leaderboard, invalidateLeaderboard, weekStart, dayStart, finishedToday };
