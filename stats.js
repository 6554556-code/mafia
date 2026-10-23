// stats.js — сводка теста «играют ли люди» + выгрузка в Telegram.
//
//   node stats.js            — сводка в консоль
//   node stats.js telegram   — сводка + два файла для Excel в Telegram
//   node stats.js chatid     — узнать свой chat_id (сначала напиши боту «привет»)
//   node stats.js online     — панель дежурного: кто играет прямо сейчас и как быстро отвечает ИИ
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

const ROLE = { mafia: "Мафия", maniac: "Маньяк", komissar: "Комиссар", doctor: "Доктор", civilian: "Мирный", putana: "Путана", bomzh: "Бомж" };
const WIN = { town: "Деревня", mafia: "Мафия", maniac: "Маньяк" };
const KIND = { say: "за столом", vote: "голос", whisper: "шёпот", whisper_reply: "ответ на шёпот", doc_whisper: "шёпот доктора", mafia_say: "напарнику-мафии" };

const status = (g) => g.finished ? "доиграна" : now - g.started > ABANDON_MS ? "брошена" : "идёт";
const pct = (a, b) => b ? Math.round((100 * a) / b) + "%" : "—";
const avg = (a, b) => b ? (a / b).toFixed(1).replace(".0", "") : "—";
const sec = (ms) => ms == null ? "—" : (ms / 1000).toFixed(1) + " с";
const quant = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

// ── данные ──
// Отчёт — за последние сутки (от прошлого отчёта до этого). Для «за всё время» берём полную историю.
const since = now - DAY_MS;
function load() {
  const users = db.prepare("SELECT id, name, email, created FROM users").all();
  const email = new Map(users.map((u) => [u.id, u.email]));
  const games = db.prepare("SELECT * FROM games ORDER BY id").all().map((g) => ({ ...g, email: email.get(g.user_id) || "" }));
  const msgs = db.prepare(`SELECT m.*, g.user_name, g.role FROM game_msgs m JOIN games g ON g.id = m.game_id ORDER BY m.id`).all()
    .map((m) => ({ ...m, email: email.get(m.user_id) || "" }));
  return {
    users, games, msgs,                                    // вся история (для строки «за всё время»)
    dUsers: users.filter((u) => u.created >= since),       // за сутки
    dGames: games.filter((g) => g.started >= since),
    dMsgs: msgs.filter((m) => m.ts >= since),
  };
}

// ── сводка текстом (за сутки) ──
function summary({ users, games, dUsers, dGames, dMsgs }) {
  const L = [];
  L.push(`📊 Мафия — сутки: ${fmt(since)} → ${fmt(now)} (МСК)`);

  // кто играл за сутки: новички (первая партия — в эти сутки) и вернувшиеся (играли и раньше)
  const firstGame = new Map();
  for (const g of games) if (!firstGame.has(g.user_id)) firstGame.set(g.user_id, g.started);
  const byUser = new Map();
  for (const g of dGames) {
    if (!byUser.has(g.user_id)) byUser.set(g.user_id, { name: g.user_name, games: 0 });
    const u = byUser.get(g.user_id); u.games++; u.name = g.user_name;
  }
  const played = byUser.size;
  const newbies = [...byUser.keys()].filter((id) => firstGame.get(id) >= since).length;
  L.push("", "👥 Игроки за сутки");
  L.push(`Новых регистраций: ${dUsers.length}`);
  L.push(`Играли: ${played} — новичков ${newbies}, вернулись ${played - newbies}`);
  L.push(`Партий на игрока: в среднем ${avg(dGames.length, played)}`);

  // партии за сутки
  const fin = dGames.filter((g) => g.finished);
  const aband = dGames.filter((g) => status(g) === "брошена").length;
  const going = dGames.length - fin.length - aband;
  const withMsgs = dGames.filter((g) => g.msgs > 0).length;
  const totalTexts = dGames.reduce((s, g) => s + g.msgs, 0);
  L.push("", "🎲 Партии за сутки");
  L.push(`Всего: ${dGames.length} · Доиграно: ${fin.length} · Брошено: ${aband}${going ? ` · Идёт сейчас: ${going}` : ""}`);
  L.push(`Средняя длина: ${avg(fin.reduce((s, g) => s + (g.days || 0), 0), fin.length)} дн.`);
  L.push(`Писали в чат: в ${pct(withMsgs, dGames.length)} партий · реплик за партию в среднем: ${avg(totalTexts, dGames.length)}`);

  // VIP и дневной лимит: сколько бесплатных доиграли свой лимит (дошли до «самого интересного места»)
  // Считаем только БЕСПЛАТНЫЕ партии (vip ≠ 1): кто упёрся, а потом взял VIP, — тоже виден (это и есть покупка).
  {
    const FREE = Number(process.env.FREE_GAMES ?? 5);
    let vipNow = 0;
    try { vipNow = db.prepare("SELECT COUNT(*) AS n FROM users WHERE vip_until > ?").get(now).n; } catch (_) {}   // колонки ещё нет — VIP пока ни у кого
    const perDay = new Map();   // "игрок|день МСК" → доиграно бесплатно
    for (const g of games) if (g.finished && g.finished >= since && g.vip !== 1) {
      const k = g.user_id + "|" + dayKey(g.finished); perDay.set(k, (perDay.get(k) || 0) + 1);
    }
    const hit = new Set([...perDay].filter(([, n]) => n >= FREE).map(([k]) => k.split("|")[0]));
    const vipGames = dGames.filter((g) => g.vip === 1).length;
    L.push("", "👑 VIP и лимит");
    L.push(`Упёрлись в лимит ${FREE} партий: ${hit.size} игрок(ов) · VIP действует: ${vipNow} · VIP-партий за сутки: ${vipGames}`);
  }

  if (fin.length) {
    L.push("", "🎭 Роль игрока → побед");
    for (const r of Object.keys(ROLE)) {
      const gs = fin.filter((g) => g.role === r);
      if (gs.length) L.push(`${ROLE[r]}: ${gs.length} парт., побед ${gs.filter((g) => g.won).length}`);
    }
  }
  // баланс по размеру стола — за всё время (на столах больше 8 данных мало, копим): кто сколько выигрывает
  {
    const fAll = games.filter((g) => g.finished && g.winner);
    const sizes = [...new Set(fAll.map((g) => g.size || 8))].sort((a, b) => a - b);
    if (sizes.some((n) => n > 8)) {
      L.push("", "🪑 Победы по столам (за всё время): деревня / мафия / маньяк");
      for (const n of sizes) {
        const gs = fAll.filter((g) => (g.size || 8) === n), w = (k) => pct(gs.filter((g) => g.winner === k).length, gs.length);
        L.push(`${n} игр.: ${w("town")} / ${w("mafia")} / ${w("maniac")} — партий ${gs.length}`);
      }
    }
  }

  if (played) {
    L.push("", "🏆 Самые активные за сутки");
    [...byUser.values()].sort((a, b) => b.games - a.games).slice(0, 5).forEach((u) => L.push(`${u.name} — ${u.games} парт.`));
  }
  L.push("", `💬 Реплик игроков за сутки: ${dMsgs.length}`);

  // скорость ИИ за сутки (один «ход» персонажа = 2 запроса: план + речь)
  let calls = [];
  try { calls = db.prepare("SELECT ms, provider, ok FROM ai_calls WHERE ts >= ?").all(since); } catch (_) {}
  if (calls.length) {
    const ms = calls.map((c) => c.ms);
    const slow = ms.filter((m) => m > 10000).length, failed = calls.filter((c) => !c.ok).length;
    L.push("", "🤖 Скорость ИИ за сутки");
    L.push(`Запросов: ${calls.length} · обычно ${sec(quant(ms, 0.5))} · медленные 10% — от ${sec(quant(ms, 0.9))}`);
    L.push(`Дольше 10 с: ${pct(slow, calls.length)}${failed ? ` · без ответа: ${failed}` : ""}`);
    const by = {};
    for (const c of calls) (by[c.provider || "?"] = by[c.provider || "?"] || []).push(c.ms);
    const top = Object.entries(by).sort((a, b) => b[1].length - a[1].length).slice(0, 4);
    L.push("Кто отвечал: " + top.map(([p, a]) => `${p.replace("openrouter/", "")} ${pct(a.length, calls.length)} (${sec(quant(a, 0.5))})`).join(" · "));
  }

  // одна строка за всё время: главная цифра теста за сутки не считается
  const days = new Map();
  for (const g of games) { if (!days.has(g.user_id)) days.set(g.user_id, new Set()); days.get(g.user_id).add(dayKey(g.started)); }
  const returned = [...days.values()].filter((d) => d.size >= 2).length;
  L.push("", `📈 За всё время: зарегистрировано ${users.length} · играли ${days.size} · вернулись в другой день ${returned} из ${days.size} (${pct(returned, days.size)})`);
  return L.join("\n");
}

// ── файлы для Excel (за сутки): BOM (чтобы русские буквы читались) + разделитель «;» (русский Excel) ──
function csv(head, rows) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return "\uFEFF" + [head, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
}
function gamesCsv({ dGames }) {
  return csv(
    ["№ партии", "Игрок", "Почта", "Роль", "Начало (МСК)", "Конец (МСК)", "Статус", "Победила сторона", "Игрок победил", "Дней", "Дожил до конца", "Реплик"],
    dGames.map((g) => [g.id, g.user_name, g.email, ROLE[g.role] || g.role, fmt(g.started), fmt(g.finished), status(g),
      WIN[g.winner] || "", g.finished ? (g.won ? "да" : "нет") : "", g.days ?? "", g.finished ? (g.alive ? "да" : "нет") : "", g.msgs]));
}
function msgsCsv({ dMsgs }) {
  return csv(
    ["Время (МСК)", "Игрок", "Почта", "№ партии", "Роль игрока", "День", "Тип", "Кому / за кого", "Текст"],
    dMsgs.map((m) => [fmt(m.ts), m.user_name, m.email, m.game_id, ROLE[m.role] || m.role, m.day ?? "", KIND[m.kind] || m.kind, m.target || "", m.text || ""]));
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
  console.log(`✓ Отправлено в Telegram: сводка + 2 файла за сутки (партий: ${data.dGames.length}, реплик: ${data.dMsgs.length})`);
}
async function chatId() {
  const ups = await tg("getUpdates");
  const chats = new Map();
  for (const u of ups) { const c = (u.message || u.channel_post || {}).chat; if (c) chats.set(c.id, c.first_name || c.title || c.username || ""); }
  if (!chats.size) { console.log("Боту пока никто не писал. Напиши ему в Telegram «привет» и запусти команду ещё раз."); return; }
  for (const [id, name] of chats) console.log(`${name}: впиши в ~/.env строку  TG_CHAT_ID=${id}`);
}

// ── панель дежурного: спрашиваем живую игру на этом же сервере ──
async function online() {
  const port = process.env.PORT || 3000;
  let d;
  try { d = await (await fetch(`http://127.0.0.1:${port}/admin/online?min=10`, { signal: AbortSignal.timeout(5000) })).json(); }
  catch (e) { throw new Error(`игра не отвечает на порту ${port} — она запущена? (systemctl status mafia)`); }
  const s = d.speed;
  console.log(`👥 Сейчас с открытой вкладкой: ${d.online}`);
  console.log(`🎲 Партий идёт: ${d.games} · ждут хода человека: ${d.waitingHuman} · ИИ думает: ${d.games - d.waitingHuman}`);
  console.log(`📡 Запросов к ИИ прямо сейчас: ${d.inflight} · маршрут: ${d.route}`);
  if (!s.count) { console.log(`🤖 За последние ${s.minutes} мин запросов к ИИ не было`); return; }
  console.log(`🤖 За ${s.minutes} мин: запросов ${s.count} · обычно ${sec(s.p50)} · медленные 10% — от ${sec(s.p90)} · самый долгий ${sec(s.max)}`);
  console.log(`   дольше 10 с: ${s.slow}${s.failed ? ` · без ответа: ${s.failed}` : ""}`);
  console.log("   кто отвечал: " + s.providers.map((x) => `${x.p.replace("openrouter/", "")} ×${x.n} (${sec(x.p50)})`).join(" · "));
}

// ── запуск ──
(async () => {
  const mode = process.argv[2] || "";
  try {
    if (mode === "chatid") return await chatId();
    if (mode === "online") return await online();
    const data = load();
    if (mode === "telegram") return await sendTelegram(data);
    console.log(summary(data));
  } catch (e) {
    console.error("✗ " + e.message);
    process.exitCode = 1;
  }
})();
