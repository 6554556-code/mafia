// stats.js — сводка теста «играют ли люди» + выгрузка в Telegram.
//
//   node stats.js            — сводка в консоль
//   node stats.js telegram   — сводка + два файла для Excel в Telegram
//   node stats.js chatid     — узнать свой chat_id (сначала напиши боту «привет»)
//
// Ключи берём из ~/.env:  TG_BOT_TOKEN=...   TG_CHAT_ID=...

process.removeAllListeners("warning");   // не печатать «SQLite is experimental» — это шум для сводки
require("dotenv").config({ path: require("path").join(require("os").homedir(), ".env"), quiet: true });
const { db } = require("./gamelog");   // та же база, таблицы заведутся сами

const TZ = "Europe/Moscow";
const ABANDON_MS = 3 * 3600 * 1000;    // не доиграна и начата больше 3 ч назад — считаем брошенной
const DAY_MS = 24 * 3600 * 1000;
const now = Date.now();

// ── время по Москве ──
const dayKey = (ts) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
const fmt = (ts) => ts ? new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(ts).replace(",", "") : "";
const short = (ts) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" }).format(ts);

const ROLE = { mafia: "Мафия", maniac: "Маньяк", komissar: "Комиссар", doctor: "Доктор", civilian: "Мирный" };
const WIN = { town: "Деревня", mafia: "Мафия", maniac: "Маньяк" };
const KIND = { say: "за столом", vote: "голос", whisper: "шёпот", whisper_reply: "ответ на шёпот", doc_whisper: "шёпот доктора", mafia_say: "напарнику-мафии" };

const status = (g) => g.finished ? "доиграна" : now - g.started > ABANDON_MS ? "брошена" : "идёт";
const pct = (a, b) => b ? Math.round((100 * a) / b) + "%" : "—";
const avg = (a, b) => b ? (a / b).toFixed(1).replace(".0", "") : "—";

// ── данные ──
function load() {
  const users = db.prepare("SELECT id, name, created FROM users").all();
  const games = db.prepare("SELECT * FROM games ORDER BY id").all();
  const msgs = db.prepare(`SELECT m.*, g.user_name, g.role FROM game_msgs m JOIN games g ON g.id = m.game_id ORDER BY m.id`).all();
  return { users, games, msgs };
}

// ── сводка текстом ──
function summary({ users, games, msgs }) {
  const L = [];
  L.push(`📊 Мафия — сводка на ${fmt(now)} (МСК)`);

  // игроки
  const byUser = new Map();
  for (const g of games) {
    if (!byUser.has(g.user_id)) byUser.set(g.user_id, { name: g.user_name, games: 0, days: new Set(), last: 0 });
    const u = byUser.get(g.user_id);
    u.games++; u.days.add(dayKey(g.started)); u.last = Math.max(u.last, g.started); u.name = g.user_name;
  }
  const played = byUser.size;
  const returned = [...byUser.values()].filter((u) => u.days.size >= 2).length;
  const newUsers = users.filter((u) => now - u.created < DAY_MS).length;
  L.push("", "👥 Игроки");
  L.push(`Зарегистрировано: ${users.length}${newUsers ? ` (+${newUsers} за сутки)` : ""}`);
  L.push(`Сыграли хотя бы раз: ${played}`);
  L.push(`Вернулись в другой день: ${returned} из ${played} (${pct(returned, played)})  ← главная цифра`);
  L.push(`Партий на игрока: в среднем ${avg(games.length, played)}`);

  // партии
  const fin = games.filter((g) => g.finished);
  const aband = games.filter((g) => status(g) === "брошена").length;
  const going = games.length - fin.length - aband;
  const day24 = games.filter((g) => now - g.started < DAY_MS).length;
  const withMsgs = games.filter((g) => g.msgs > 0).length;
  const totalTexts = games.reduce((s, g) => s + g.msgs, 0);
  L.push("", "🎲 Партии");
  L.push(`Всего: ${games.length}${day24 ? ` (за сутки: ${day24})` : ""}`);
  L.push(`Доиграно: ${fin.length} · Брошено: ${aband}${going ? ` · Идёт сейчас: ${going}` : ""}`);
  L.push(`Средняя длина: ${avg(fin.reduce((s, g) => s + (g.days || 0), 0), fin.length)} дн.`);
  L.push(`Писали в чат: в ${pct(withMsgs, games.length)} партий · реплик за партию в среднем: ${avg(totalTexts, games.length)}`);

  // по дням
  const days = new Map();
  for (const g of games) {
    const k = dayKey(g.started);
    if (!days.has(k)) days.set(k, { users: new Set(), games: 0, ts: g.started });
    const d = days.get(k); d.users.add(g.user_id); d.games++;
  }
  if (days.size) {
    L.push("", "📅 По дням (последние 7)");
    [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7)
      .forEach(([, d]) => L.push(`${short(d.ts)}: ${d.users.size} игр., ${d.games} парт.`));
  }

  // роли
  if (fin.length) {
    L.push("", "🎭 Роль игрока → побед (доигранные)");
    for (const r of Object.keys(ROLE)) {
      const gs = fin.filter((g) => g.role === r);
      if (gs.length) L.push(`${ROLE[r]}: ${gs.length} парт., побед ${gs.filter((g) => g.won).length}`);
    }
  }

  // самые активные
  if (played) {
    L.push("", "🏆 Самые активные");
    [...byUser.values()].sort((a, b) => b.games - a.games).slice(0, 5)
      .forEach((u) => L.push(`${u.name} — ${u.games} парт., дней: ${u.days.size}, последний раз ${short(u.last)}`));
  }

  const newMsgs = msgs.filter((m) => now - m.ts < DAY_MS).length;
  L.push("", `💬 Реплик игроков всего: ${msgs.length}${newMsgs ? ` (новых за сутки: ${newMsgs})` : ""}`);
  return L.join("\n");
}

// ── файлы для Excel: BOM (чтобы русские буквы читались) + разделитель «;» (русский Excel) ──
function csv(head, rows) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return "﻿" + [head, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
}
function gamesCsv({ games }) {
  return csv(
    ["№ партии", "Игрок", "Роль", "Начало (МСК)", "Конец (МСК)", "Статус", "Победила сторона", "Игрок победил", "Дней", "Дожил до конца", "Реплик", "Новое за сутки"],
    games.map((g) => [g.id, g.user_name, ROLE[g.role] || g.role, fmt(g.started), fmt(g.finished), status(g),
      WIN[g.winner] || "", g.finished ? (g.won ? "да" : "нет") : "", g.days ?? "", g.finished ? (g.alive ? "да" : "нет") : "",
      g.msgs, now - g.started < DAY_MS ? "✓" : ""]));
}
function msgsCsv({ msgs }) {
  return csv(
    ["Время (МСК)", "Игрок", "№ партии", "Роль игрока", "День", "Тип", "Кому / за кого", "Текст", "Новое за сутки"],
    msgs.map((m) => [fmt(m.ts), m.user_name, m.game_id, ROLE[m.role] || m.role, m.day ?? "", KIND[m.kind] || m.kind,
      m.target || "", m.text || "", now - m.ts < DAY_MS ? "✓" : ""]));
}

// ── Telegram ──
const TG_API = process.env.TG_API || "https://api.telegram.org";
async function tg(method, body) {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) throw new Error("Нет TG_BOT_TOKEN в ~/.env");
  // без тела — простой GET (пустую «посылку» Telegram отбивает ошибкой 400)
  const opts = body ? { method: "POST", body } : { method: "GET" };
  const res = await fetch(`${TG_API}/bot${token}/${method}`, { ...opts, signal: AbortSignal.timeout(30000) });
  const raw = await res.text();
  let j = {}; try { j = JSON.parse(raw); } catch (_) {}
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || res.status + " " + raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)}`);
  return j.result;
}
async function sendTelegram(data) {
  const chat = process.env.TG_CHAT_ID;
  if (!chat) throw new Error("Нет TG_CHAT_ID в ~/.env — узнай его командой: node stats.js chatid");
  const text = summary(data);
  const f1 = new FormData(); f1.append("chat_id", chat); f1.append("text", text.slice(0, 4000));
  await tg("sendMessage", f1);
  const stamp = dayKey(now);
  for (const [name, content] of [[`mafia-partii-${stamp}.csv`, gamesCsv(data)], [`mafia-repliki-${stamp}.csv`, msgsCsv(data)]]) {
    const f = new FormData();
    f.append("chat_id", chat);
    f.append("document", new Blob([content], { type: "text/csv" }), name);
    await tg("sendDocument", f);
  }
  console.log(`✓ Отправлено в Telegram: сводка + 2 файла (партий: ${data.games.length}, реплик: ${data.msgs.length})`);
}
async function chatId() {
  const ups = await tg("getUpdates");
  const chats = new Map();
  for (const u of ups) { const c = (u.message || u.channel_post || {}).chat; if (c) chats.set(c.id, c.first_name || c.title || c.username || ""); }
  if (!chats.size) { console.log("Боту пока никто не писал. Напиши ему в Telegram «привет» и запусти команду ещё раз."); return; }
  for (const [id, name] of chats) console.log(`${name}: впиши в ~/.env строку  TG_CHAT_ID=${id}`);
}

// ── запуск ──
(async () => {
  const mode = process.argv[2] || "";
  try {
    if (mode === "chatid") return await chatId();
    const data = load();
    if (mode === "telegram") return await sendTelegram(data);
    console.log(summary(data));
  } catch (e) {
    console.error("✗ " + e.message);
    process.exitCode = 1;
  }
})();
