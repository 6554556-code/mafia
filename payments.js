// payments.js — оплата VIP и щитов через ЮKassa.
//
// Как это устроено:
//   1. Игрок выбирает товар → create() просит ЮKassa создать платёж → игрок уходит на её страницу оплаты.
//   2. ЮKassa присылает уведомление (webhook) и/или игрок возвращается в игру → sync() спрашивает у ЮKassa,
//      что с платежом на самом деле. Самому уведомлению НЕ верим: статус и сумму берём только из ответа ЮKassa.
//   3. Оплачено → зачисляем VIP/щиты. Ровно один раз: отметка credited ставится одним запросом к базе.
//
// Ключи — только в ~/.env:  YK_SHOP_ID=…  YK_SECRET=…   (сначала тестового магазина, потом боевого)
// Чеки:  YK_RECEIPT=1 — передавать данные для чека (почта, позиция). YK_VAT_CODE — ставка НДС (1 = без НДС).

const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const path = require("path");

const db = new DatabaseSync(path.join(__dirname, "mafia.db"));
db.exec("PRAGMA busy_timeout = 3000");
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id       TEXT PRIMARY KEY,          -- номер платежа в ЮKassa
    user_id  INTEGER NOT NULL,
    product  TEXT NOT NULL,             -- vip1 / vip7 / vip30 / sh1 / sh10 / sh30
    amount   TEXT NOT NULL,             -- "199.00"
    status   TEXT NOT NULL,             -- pending / succeeded / canceled
    test     INTEGER NOT NULL DEFAULT 0, -- 1 = тестовый магазин
    created  INTEGER NOT NULL,
    paid_at  INTEGER,
    credited INTEGER NOT NULL DEFAULT 0 -- 1 = VIP/щиты уже зачислены
  );
  CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, created);
`);

// ── Витрина. Цены живут ТОЛЬКО здесь: браузер присылает код товара, а не сумму. ──
const HOUR = 3600e3, DAY = 24 * HOUR;
const CATALOG = {
  vip1:  { title: "VIP на сутки",  price: "59.00",  vipMs: DAY },
  vip7:  { title: "VIP на неделю", price: "199.00", vipMs: 7 * DAY },
  vip30: { title: "VIP на месяц",  price: "499.00", vipMs: 30 * DAY },
  sh1:   { title: "1 щит",         price: "25.00",  shields: 1 },
  sh10:  { title: "10 щитов",      price: "199.00", shields: 10 },
  sh30:  { title: "30 щитов",      price: "499.00", shields: 30 },
};

// ── Сообщение в Telegram о каждой оплате — тот же бот и чат, что у утренней сводки (TG_BOT_TOKEN, TG_CHAT_ID в ~/.env).
//    TG_PAY_CHAT_ID — если захочется слать оплаты в отдельный чат. Ошибка отправки игру и зачисление не трогает.
const rub = (n) => Math.round(n).toLocaleString("ru-RU") + " ₽";
function notify(text) {
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_PAY_CHAT_ID || process.env.TG_CHAT_ID;
  if (!token || !chat) return;
  fetch(`${process.env.TG_API || "https://api.telegram.org"}/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  }).then((r) => { if (!r.ok) console.error("💳 телеграм: ответ " + r.status); })
    .catch((e) => console.error("💳 телеграм:", e.message));
}
function notifyPaid(row, item) {
  const u = db.prepare("SELECT name, email, vip_until, shields FROM users WHERE id = ?").get(row.user_id) || {};
  const dayStart = (() => { const d = new Date(Date.now() + 3 * 3600e3); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 3 * 3600e3; })();   // полночь по Москве
  const today = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CAST(amount AS REAL)), 0) s FROM payments WHERE credited = 1 AND test = ? AND paid_at >= ?").get(row.test ? 1 : 0, dayStart);
  const now = item.vipMs
    ? "👑 VIP до " + new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(u.vip_until)
    : "🛡 купленных щитов: " + u.shields;
  notify(`${row.test ? "🧪 ТЕСТ · " : ""}💰 +${rub(Number(row.amount))} · ${item.title}\n`
    + `Кто: ${u.name || "?"} (${u.email || "?"})\n${now}\n`
    + `За сегодня${row.test ? " (тест)" : ""}: ${rub(today.s)} · оплат: ${today.n}`);
}

const API = process.env.YK_API || "https://api.yookassa.ru/v3";   // YK_API — только для проверки на стенде
const enabled = () => !!(process.env.YK_SHOP_ID && process.env.YK_SECRET);
const authHeader = () => "Basic " + Buffer.from(`${process.env.YK_SHOP_ID}:${process.env.YK_SECRET}`).toString("base64");

async function yk(method, url, body) {
  const headers = { Authorization: authHeader(), "Content-Type": "application/json" };
  if (method === "POST") headers["Idempotence-Key"] = crypto.randomUUID();   // повтор запроса не создаст второй платёж
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(API + url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`ЮKassa ${r.status}: ${data.description || data.code || "ошибка"}`);
    return data;
  } finally { clearTimeout(t); }
}

// ── 1. Создать платёж. Возвращает адрес страницы оплаты. ──
async function create(user, product, returnUrl) {
  const item = CATALOG[product];
  if (!item) return { error: "Нет такого товара" };
  if (!enabled()) return { error: "Оплата скоро заработает — загляни чуть позже" };
  const body = {
    amount: { value: item.price, currency: "RUB" },
    capture: true,                                   // списываем сразу, без ручного подтверждения
    confirmation: { type: "redirect", return_url: returnUrl },
    description: `${item.title} — Мафия с ИИ`,
    metadata: { user_id: String(user.id), product },
  };
  if (process.env.YK_RECEIPT === "1") {
    body.receipt = {
      customer: { email: user.email },
      items: [{
        description: `${item.title} в онлайн-игре «Мафия с ИИ»`,
        quantity: "1.00",
        amount: { value: item.price, currency: "RUB" },
        vat_code: Number(process.env.YK_VAT_CODE || 1),
        payment_mode: "full_payment",
        payment_subject: "service",
      }],
    };
  }
  const p = await yk("POST", "/payments", body);
  const url = p.confirmation && p.confirmation.confirmation_url;
  if (!p.id || !url) throw new Error("ЮKassa не вернула страницу оплаты");
  db.prepare("INSERT OR IGNORE INTO payments (id, user_id, product, amount, status, test, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(p.id, user.id, product, item.price, p.status || "pending", p.test ? 1 : 0, Date.now());
  return { url, id: p.id };
}

// ── Зачисление. Отметка credited и начисление — в одной транзакции: дважды не зачислится никогда. ──
function credit(row, paidAt) {
  const item = CATALOG[row.product];
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = db.prepare("UPDATE payments SET status = 'succeeded', paid_at = ?, credited = 1 WHERE id = ? AND credited = 0").run(paidAt, row.id);
    if (!r.changes) { db.exec("COMMIT"); return false; }          // уже зачислено раньше
    if (item.vipMs) {
      // VIP ещё идёт — продлеваем от его конца, иначе — от сейчас
      db.prepare("UPDATE users SET vip_until = max(COALESCE(vip_until, 0), ?) + ? WHERE id = ?").run(Date.now(), item.vipMs, row.user_id);
    }
    if (item.shields) db.prepare("UPDATE users SET shields = shields + ? WHERE id = ?").run(item.shields, row.user_id);
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
  console.log(`💳 оплата ${row.id}: ${item.title} за ${row.amount} ₽ → игрок #${row.user_id}${row.test ? " (тест)" : ""}`);
  try { notifyPaid(row, item); } catch (e) { console.error("💳 телеграм:", e.message); }
  return true;
}

// ── 2. Узнать у ЮKassa правду о платеже и, если оплачен, зачислить. ──
async function sync(id) {
  const row = db.prepare("SELECT * FROM payments WHERE id = ?").get(String(id || ""));
  if (!row) return null;                                           // не наш платёж — игнорируем
  if (row.credited || row.status === "canceled") return row;
  const p = await yk("GET", "/payments/" + encodeURIComponent(row.id));
  const item = CATALOG[row.product];
  const meta = p.metadata || {};
  // сверяем всё: статус, сумму, валюту, кому и что
  const legit = p.paid && p.amount && p.amount.value === item.price && p.amount.currency === "RUB"
    && meta.user_id === String(row.user_id) && meta.product === row.product;
  if (p.status === "succeeded" && legit) {
    credit(row, Date.parse(p.captured_at || p.created_at) || Date.now());
  } else if (p.status === "succeeded") {
    console.error(`💳 оплата ${row.id}: статус succeeded, но данные не сходятся — НЕ зачислено, проверь в кабинете ЮKassa`);
    notify(`⚠️ Платёж ${row.id}: ЮKassa пишет «оплачен», но сумма или покупатель не сходятся — НЕ зачислено. Проверь в кабинете ЮKassa.`);
  } else if (p.status === "canceled") {
    db.prepare("UPDATE payments SET status = 'canceled' WHERE id = ? AND credited = 0").run(row.id);
  }
  return db.prepare("SELECT * FROM payments WHERE id = ?").get(row.id);
}

// ── Уведомление от ЮKassa. Берём из него только номер платежа, остальное перепроверяем. ──
async function onWebhook(body) {
  const id = body && body.object && body.object.id;
  if (!id || !enabled()) return;
  await sync(id);
}

// Последний платёж игрока за сутки (для плашки «VIP зачислен» после возврата со страницы оплаты)
function lastOf(userId) {
  return db.prepare("SELECT * FROM payments WHERE user_id = ? AND created > ? ORDER BY created DESC LIMIT 1").get(userId, Date.now() - DAY) || null;
}

// Подстраховка: раз в 10 минут перепроверяем свежие неоплаченные (если уведомление потерялось)
function sweep() {
  if (!enabled()) return;
  const rows = db.prepare("SELECT id FROM payments WHERE status = 'pending' AND created > ?").all(Date.now() - DAY);
  for (const r of rows) sync(r.id).catch((e) => console.error("💳 проверка " + r.id + ":", e.message));
}
setInterval(sweep, 10 * 60e3).unref();

function list(limit = 30) {
  return db.prepare(`SELECT p.*, u.email, u.name FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created DESC LIMIT ?`).all(limit);
}
const catalog = () => Object.entries(CATALOG).map(([id, x]) => ({ id, title: x.title, price: Number(x.price) }));

module.exports = { create, sync, onWebhook, lastOf, list, catalog, CATALOG, enabled };
