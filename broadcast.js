// broadcast.js — рассылки игрокам.
//
//   node broadcast.js vip  --count          — сколько человек получит (ничего не отправляет)
//   node broadcast.js vip  --test почта     — пробное письмо только на эту почту (журнал не трогает)
//   node broadcast.js vip                   — отправить всем, кому положено
//   node broadcast.js move …                — то же для служебного письма о переезде
//
// Кампании:
//   vip  — РЕКЛАМА «VIP доступен от 59 ₽». Только тем, кто дал согласие на новости (users.news = 1). Со ссылкой «отписаться».
//   move — СЛУЖЕБНОЕ «Мафия переехала». Тем, кто согласия на новости не давал. Без рекламы.
//
// Письма уходят медленно (MAIL_DELAY_SEC в ~/.env, по умолчанию 20 с ≈ 180 писем в час), чтобы почта хостинга
// не посчитала нас спамерами. Журнал broadcast_sent: каждому — не больше одного письма кампании; прервалось — запусти снова,
// продолжит с того, кому ещё не отправлено.
// Чтобы рассылка шла, даже если закрыть консоль:   nohup node broadcast.js move > move.log 2>&1 &     потом   tail move.log

process.removeAllListeners("warning");
const path = require("path");
require("dotenv").config({ path: path.join(require("os").homedir(), ".env"), quiet: true });
const auth = require("./auth");
const mail = require("./mail");
const db = auth.db;

db.exec(`CREATE TABLE IF NOT EXISTS broadcast_sent (
  campaign TEXT NOT NULL, user_id INTEGER NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL,   -- ok / fail: текст ошибки
  PRIMARY KEY (campaign, user_id))`);

const SITE = process.env.PUBLIC_URL || "https://iplaymafia.com";
const CAMPAIGNS = {
  vip: {
    who: "users.news = 1",
    send: (u) => mail.sendPromoVip(u, `${SITE}/unsub?u=${u.id}&s=${auth.unsubSig(u.id)}`),
  },
  move: {
    who: "users.news = 0",
    send: (u) => mail.sendServiceMove(u, u.email_ok ? SITE : `${SITE}/verify?t=${auth.makeVerifyToken(u.id)}`),
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(Date.now());
// временный отказ сервера (лимит, «попробуй позже») — ждём и повторяем; постоянный (нет такого ящика) — пропускаем
const temporary = (e) => /^4\d\d/.test(String(e.responseCode || "")) || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ESOCKET|EDNS|rate|limit|too many|try again/i.test(e.message || "");

(async () => {
  const [name, flag, arg] = process.argv.slice(2);
  const C = CAMPAIGNS[name];
  if (!C) return console.log("Как пользоваться:\n  node broadcast.js vip --count\n  node broadcast.js vip --test почта\n  node broadcast.js vip\n  (то же для move)");
  if (!mail.enabled()) return console.log("Почта не настроена (SMTP_* в ~/.env)");

  if (flag === "--test") {
    const u = db.prepare("SELECT id, email, name, email_ok FROM users WHERE email = ?").get(auth.normEmail(arg));
    if (!u) return console.log("Нет игрока с такой почтой: " + arg + "\nПробное письмо уходит только на почту аккаунта в игре.");
    await C.send(u);
    return console.log("Готово ✓ Пробное письмо «" + name + "» отправлено на " + u.email + ". Журнал не тронут.");
  }

  const list = db.prepare(`SELECT id, email, name, email_ok FROM users
    WHERE ${C.who} AND id NOT IN (SELECT user_id FROM broadcast_sent WHERE campaign = ?) ORDER BY id`).all(name);
  const done = db.prepare("SELECT COUNT(*) n FROM broadcast_sent WHERE campaign = ? AND status = 'ok'").get(name).n;
  const delay = Math.max(3, Number(process.env.MAIL_DELAY_SEC || 20)) * 1000;
  console.log(`Кампания «${name}»: осталось отправить ${list.length}, уже отправлено ${done}. Пауза между письмами ${delay / 1000} с — займёт ~${Math.ceil(list.length * delay / 60000)} мин.`);
  if (flag === "--count" || !list.length) return;

  const mark = db.prepare("INSERT OR REPLACE INTO broadcast_sent (campaign, user_id, ts, status) VALUES (?, ?, ?, ?)");
  let ok = 0, fail = 0, streak = 0;
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    let tries = 0;
    for (;;) {
      try {
        await C.send(u);
        mark.run(name, u.id, Date.now(), "ok"); ok++; streak = 0;
        console.log(`${now()} ✓ ${i + 1}/${list.length} ${u.email}`);
        break;
      } catch (e) {
        if (temporary(e) && tries < 3) {
          tries++; streak++;
          console.log(`${now()} ⏸ ${u.email}: ${e.message} — жду 10 мин и повторяю (${tries}/3)`);
          if (streak >= 6) { console.log("Почтовый сервер упорно отказывает — останавливаюсь. Запусти позже, продолжу с этого места."); return summary(); }
          await sleep(10 * 60e3);
          continue;
        }
        mark.run(name, u.id, Date.now(), "fail: " + String(e.message).slice(0, 200)); fail++;
        console.log(`${now()} ✗ ${i + 1}/${list.length} ${u.email}: ${e.message}`);
        break;
      }
    }
    if (i < list.length - 1) await sleep(delay);
  }
  summary();
  function summary() { console.log(`Итог: отправлено ${ok}, не доставлено ${fail}.`); }
})().catch((e) => { console.log("Ошибка: " + e.message); process.exitCode = 1; });
