// mail.js — письма игрокам: «подтверди почту» и «твой новый пароль».
//
// Отправляем через почтовый ящик на хостинге (noreply@iplaymafia.com). Настройки — только в ~/.env:
//   SMTP_HOST=mail.iplaymafia.com   SMTP_PORT=465   SMTP_USER=noreply@iplaymafia.com   SMTP_PASS=…
//   MAIL_FROM — от кого (по умолчанию «Мафия с ИИ» <SMTP_USER>)
//   SMTP_INSECURE=1 — не проверять сертификат почтового сервера (только если хостинг отдаёт сертификат на другое имя)
//
// Проверка с сервера:  node mail.js test почта     — пробное письмо
//                      node mail.js reset почта    — письмо с новым паролем (как по кнопке «Забыли пароль?»)

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch (_) { console.error("📧 не установлен nodemailer — на сервере: cd ~/mafia && npm install nodemailer"); return null; }
  const port = Number(process.env.SMTP_PORT || 465);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: process.env.SMTP_INSECURE === "1" ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  return transport;
}
const enabled = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const SITE = () => process.env.PUBLIC_URL || "https://iplaymafia.com";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Общая обёртка письма: бумажная карточка в стиле игры. Таблицы и стили в строке — так письмо одинаково в Gmail, Mail.ru и Яндексе.
function layout(title, bodyHtml) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#0f1424">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1424;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#f2efe6;border:3px solid #2c2c28">
<tr><td style="padding:22px 22px 6px;text-align:center;font-family:'Courier New',monospace;font-size:26px;font-weight:bold;letter-spacing:3px;color:#b5352c">МАФИЯ</td></tr>
<tr><td style="padding:6px 22px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#2c2c28">${bodyHtml}</td></tr>
<tr><td style="padding:12px 22px;border-top:2px dashed #e0dccd;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#7a7a70;text-align:center">
Мафия с ИИ · <a href="${SITE()}" style="color:#b5352c">iplaymafia.com</a><br>Письмо отправлено автоматически, отвечать на него не нужно.<br>
Вопросы — Telegram <a href="https://t.me/cecTpyxa" style="color:#b5352c">@cecTpyxa</a> или ebookee.app@gmail.com</td></tr>
</table></td></tr></table></body></html>`;
}
const button = (href, text) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px auto"><tr><td style="background:#b5352c;border:2px solid #2c2c28">
<a href="${href}" style="display:inline-block;padding:12px 26px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none">${text}</a></td></tr></table>`;

async function send(to, subject, html, text) {
  const t = getTransport();
  if (!t) throw new Error("почта не настроена (SMTP_* в ~/.env)");
  const from = process.env.MAIL_FROM || `"Мафия с ИИ" <${process.env.SMTP_USER}>`;
  const info = await t.sendMail({ from, to, subject, html, text });
  console.log(`📧 письмо «${subject}» → ${to}`);
  return info;
}

// ── 1. Подтверди почту ──
function sendVerify(user, link) {
  const subject = "Подтверди почту — и за стол 🕵️";
  const html = layout(subject, `
<p style="margin:0 0 12px">Привет, <b>${esc(user.name)}</b>!</p>
<p style="margin:0 0 12px">Первая партия сыграна — значит, ты уже знаешь: здесь врут все. Кроме этого письма 😉</p>
<p style="margin:0 0 4px">Подтверди, что почта твоя, — и играй дальше. На неё же придут чеки и пароль, если вдруг его забудешь.</p>
${button(link, "Подтвердить почту")}
<p style="margin:0;font-size:12px;color:#7a7a70">Кнопка не нажимается? Скопируй ссылку в браузер:<br><span style="word-break:break-all">${esc(link)}</span><br>Ссылка действует 7 дней. Не регистрировался — просто удали письмо.</p>`);
  const text = `Привет, ${user.name}!\n\nПодтверди почту, чтобы играть дальше:\n${link}\n\nСсылка действует 7 дней. Не регистрировался — просто удали письмо.\n\nМафия с ИИ · iplaymafia.com`;
  return send(user.email, subject, html, text);
}

// ── 2. Новый пароль ──
function sendNewPassword(user, password) {
  const subject = "Твой новый пароль в Мафии 🔑";
  const html = layout(subject, `
<p style="margin:0 0 12px">Привет, <b>${esc(user.name)}</b>!</p>
<p style="margin:0 0 4px">Кто-то (надеемся, ты) нажал «Забыли пароль?». Держи новый — запоминается с первого раза:</p>
<p style="margin:16px 0;text-align:center"><span style="display:inline-block;padding:12px 18px;background:#fff6dc;border:2px dashed #b8902f;font-family:'Courier New',monospace;font-size:22px;font-weight:bold;letter-spacing:1px;color:#2c2c28">${esc(password)}</span></p>
${button(SITE() + "/auth.html", "Войти в игру")}
<p style="margin:0 0 8px;font-size:13px">Пароль действует 24 часа. Войдёшь с ним — он станет твоим основным. Сменить на свой можно в ⚙️ Настройках.</p>
<p style="margin:0;font-size:12px;color:#7a7a70">Не просил новый пароль? Ничего не делай: старый пароль работает как прежде.</p>`);
  const text = `Привет, ${user.name}!\n\nТвой новый пароль: ${password}\n\nВойти: ${SITE()}/auth.html\nПароль действует 24 часа. Войдёшь с ним — он станет основным. Сменить можно в Настройках.\n\nНе просил новый пароль? Ничего не делай: старый работает как прежде.\n\nМафия с ИИ · iplaymafia.com`;
  return send(user.email, subject, html, text);
}

module.exports = { enabled, sendVerify, sendNewPassword, send };

// ── Запуск с сервера: node mail.js test почта | node mail.js reset почта ──
if (require.main === module) {
  process.removeAllListeners("warning");
  require("dotenv").config({ path: require("path").join(require("os").homedir(), ".env"), quiet: true });
  const [cmd, email] = process.argv.slice(2);
  (async () => {
    if (cmd === "test" && email) {
      await send(email, "Проверка почты Мафии ✅", layout("Проверка", `<p style="margin:0">Если ты это читаешь — письма из игры доходят. 🎉</p>`), "Если ты это читаешь — письма из игры доходят.");
      console.log("Готово ✓ Проверь входящие (и папку «Спам»).");
    } else if (cmd === "reset" && email) {
      const auth = require("./auth");
      const r = auth.issueTempPassword(email);
      if (!r) return console.log("Нет игрока с такой почтой: " + email);
      await sendNewPassword(r.user, r.password);
      console.log("Готово ✓ Письмо с новым паролем отправлено.");
    } else {
      console.log("Как пользоваться:\n  node mail.js test почта\n  node mail.js reset почта");
    }
  })().catch((e) => { console.log("Ошибка: " + e.message); process.exitCode = 1; });
}
