// vip.js — выдать / снять / посмотреть VIP вручную (пока нет оплаты).
//
//   node vip.js add почта 30     — VIP на 30 дней (если уже есть — продлит от его конца)
//   node vip.js off почта        — снять VIP
//   node vip.js list             — у кого VIP и до когда
//
// Кавычки не нужны. Игру перезапускать не надо: VIP подхватится со следующей партии
// (лимит и аватарки — сразу, глаз бога без замка — со следующей партии).

process.removeAllListeners("warning");   // не печатать «SQLite is experimental»
const auth = require("./auth");

const fmt = (ts) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(ts).replace(",", "");
const line = (u) => `${auth.isVip(u) ? "👑" : "  "} ${u.name} · ${u.email} · ${auth.isVip(u) ? "до " + fmt(u.vip_until) + " МСК" : "истёк " + fmt(u.vip_until)}`;

const [cmd, email, days] = process.argv.slice(2);
let r;
if (cmd === "add" && email && days) {
  r = auth.vipAdd(email, days);
  if (!r.error) console.log("Готово ✓\n" + line(r.user));
} else if (cmd === "off" && email) {
  r = auth.vipOff(email);
  if (!r.error) console.log(`Готово ✓ VIP снят: ${r.user.name} · ${r.user.email}`);
} else if (cmd === "list") {
  const all = auth.vipList();
  const act = all.filter(auth.isVip);
  console.log(`VIP действует: ${act.length}${all.length > act.length ? ` · истёк: ${all.length - act.length}` : ""}`);
  all.forEach((u) => console.log(line(u)));
  r = {};
} else {
  console.log("Как пользоваться:\n  node vip.js add почта 30\n  node vip.js off почта\n  node vip.js list");
  r = {};
}
if (r.error) { console.log("Ошибка: " + r.error); process.exitCode = 1; }
