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

const startGame = safe((userId, userName, role) =>
  Number(db.prepare("INSERT INTO games (user_id, user_name, role, started) VALUES (?, ?, ?, ?)")
    .run(userId, userName, role, Date.now()).lastInsertRowid));

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

// Спидометр: каждый запрос к ИИ — длительность и кто ответил (для сводки «скорость ИИ за сутки»)
const logAiCall = safe((ms, provider, ok) =>
  db.prepare("INSERT INTO ai_calls (ts, ms, provider, ok) VALUES (?, ?, ?, ?)").run(Date.now(), Math.round(ms), provider || null, ok ? 1 : 0));

module.exports = { db, startGame, logMsg, finishGame, logAiCall };
