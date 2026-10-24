// pay.js — посмотреть платежи на сервере.
//
//   node pay.js list        — последние 30 платежей (кто, что, сколько, статус)
//   node pay.js list 100    — последние 100
//   node pay.js check номер — перепроверить платёж у ЮKassa и зачислить, если он оплачен, а VIP/щиты не пришли
//
// Кавычки не нужны. Игру перезапускать не надо.

process.removeAllListeners("warning");   // не печатать «SQLite is experimental»
require("dotenv").config({ path: require("path").join(require("os").homedir(), ".env"), quiet: true });
const payments = require("./payments");

const fmt = (ts) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ts).replace(",", "");
const ico = { succeeded: "✅", pending: "⏳", canceled: "✖" };

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list") {
    const rows = payments.list(Number(arg) || 30);
    const ok = rows.filter((r) => r.credited && !r.test);
    const sum = ok.reduce((s, r) => s + Number(r.amount), 0);
    console.log(`Платежей: ${rows.length} · оплачено по-настоящему: ${ok.length} на ${sum.toFixed(0)} ₽`);
    for (const r of rows) {
      const title = (payments.CATALOG[r.product] || {}).title || r.product;
      console.log(`${ico[r.status] || "?"} ${fmt(r.created)} · ${r.name || "?"} · ${r.email || "?"} · ${title} · ${Number(r.amount)} ₽${r.test ? " · тест" : ""}${r.status === "succeeded" && !r.credited ? " · НЕ ЗАЧИСЛЕН" : ""} · ${r.id}`);
    }
  } else if (cmd === "check" && arg) {
    const r = await payments.sync(arg);
    if (!r) console.log("Нет такого платежа в базе: " + arg);
    else console.log(`${ico[r.status] || "?"} ${r.id} · статус: ${r.status} · ${r.credited ? "зачислен ✓" : "не зачислен"}`);
  } else {
    console.log("Как пользоваться:\n  node pay.js list\n  node pay.js list 100\n  node pay.js check номер_платежа");
  }
})().catch((e) => { console.log("Ошибка: " + e.message); process.exitCode = 1; });
