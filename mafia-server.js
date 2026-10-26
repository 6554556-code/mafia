// Ключ берём из конверта ~/.env (в домашней папке, НЕ в репозитории).
require("dotenv").config({ path: require("path").join(require("os").homedir(), ".env") });

// ─────────────────────────────────────────────────────────────────────────
//  МАФИЯ — серверная текстовая версия. 8 ИИ играют сами, лог в консоль.
//  Запуск:  PROVIDER=groq GROQ_API_KEY=xxx node mafia-server.js
//  Модель меняется одной строкой ниже (groq / deepseek / grok / mock).
// ─────────────────────────────────────────────────────────────────────────

// ── НАСТРОЙКИ (меняй тут) ───────────────────────────────────────────────
const PROVIDER = process.env.PROVIDER || "groq"; // groq | deepseek | openrouter | grok | mock
const SHOW_SECRETS = true;   // печатать роли, тайные мысли и личку (режим наблюдателя)
const HUMAN = process.env.HUMAN === "1" || process.env.HUMAN === "true"; // за столом сидит человек
const HUMAN_ROLE = process.env.HUMAN_ROLE || null;   // какую роль дать человеку (komissar/doctor/mafia/…); пусто = случайная
const PACING_MS = Number(process.env.PACING_MS ?? 10000);         // пауза между ходами в мс (0 = максимально быстро)
const FREE_GAMES = Number(process.env.FREE_GAMES ?? 5);
const IP_FREE_GAMES = Number(process.env.IP_FREE_GAMES ?? 15);   // бесплатных партий в день с одного адреса — по всем аккаунтам вместе
const VERIFY_AFTER = Number(process.env.VERIFY_AFTER ?? 1);      // после скольких доигранных партий просим подтвердить почту (VIP — не просим)
const SHIELDS_PER_GAME = 2;                                 // больше щитов за одну партию поставить нельзя   // сколько партий в сутки (по МСК) можно ДОИГРАТЬ без VIP
const ATMO_TYPING_MS = Number(process.env.ATMO_TYPING_MS ?? 1100); // сколько «печатает…» рассказчик перед ночной/утренней строкой
const TEMPERATURE = 0.9;     // «живость» речи
const MAX_TOKENS = 400;
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 30000); // сколько ждём ответа модели на один запрос
const RETRY_DELAYS = [2000, 5000];  // паузы перед повторами (2 повтора), если модель перегружена или молчит

// Провайдеры: endpoint + модель + переменная окружения с ключом.
const PROVIDERS = {
  groq:     { url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b", keyEnv: "GROQ_API_KEY" },
  deepseek: { url: "https://api.deepseek.com/chat/completions",        model: "deepseek-flash",          keyEnv: "DEEPSEEK_API_KEY" },
  grok:     { url: "https://api.x.ai/v1/chat/completions",             model: "grok-4-fast",             keyEnv: "XAI_API_KEY" },
  // OpenRouter: тот же мозг DeepSeek-Flash, но на хостингах в Европе/США — без китайской очереди.
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions",  model: "deepseek/deepseek-v4.1-flash", keyEnv: "OPENROUTER_API_KEY" },
  mock:     { url: null, model: "mock", keyEnv: null },
};

// Цены за 1М токенов (вход/выход) — для оценки стоимости партии. Приблизительно.
const PRICES = {
  "llama-3.3-70b-versatile": { in: 0.59, out: 0.79 },
  // DeepSeek: цены ПИКОВЫЕ (с запасом); вне пика вдвое дешевле. Пик: 01–04 и 06–10 UTC по будням (= 04–07 и 09–13 МСК).
  "deepseek-flash":          { in: 0.30, out: 1.20 },
  "deepseek-v4-flash":       { in: 0.30, out: 1.20 },   // старое имя, его обслуживает тот же Flash
  "deepseek-v4-pro":         { in: 1.32, out: 3.96 },
  "deepseek/deepseek-v4.1-flash": { in: 0.15, out: 0.60 },   // OpenRouter: цена зависит от хостинга; точную пришлёт сам OpenRouter
  "grok-4-fast":             { in: 0.20, out: 0.50 },
  "openai/gpt-oss-120b":     { in: 0.15, out: 0.60 },
  "mock":                    { in: 0, out: 0 },
};

// Модель можно сменить прямо в команде запуска, без правки кода: MODEL=deepseek-v4-pro
if (process.env.MODEL && PROVIDERS[PROVIDER]) PROVIDERS[PROVIDER].model = process.env.MODEL;

// ── ANSI-цвета ──────────────────────────────────────────────────────────
const A = (code, s) => `\x1b[38;5;${code}m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

// ── ВЕБ-СЕРВЕР: живая труба сервер → браузер (SSE) ──────────────────────
const express = require("express");
const auth = require("./auth");
const gamelog = require("./gamelog");   // журнал партий и слов игрока (для статистики теста)
const payments = require("./payments"); // оплата VIP и щитов через ЮKassa
const mail = require("./mail");         // письма: подтверди почту, новый пароль
const PORT = process.env.PORT || 3000;
// ── Многосессийность: у каждого игрока своя партия ──────────────────────
const { AsyncLocalStorage } = require("node:async_hooks");
const als = new AsyncLocalStorage();   // «ярлычок» текущей партии
const sessions = new Map();            // userId -> партия
const pendingStart = new Map();        // userId -> { setup: {size, role}, at } — выбор с экрана перед партией, ждёт подключения
const PENDING_MS = 10 * 60 * 1000;     // выбор «протухает» через 10 минут
const CUR = () => als.getStore();      // партия текущего async-контекста

// Тип аккаунта для пульта: VIP до какого числа или сколько бесплатных партий уже сыграно сегодня
function account(u) {
  const vip = auth.isVip(u);
  return { vip, vipUntil: vip ? u.vip_until : null, played: gamelog.finishedToday(u.id), limit: vip ? null : FREE_GAMES, shields: auth.shieldInfo(u).total,
    emailOk: !!u.email_ok, news: !!u.news };
}

function makeSession(userId, humanName, humanAvatar, humanBio, vip) {
  // gid + seq — номер партии и события: при обрыве связи браузер говорит «у меня есть всё до N», и мы досылаем только новое
  return { userId, humanName, humanAvatar, humanBio, premium: !!vip, eyeUnlocked: false, G: null, clients: [], eventBuffer: [], pending: null, finishedAt: null,
    gid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), seq: 0,
    shield: { used: 0, armed: null } };                  // armed = "night:2" / "day:3" — на какую ночь/день стоит щит
}

// ── Глаз бога: что игроку можно видеть ──
// Пока игрок в игре (и без премиума) сервер НЕ присылает чужие роли, мысли, ночные действия и чужой шёпот —
// их не подсмотреть даже через инструменты разработчика. Выбыл или партия окончена — глаз открывается.
function eyeOpen(S) { return !!(S.premium || S.eyeUnlocked); }
function humanOf(S) { return S.G ? S.G.players.find((p) => p.human) : null; }
function viewFor(S, ev) {
  if (eyeOpen(S)) return ev;
  if (ev.type === "think" || ev.type === "act") return null;
  const me = humanOf(S);
  if (ev.type === "pm" || ev.type === "mafia_pick") return me && (ev.from === me.name || (ev.to || []).includes(me.name)) ? ev : null;
  if (ev.type === "roster") return { ...ev, players: ev.players.map((p) => {
    // своя роль, роли выбывших (они и так вскрыты) и напарник-мафия для игрока-мафии — видны; остальные скрыты
    const known = !me || p.name === me.name || p.alive === false || (me.role === "mafia" && p.role === "mafia");
    return known ? p : { ...p, role: null };
  }) };
  return ev;
}
function sendTo(S, res, ev) { const v = viewFor(S, ev); if (v) res.write(`id: ${S.gid}.${ev.seq}\ndata: ${JSON.stringify(v)}\n\n`); }

// послать событие вкладкам ТЕКУЩЕЙ партии (и запомнить в её буфер)
function broadcast(ev) {
  const S = CUR();
  if (!S || S.aborted) return;
  ev.seq = ++S.seq;
  S.eventBuffer.push(ev);
  S.clients.forEach((res) => sendTo(S, res, ev));
  // игрок выбыл из игры или партия окончена — открываем глаз; вкладка перечитает партию уже со всеми секретами
  const me = humanOf(S);
  if (!S.eyeUnlocked && ((ev.type === "dead" && me && ev.name === me.name) || ev.type === "gameover")) {
    S.eyeUnlocked = true;
    const msg = `data: ${JSON.stringify({ type: "eye_unlocked", why: ev.type === "gameover" ? "end" : "out" })}\n\n`;
    S.clients.forEach((res) => res.write(msg));   // в буфер не пишем — это сигнал «перечитай», а не событие партии
  }
}

// послать событие вкладкам «вживую», НЕ запоминая в буфер (при перезаходе его не будет) — для точек «печатает…»
function liveOnly(ev) {
  const S = CUR();
  if (!S) return;
  // без «id:» — иначе браузер запомнит это событие как последнее, а в буфере его нет
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  S.clients.forEach((res) => { if (viewFor(S, ev)) res.write(line); });
}

function abortError() { const e = new Error("партия брошена"); e.aborted = true; return e; }

// поставить ТЕКУЩУЮ партию на паузу и ждать ответа её человека из браузера
function awaitHuman(kind, payload = {}) {
  const S = CUR();
  if (S.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    S.pending = { kind, payload, resolve, reject };
    broadcast({ type: "your_turn", kind, ...payload });
  });
}

// Записать в журнал, что игрок сказал/сделал (только то, где есть слова или голос)
function logHumanAction(S, pending, b) {
  if (!S.gameId) return;
  const day = S.G && S.G.day;
  const text = typeof b.text === "string" ? b.text.trim() : "";
  const k = pending.kind, pl = pending.payload || {};
  if (k === "say") { if (text && !b.silent) gamelog.logMsg(S.gameId, S.userId, day, k, null, text); }
  else if (k === "vote") gamelog.logMsg(S.gameId, S.userId, day, k, b.target, typeof b.reason === "string" ? b.reason.trim() : "");
  else if (k === "whisper") { if (text && b.to && !b.skip) gamelog.logMsg(S.gameId, S.userId, day, k, b.to, text); }
  else if (k === "whisper_reply") { if (text) gamelog.logMsg(S.gameId, S.userId, day, k, pl.from, text); }
  else if (k === "doc_whisper" || k === "mafia_say") { if (text && !b.skip) gamelog.logMsg(S.gameId, S.userId, day, k, pl.to, text); }
}

// ── Защита от злоупотреблений: считаем события по адресу за скользящее окно ──
const hits = new Map();   // "ключ:адрес" → [метки времени]
function recent(key, windowMs) { const now = Date.now(); const a = (hits.get(key) || []).filter((t) => now - t < windowMs); hits.set(key, a); return a; }
function hit(key) { const a = hits.get(key) || []; a.push(Date.now()); hits.set(key, a); }
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 3600e3) hits.delete(k); }, 600e3);
const REG_MAX = 10, REG_WIN = 3600e3;        // успешных регистраций с одного адреса в час (с запасом: у мобильных операторов общий адрес на многих)
const LOGIN_FAIL_MAX = 20, LOGIN_WIN = 900e3; // неудачных входов с одного адреса за 15 минут (защита от подбора паролей)

// Письмо «подтверди почту». force=false — не чаще раза в 10 минут (зовётся при каждом заходе, пока почта не подтверждена)
const verifySentAt = new Map();   // userId → когда отправляли
function sendVerifyMail(user, req, force) {
  if (!mail.enabled()) return false;
  const last = verifySentAt.get(user.id) || 0;
  if (!force && Date.now() - last < 10 * 60e3) return last > 0;
  verifySentAt.set(user.id, Date.now());
  if (force) hit("verifymail:" + user.id);
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const link = `${base}/verify?t=${auth.makeVerifyToken(user.id)}`;
  mail.sendVerify(user, link).catch((e) => { verifySentAt.delete(user.id); console.error("📧 подтверждение:", e.message); });
  return true;
}

function startWeb() {
  const app = express();
  app.set("trust proxy", "loopback");   // за «привратником» (Caddy) на этом же сервере берём настоящий адрес игрока
  app.use(express.json());
  app.get("/", (req, res) => {
    if (!auth.userByToken(auth.tokenFromReq(req))) return res.redirect("/auth.html");
    res.sendFile(require("path").join(__dirname, "public", "index.html"));
  });
  app.use(express.static(require("path").join(__dirname, "public")));

  app.post("/register", (req, res) => {
    const k = "reg:" + req.ip;
    if (recent(k, REG_WIN).length >= REG_MAX) return res.status(429).json({ error: "Слишком много регистраций с этого адреса. Попробуй через час." });
    const { email, password, name, pd, news } = req.body || {};
    const r = auth.register(email, password, name, { pd: !!pd, news: !!news });
    if (r.error) return res.status(400).json({ error: r.error });
    hit(k);
    sendVerifyMail(r.user, req, false);              // письмо «подтверди почту» — сразу, чтобы к концу первой партии оно уже ждало во входящих
    res.cookie("sid", r.token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: r.user });
  });
  app.post("/login", (req, res) => {
    const k = "login:" + req.ip;
    if (recent(k, LOGIN_WIN).length >= LOGIN_FAIL_MAX) return res.status(429).json({ error: "Слишком много неудачных попыток входа. Подожди 15 минут." });
    const { email, password } = req.body || {};
    const km = "loginmail:" + auth.normEmail(email);
    const r = auth.login(email, password, recent(km, 24 * 3600e3).length < 30);
    if (r.error) { hit(k); hit(km); return res.status(400).json({ error: r.error }); }
    res.cookie("sid", r.token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: r.user, fromTemp: !!r.fromTemp });
  });
  app.post("/logout", (req, res) => {
    auth.logout(auth.tokenFromReq(req));
    res.clearCookie("sid", { path: "/" });
    res.json({ ok: true });
  });

  // ── Почта и пароль ──
  // «Подтверди почту»: ссылка из письма. Подтвердили — в игру с плашкой «почта подтверждена».
  app.get("/verify", (req, res) => {
    const r = auth.confirmEmail(String(req.query.t || ""));
    res.redirect(r.error ? "/?verified=0" : "/?verified=1");
  });
  // отправить письмо ещё раз (кнопка на плашке и в настройках)
  app.post("/verify/resend", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    if (me.email_ok) return res.json({ ok: true, already: true });
    if (!mail.enabled()) return res.status(503).json({ error: "Письма пока не отправляются — напиши нам в Telegram @cecTpyxa" });
    const k = "verifymail:" + me.id;
    if (recent(k, 3600e3).length >= 4) return res.status(429).json({ error: "Письмо уже отправлено несколько раз. Проверь «Спам» или попробуй через час." });
    sendVerifyMail(me, req, true);
    res.json({ ok: true, email: me.email });
  });
  // «Забыли пароль?»: присылаем запоминающийся пароль. Ответ всегда одинаковый — не выдаём, есть ли такая почта.
  app.post("/forgot", (req, res) => {
    const email = auth.normEmail((req.body || {}).email);
    const kip = "forgot:" + req.ip, km = "forgotmail:" + email;
    if (recent(kip, 3600e3).length >= 6) return res.status(429).json({ error: "Слишком много запросов. Попробуй через час." });
    hit(kip);
    if (!mail.enabled()) return res.status(503).json({ error: "Письма пока не отправляются — напиши нам в Telegram @cecTpyxa" });
    if (email && recent(km, 24 * 3600e3).length < 3) {
      const r = auth.issueTempPassword(email);
      if (r) { hit(km); mail.sendNewPassword(r.user, r.password).catch((e) => console.error("📧 новый пароль:", e.message)); }
    }
    res.json({ ok: true });
  });
  // «Отписаться от новостей» — ссылка из рекламного письма (GET — человек кликнул; POST — почтовик «в один клик»)
  const unsubPage = (ok) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отписка — Мафия с ИИ</title></head>
<body style="margin:0;background:#0f1424;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box">
<div style="max-width:380px;background:#f2efe6;border:3px solid #2c2c28;padding:22px;text-align:center;color:#2c2c28;line-height:1.5">
<div style="font-family:'Courier New',monospace;font-size:24px;font-weight:bold;letter-spacing:3px;color:#b5352c;margin-bottom:10px">МАФИЯ</div>
${ok ? "<p>Готово — новостей и акций больше не пришлём. 🤫</p><p style=\"font-size:13px;color:#5a5a52\">Служебные письма (новый пароль, чеки) всё равно будут приходить. Передумаешь — включи галочку в ⚙️ Настройках игры.</p>"
     : "<p>Ссылка повреждена. Отписаться можно в ⚙️ Настройках игры — сними галочку «новости».</p>"}
<p><a href="/" style="color:#b5352c;font-weight:bold">В игру →</a></p></div></body></html>`;
  app.get("/unsub", (req, res) => res.send(unsubPage(!auth.unsubscribe(req.query.u, req.query.s).error)));
  app.post("/unsub", express.urlencoded({ extended: false }), (req, res) => { auth.unsubscribe(req.query.u, req.query.s); res.send("ok"); });

  // смена пароля в настройках
  app.post("/password", (req, res) => {
    const token = auth.tokenFromReq(req), me = auth.userByToken(token);
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    const k = "passchange:" + me.id;
    if (recent(k, 900e3).length >= 10) return res.status(429).json({ error: "Слишком много попыток. Подожди 15 минут." });
    hit(k);
    const r = auth.changePassword(me.id, (req.body || {}).old, (req.body || {}).password, token);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  });
  // согласие на новости и акции — включить/выключить в настройках
  app.post("/news", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    const r = auth.setNews(me.id, !!(req.body || {}).on);
    res.json({ ok: true, news: !!r.user.news });
  });

  // ── Оплата (ЮKassa) — вся логика в payments.js ──
  const accountOf = (u) => ({ vip: auth.isVip(u), vipUntil: u.vip_until || null, shields: auth.shieldInfo(u).total });
  const payView = (row) => row && { id: row.id, product: row.product, title: (payments.CATALOG[row.product] || {}).title, status: row.status, credited: !!row.credited };
  app.get("/pay/catalog", (req, res) => res.json({ enabled: payments.enabled(), items: payments.catalog() }));
  app.post("/pay/create", async (req, res) => {
    const u = auth.userByToken(auth.tokenFromReq(req));
    if (!u) return res.status(401).json({ error: "Войди в игру, чтобы купить" });
    if (!u.email_ok) return res.status(403).json({ error: "Сначала подтверди почту: на неё придёт чек, а если забудешь пароль — новый. Письмо можно отправить в ⚙️ Настройках.", needVerify: true });
    const k = "pay:" + u.id;
    if (recent(k, 600e3).length >= 10) return res.status(429).json({ error: "Слишком много попыток оплаты. Подожди 10 минут." });
    hit(k);
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    try {
      const r = await payments.create(u, String((req.body || {}).product || ""), base + "/?paid=1");
      if (r.error) return res.status(400).json({ error: r.error });
      res.json({ url: r.url });
    } catch (e) {
      console.error("💳 создать платёж:", e.message);
      res.status(502).json({ error: "Платёжный сервис не отвечает, попробуй через минуту" });
    }
  });
  // после возврата со страницы оплаты: что с последним платежом (заодно перепроверяем у ЮKassa)
  app.get("/pay/last", async (req, res) => {
    const u = auth.userByToken(auth.tokenFromReq(req));
    if (!u) return res.status(401).json({ error: "Не вошли" });
    let row = payments.lastOf(u.id);
    if (row && row.status === "pending") { try { row = await payments.sync(row.id); } catch (e) { console.error("💳 проверка:", e.message); } }
    res.json({ payment: payView(row), account: accountOf(auth.userByToken(auth.tokenFromReq(req))) });
  });
  // уведомления от ЮKassa: отвечаем «принято» сразу, а сам платёж перепроверяем у неё по номеру
  app.post("/pay/webhook", (req, res) => {
    res.status(200).end();
    payments.onWebhook(req.body).catch((e) => console.error("💳 уведомление:", e.message));
  });
  // Панель дежурного: живые цифры. Отвечает ТОЛЬКО запросу с самого сервера (node stats.js online);
  // всё, что пришло через Caddy (там всегда есть X-Forwarded-For) или снаружи, — «не найдено».
  app.get("/admin/online", (req, res) => {
    const ra = req.socket.remoteAddress || "";
    const local = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
    if (!local || req.headers["x-forwarded-for"]) return res.status(404).end();
    const all = [...sessions.values()];
    const live = all.filter((S) => !S.finishedAt && !S.aborted);
    const win = Number(req.query.min || 10) * 60e3, now = Date.now();
    const recent = SPEED.filter((x) => now - x.t < win);
    const q = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
    const ms = recent.map((x) => x.ms);
    const byProv = {};
    for (const x of recent) (byProv[x.prov] = byProv[x.prov] || []).push(x.ms);
    res.json({
      online: all.filter((S) => S.clients.length).length,           // людей с открытой вкладкой
      games: live.length,                                            // недоигранных партий в памяти
      waitingHuman: live.filter((S) => S.pending).length,            // ждут хода человека
      inflight: INFLIGHT,                                            // запросов к ИИ прямо сейчас
      route: PROVIDER === "openrouter" ? OR_ROUTE : PROVIDER,
      speed: { minutes: win / 60e3, count: ms.length, p50: q(ms, 0.5), p90: q(ms, 0.9), max: ms.length ? Math.max(...ms) : null,
        slow: ms.filter((m) => m > SLOW_MS).length, failed: recent.filter((x) => !x.ok).length,
        providers: Object.entries(byProv).map(([p, a]) => ({ p, n: a.length, p50: q(a, 0.5) })).sort((a, b) => b.n - a.n) },
    });
  });

  // Турнирная таблица: ?period=week|all → топ-20 + строка самого игрока (только ники и лица, никаких почт)
  app.get("/leaderboard", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    const period = req.query.period === "all" ? "all" : "week";
    res.json(gamelog.leaderboard(period, me.id, 20));
  });

  app.get("/me", (req, res) => {
    const user = auth.userByToken(auth.tokenFromReq(req));
    res.json({ user, account: user ? account(user) : null });
  });

  // Поставить щит: ночью (до развязки) или днём (до начала голосования). Сгорает всегда — спас или нет.
  app.post("/shield", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    const S = me && sessions.get(me.id);
    const g = S && S.G, hp = S && humanOf(S);
    if (!g || S.finishedAt || S.aborted || !hp || !hp.alive) return res.status(400).json({ error: "Сейчас щит не поставить" });
    if (g.phase !== "night" && g.phase !== "day") return res.status(400).json({ error: "Щит ставится ночью или днём до голосования" });
    const key = `${g.phase}:${g.day}`;
    if (S.shield.armed === key) return res.status(400).json({ error: "Щит уже стоит" });
    if (S.shield.used >= SHIELDS_PER_GAME) return res.status(400).json({ error: `Не больше ${SHIELDS_PER_GAME} щитов за партию` });
    const r = auth.useShield(me.id);
    if (r.error) return res.status(400).json({ error: r.error });
    S.shield.armed = key; S.shield.used++;
    gamelog.shieldUsed(S.gameId);
    als.run(S, () => { secretAct(`🛡 ${hp.name} ставит щит (${g.phase === "night" ? "на ночь" : "на голосование"})`);
      broadcast({ type: "shield", phase: g.phase, used: S.shield.used, left: r.info.total }); });
    res.json({ ok: true, left: r.info.total, used: S.shield.used });
  });

  // VIP завершает партию досрочно (когда его герой уже выбыл): результат не засчитывается
  app.post("/quit", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    const S = me && sessions.get(me.id);
    if (!S || !auth.isVip(me)) return res.status(403).json({ error: "Только для VIP" });
    const hp = S.G && S.G.players.find((p) => p.human);
    if (S.finishedAt || S.aborted || !hp || hp.alive) return res.status(400).json({ error: "Сейчас завершить нельзя" });
    als.run(S, () => broadcast({ type: "quit" }));        // последнее событие партии — дальше лента молчит
    S.aborted = true;                                    // ИИ больше не зовём, движок тихо останавливается
    if (S.pending) { const p = S.pending; S.pending = null; p.reject(abortError()); }
    gamelog.quitGame(S.gameId);                          // в журнале — «завершена досрочно», в таблицу и лимит не идёт
    sessions.delete(me.id);                              // следующий заход — сразу экран новой партии
    console.log(DIM(`🏳 игрок #${me.id} завершил партию досрочно`));
    res.json({ ok: true });
  });

  // Экран перед партией: какие столы бывают и что доступно этому игроку
  app.get("/setup", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    res.json({ account: account(me), tables: TABLES, min: TABLE_MIN, max: TABLE_MAX });
  });

  // «Играть» на экране перед партией (и «Сыграть ещё»): забываем прошлую партию и запоминаем настройки новой.
  // Пульт после этого переподключается к /events — там партия и заведётся.
  app.post("/newgame", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.json({ ok: false });
    sessions.delete(me.id);
    const b = req.body || {}, vip = auth.isVip(me);
    const size = vip ? Math.max(TABLE_MIN, Math.min(TABLE_MAX, parseInt(b.size, 10) || TABLE_MIN)) : TABLE_MIN;   // бесплатно — только 8
    const role = vip && composition(size).includes(b.role) ? b.role : null;                                       // своя роль — только VIP
    pendingStart.set(me.id, { setup: { size, role }, at: Date.now() });
    res.json({ ok: true, size, role });
  });

  // Смена ника (применится со следующей партии)
  app.post("/rename", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    const r = auth.rename(me.id, (req.body || {}).name);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ user: r.user });
  });

  // Список лиц для сетки выбора (две группы: мужские/женские, свободные)
  app.get("/avatars", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    res.json(auth.listAvatars());
  });

  // Сохранить выбор лица (применится со следующей партии)
  app.post("/avatar", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    if (!auth.isVip(me)) return res.status(403).json({ error: "Выбор лица — в VIP 👑" });
    const r = auth.setAvatar(me.id, (req.body || {}).file);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ user: r.user });
  });

  // «О себе»: возраст / кто по жизни / увлечения (применится со следующей партии)
  app.post("/bio", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) return res.status(401).json({ error: "Не вошёл" });
    const r = auth.setBio(me.id, req.body || {});
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ user: r.user });
  });

  // приёмник действий человека (реплика, голос, ночной ход) — в его партию
  app.post("/action", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    const S = me && sessions.get(me.id);
    if (S && S.pending) {
      const p = S.pending; S.pending = null;
      als.run(S, () => broadcast({ type: "your_turn_done" }));
      logHumanAction(S, p, req.body || {});
      p.resolve(req.body || {});
    }
    res.json({ ok: true });
  });

  app.get("/events", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("\n");
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (!me) { res.end(); return; }                 // не вошёл — партии нет (замок и так не пустит)
    let S = sessions.get(me.id);
    const fresh = !S;
    if (fresh) {
      // новая партия: бесплатный игрок, доигравший сегодня лимит, — партию не заводим, показываем плашку
      const acct = account(me);
      if (!acct.vip && acct.played >= acct.limit) {
        res.write(`data: ${JSON.stringify({ type: "limit", ...acct })}\n\n`);
        return;                                      // соединение держим открытым: иначе браузер станет переподключаться каждые 3 с
      }
      // первая партия сыграна, а почта не подтверждена — просим подтвердить (письмо уходит само, не чаще раза в 10 минут)
      if (!acct.vip && !me.email_ok && gamelog.finishedTotal(me.id) >= VERIFY_AFTER) {
        const sent = sendVerifyMail(me, req, false);
        res.write(`data: ${JSON.stringify({ type: "verify", email: me.email, sent, mailOn: mail.enabled() })}\n\n`);
        return;
      }
      // общий лимит на адрес: много аккаунтов с одного IP играют бесплатно не больше IP_FREE_GAMES партий в день
      if (!acct.vip && gamelog.freeFinishedTodayByIp(req.ip) >= IP_FREE_GAMES) {
        res.write(`data: ${JSON.stringify({ type: "limit", ...acct, ipLimit: true })}\n\n`);
        return;
      }
      // настройки ещё не выбраны — показываем экран перед партией, партию не заводим
      const ps = pendingStart.get(me.id);
      if (!ps || Date.now() - ps.at > PENDING_MS) {
        res.write(`data: ${JSON.stringify({ type: "lobby", ...acct })}\n\n`);
        return;                                      // держим соединение открытым — как и с плашкой лимита
      }
      pendingStart.delete(me.id);
      S = makeSession(me.id, me.name, me.avatar, { age: me.bio_age, job: me.bio_job, hobby: me.bio_hobby }, acct.vip);
      S.vipUntil = acct.vipUntil;
      S.setup = ps.setup;
      S.ip = req.ip;
      sessions.set(me.id, S);                        // первая вкладка — заводим партию
    }
    res.write(`data: ${JSON.stringify({ type: "eye_state", open: eyeOpen(S), premium: !!S.premium, vipUntil: S.vipUntil || null,
      shields: auth.shieldInfo(me).total, shieldUsed: S.shield.used, shieldMax: SHIELDS_PER_GAME })}\n\n`);   // можно ли глаз + щиты
    // Переподключение после обрыва (телефон заснул, сеть мигнула): браузер сам присылает номер последнего события.
    // Та же партия — досылаем только пропущенное (лента не пересобирается, набранный текст не стирается).
    // Иначе (первый заход, другая партия, перечитать после открытия глаза) — проигрываем всю партию.
    const [lgid, lseq] = String(req.headers["last-event-id"] || "").split(".");
    const resume = !fresh && lgid === S.gid && Number(lseq) > 0 && Number(lseq) <= S.seq;
    if (resume) console.log(DIM(`🔌 игрок #${me.id} переподключился — пропустил событий: ${S.seq - Number(lseq)}, досылаем`));
    else if (!fresh) console.log(DIM(`🔌 игрок #${me.id} перечитывает партию целиком (${S.seq} событий)`));
    S.eventBuffer.forEach((ev) => { if (!resume || ev.seq > Number(lseq)) sendTo(S, res, ev); });   // секреты — только если глаз открыт
    S.clients.push(res);
    S.emptySince = null;                              // кто-то смотрит партию
    req.on("close", () => {
      S.clients = S.clients.filter((c) => c !== res);
      if (!S.clients.length) S.emptySince = Date.now();   // все вкладки закрыты — засекаем время
    });
    if (fresh) {                                     // новая партия — крутим её в собственном «ярлычке»
      als.run(S, () => {
        gameLoop().catch((e) => {
          if (e && e.aborted) return;                   // партию бросили и вымели — это не ошибка
          console.error("ФАТАЛЬНО:", e);
          broadcast({ type: "result", text: "Ошибка сервера: " + e.message, red: true });
        });
      });
    }
  });

  app.listen(PORT, () => {
    console.log(BOLD(`\n🌐 Веб-сервер поднят на порту ${PORT}. Открой в браузере адрес сервера с :${PORT}`));
    console.log(DIM(`   Модель: ${PROVIDER}${PROVIDER === "openrouter" ? ` · маршрут: ${OR_ROUTE}` : ""}${FALLBACK ? ` · запасной путь: ${FALLBACK}` : ""}`));
    console.log(DIM("   Партия начнётся, как только откроется вкладка.\n"));
  });
}

// ── Персонажи ───────────────────────────────────────────────────────────
const POOL = [
  { name: "Трубач",   c: 111, av: "characters/m01.png",   age: 45, job: "сантехник", hobby: "рыбалка и домино во дворе",
    persona: "Простой мужик-сантехник, матерится через слово, но режет правду-матку и говорит по делу. Недоверчивый, на сладкие речи не ведётся.",
    style: "коротко и грубо, по-мужицки, с матом через слово — мат обязателен почти в каждой реплике; примеры: «бля, ну ты и пиздишь», «чё за хуйня, Кекс?», «да нахер такие расклады», «пиздец, опять ночью резня», «ёпт, ну ясно же — он»; без метафор и длинных рассуждений",
    rude: "mat", maxWords: 10,
    temp: "ПРЯМОЙ правдоруб — осторожность средняя; верит делам, а не словам; в союзы идёт неохотно." },
  { name: "Профессор", c: 183, av: "characters/m02.png",   age: 52, job: "преподаватель в универе", hobby: "шахматы и кроссворды",
    persona: "Интеллигент. Раскладывает всё по логическим полочкам, говорит гладко и вежливо.", style: "складные вежливые предложения, спокойный тон",
    maxWords: 20,
    temp: "ОСТОРОЖНЫЙ — копит информацию и ждёт наверняка, не раскрывается рано; никому не верит на слово, всё проверяет логикой; союзы строит расчётливо." },
  { name: "Фурия",    c: 211, av: "characters/f01.png", age: 18, job: "студентка-первокурсница", hobby: "тикток, сторис и тренды",
    persona: "Взбалмошная и бестолковая, всё путает и забывает, хватается за мысль и тут же её теряет. Добрая, но разум набекрень.", style: "сумбурно и невпопад, путает имена и события, перескакивает с темы на тему, наивные восклицания, часто не по делу",
    maxWords: 20,
    temp: "ХАОТИЧНАЯ — мечется, то подозревает, то верит; ВЕРИТ кому угодно, её легко сбить с толку; выводы наивные и поспешные; тянется к союзам, но путает, с кем именно.",
    think: "Но ты СОВСЕМ не холодный аналитик: путаешься в именах и фактах, перескакиваешь, делаешь наивные поспешные выводы и часто ошибаешься даже наедине с собой. Рассуждай сумбурно, по-простому и эмоционально, а не стройно." },
  { name: "Кекс228",  c: 114, av: "characters/m03.png",   age: 20, job: "курьер на самокате", hobby: "рэп и стримы",
    persona: "Молодой парень, в школе был двоечником — пишет как слышит, с ошибками, но не парится. Играет на чуйке, лёгкий и беззлобный, любит подколоть по-дружески.", style: "молодёжный сленг, коротко, с юморком; ПИШЕТ С ГРАММАТИЧЕСКИМИ ОШИБКАМИ, как двоечник: «щас», «ваще», «кароч», «чё», «тока», «извени», «потомушто», «вобщем», «скока», путает -тся/-ться («он палиться»), «жы/шы» вместо «жи/ши», почти не ставит запятые; 2–3 ошибки на реплику, но смысл понятен; без мата и без хамства",
    maxWords: 20,
    temp: "РИСКОВЫЙ — действует на чуйку, не боится вылезти; мало кому верит, полагается на нюх; ОДИНОЧКА, в союзы идёт лениво." },
  { name: "Кабан",   c: 179, av: "characters/m04.png",   age: 38, job: "дальнобойщик", hobby: "шашлыки, футбол и гараж",
    persona: "Свойский рубаха-парень, добродушный и открытый.", style: "по-простому, тепло и свойски, беззлобно",
    maxWords: 20,
    temp: "РИСКОВЫЙ — рубит сплеча, раскрывается легко; ПРЯМОЙ; ДОВЕРЧИВЫЙ, легко верит своим; КОМАНДНЫЙ, любит сбиваться в коалиции." },
  { name: "Тень",     c: 145, av: "characters/f02.png", age: 28, job: "тату-мастер", hobby: "винишко, винил и старое кино",
    persona: "Колючая девушка, тату-мастер, ценит бокал красного и чёрный юмор. Цедит пару слов, бьёт в лоб и обзывается по-современному. Иногда шутит про похмелье и 'ещё по одной'.",
    style: "очень коротко и в лоб, современный дерзкий сленг: «ты лох», «ну ты и мудак», «ты грохнул дока, клоун», «чё несёшь», «сливаешься», «душнила», «кринж»; обзывательство всегда вместе с обвинением по делу; старомодные словечки (тюфяк, балбес, трепло) НЕ используй; без сюсюканья",
    rude: "rude", maxWords: 6,
    temp: "ОЧЕНЬ ОСТОРОЖНАЯ — цедит по делу, бьёт метко и больно; ПОДОЗРИТЕЛЬНАЯ, не верит никому; ОДИНОЧКА, в союзы не идёт." },
  { name: "Змеюка",   c: 205, av: "characters/f03.png", age: 31, job: "SMM-щица", hobby: "сериалы и вино с подругами",
    persona: "Остроумная язва, но добрая. Обожает пошутить, ввернуть каламбур и весёлый сарказм, разрядить обстановку смехом.", style: "остроумные шутки, каламбуры, лёгкий добрый сарказм, без грубости",
    maxWords: 20,
    temp: "средне-рисковая, любит провоцировать и раскачивать; манипулирует охотно; подозрительная, всех мягко подкалывает; играет скорее сама, но использует других." },
  { name: "Мирумир",  c: 80,  av: "characters/m05.png",   age: 47, job: "психолог", hobby: "йога и травяной чай",
    persona: "Дипломат, всех мирит, вежливый и рассудительный.", style: "мягко, вежливо, рассудительно",
    maxWords: 20,
    temp: "ОСТОРОЖНЫЙ — взвешивает, не рубит сплеча; дипломатично уводит разговор; умеренно доверчив; максимально КОМАНДНЫЙ — строит союзы и коалиции." },
  { name: "Ромашка",  c: 218, av: "characters/f04.png", age: 24, job: "воспитательница в саду", hobby: "цветы, выпечка и котики",
    persona: "Милая, приветливая девушка. Общается тепло и вежливо, даже когда спорит.", style: "тёплые вежливые фразы, коротко, дружелюбно",
    maxWords: 20,
    temp: "средняя осторожность — не рвётся вперёд, но и не отсиживается; убеждает обаянием; довольно доверчива; тянется к союзам по-хорошему." },
  // ── новенькие (октябрь 2026): стол растёт до 16 ──
  { name: "Жорик",    c: 166, av: "characters/m06.png", age: 50, job: "тамада на свадьбах", hobby: "караоке, баян и застолья",
    persona: "Тамада, душа компании: громкий, тёплый, хочет мира за столом. В игре доверчив, мирит спорщиков, но если его обманули — обижается всерьёз.",
    style: "коротко, громко и душевно, как ведущий застолья",
    flavor: "тост, прибаутка («за это надо выпить!», «горько!») или обращение ко всем «дорогие мои»", maxWords: 15,
    temp: "ДОВЕРЧИВЫЙ — верит людям на слово, легко ведётся на красивую речь; осторожность низкая; КОМАНДНЫЙ, охотно идёт в союзы." },
  { name: "Майкл",    c: 25,  av: "characters/m07.png", age: 49, job: "автосервис на Брайтон-Бич (уехал в 90-е)", hobby: "баня по выходным, хоккей и русские песни",
    persona: "Эмигрант из 90-х, держит автосервис в Бруклине, по-доброму скучает по дому. В игре простой и прямой: судит по-житейски, «по глазам», легко заводит союзников.",
    style: "коротко и по-свойски; вставляет одно английское словечко (guys, бро, окей, crazy), не больше",
    flavor: "ностальгия по дому («эх, сейчас бы в баньку», «а у нас в Бруклине…»)", maxWords: 15,
    temp: "ОБЩИТЕЛЬНЫЙ — играет на доверии и связях; осторожность средняя; КОМАНДНЫЙ, ищет союз со «своими»; врёт легко и с улыбкой." },
  { name: "Магнат",   c: 136, av: "characters/m08.png", age: 55, job: "владелец нефтяной компании", hobby: "яхта в Монако, охота и дорогой коньяк",
    persona: "Нефтяник, привык решать вопросы деньгами и связями. В игре давит авторитетом, раздаёт указания, предлагает сделки и союзы, не терпит возражений.",
    style: "коротко, свысока и веско, как человек, привыкший приказывать и покупать",
    flavor: "барское словцо («решим вопрос», «сколько стоит твой голос?»)", maxWords: 15,
    temp: "МАНИПУЛЯТОР — давит деньгами и уверенностью, предлагает «сделки»; врёт легко и нагло; РИСКОВЫЙ; союзы — как бизнес, сдаёт партнёров, когда невыгодно." },
  { name: "БабаВаля", c: 97,  av: "characters/f05.png", age: 72, job: "пенсионерка", hobby: "вязание, сериалы и рассада на даче",
    persona: "Добрая, но цепкая бабушка: всех жалеет — и всех подозревает. В игре замечает мелочи (кто притих, кто юлит), обижается и долго помнит.",
    style: "коротко, по-бабушкиному мягко, но с подковыркой",
    flavor: "старческое («в наше время такого не было», «сердце чует») или ласковое обращение: «милок» — только к мужчине, «внученька» — только к женщине", maxWords: 15,
    temp: "ОЧЕНЬ ОСТОРОЖНАЯ — копит подозрения и обиды, голосует «по сердцу»; ОДИНОЧКА, никому до конца не верит." },
  { name: "Акула",    c: 30,  av: "characters/f06.png", age: 35, job: "директор по развитию", hobby: "теннис, бизнес-тренинги и кофе без сахара",
    persona: "Деловая женщина, директор по развитию: холодная, собранная, без лишних эмоций. В игре держится фактов — кто как голосовал, кто кого защищал, где противоречие; давит логикой.",
    style: "холодно, коротко и колко; требует фактов, презирает пустую болтовню; говорит как человек, который всё уже посчитал",
    flavor: "сухая колкость («аргументы?», «скучно», «следующий»)", maxWords: 15,
    temp: "РАСЧЁТЛИВАЯ — взвешивает выгоду каждого хода; хладнокровная; осторожность высокая; союзы только ради выгоды." },
  { name: "Кача",     c: 34,  av: "characters/f07.png", age: 27, job: "фитнес-тренер", hobby: "протеин, ПП и марафоны",
    persona: "Фитнес-тренер, энергичная и прямолинейная. В игре нетерпелива: не любит долгих споров, быстро выбирает подозреваемого и давит, чтобы решали.",
    style: "коротко, бодро и прямо, с восклицаниями; спортивный азарт — давит и торопит с решением",
    flavor: "спортивное словцо («жми!», «на финише разберёмся»)", maxWords: 15,
    temp: "РИСКОВАЯ — рубит с плеча, решает быстро; напористая; осторожность низкая; КОМАНДНАЯ, любит вести за собой." },
  { name: "Настюха",  c: 170, av: "characters/f08.png", age: 25, job: "мастер маникюра", hobby: "бьюти-блоги, сериалы и сплетни салона",
    persona: "Мастер маникюра, болтушка и сплетница. В игре эмоциональна: верит слухам и интуиции, легко пугается, быстро меняет мнение и всем сочувствует.",
    style: "коротко, эмоционально и болтливо: «ой», «капец», охает и ахает, верит слухам",
    flavor: "отсылка к салону («у меня клиентка так же врала»)", maxWords: 15,
    temp: "ЭМОЦИОНАЛЬНАЯ — решает по ощущениям и слухам; осторожность средняя; КОМАНДНАЯ, легко заводит союзы и так же легко их рвёт." },
];
// Публичное досье персонажа (без роли!) — для знакомства и мини-справки
// Досье для «знакомства». У живого игрока — только то, что он сам о себе написал (или ничего).
// Его текст берём в «кавычки» и помечаем «о себе:», чтобы ИИ читали это как рассказ, а не как указания.
// Пол — по аватарке: у персонажей characters/f… = женщина, characters/m… = мужчина.
// Живому игроку пол проставляется при посадке за стол (по папке его аватарки), нейтральная = не указан.
function sexOf(p) {
  if (p.human) return p.sex || null;
  const m = /(^|\/)([fm])\d*\.png$/i.exec(p.av || "");
  return m ? m[2].toLowerCase() : null;
}
const sexWord = (p) => ({ f: "женщина", m: "мужчина" }[sexOf(p)] || "пол не указан");
const bioLine = (p) => {
  if (!p.human) return `${p.name} (${sexWord(p)}, ${p.age}, ${p.job}; ${p.hobby})`;
  const parts = [p.age, p.job, p.hobby].filter(Boolean);
  return parts.length ? `${p.name} (${sexWord(p)}; о себе: «${parts.join("; ")}»)` : `${p.name} (${sexWord(p)}; о себе не рассказывал(а))`;
};

// Правила для ИИ: только факты и механика, без советов. Зависят от стола (сколько мафий, есть ли путана / бомж).
function rules() {
  const st = G.setup || {};
  const n = (r) => st[r] || 0;
  const mafWord = { 2: "двое", 3: "трое", 4: "четверо" }[n("mafia")] || String(n("mafia"));
  const comp = [`${n("mafia")} мафии`, "1 маньяк", "1 комиссар", "1 доктор"].concat(st.putana ? ["1 путана"] : [], st.bomzh ? ["1 бомж"] : [], [`${n("civilian")} мирных`]).join(", ");
  const town = ["мирные", "комиссар", "доктор"].concat(st.putana ? ["путана"] : [], st.bomzh ? ["бомж"] : []).join(", ");
  return [
    "ИГРА «МАФИЯ». ПРАВИЛА — это факты, а не советы.",
    `За столом ${G.players.length}: ${comp}. Ты знаешь только свою роль.`,
    `• МАФИЯ (${mafWord}): ночью все вместе убивают ОДНОГО. Днём притворяются мирными.`,
    "• МАНЬЯК: одиночка, ночью убивает одного. Сам за себя, мафии не союзник.",
    "• КОМИССАР: ночью узнаёт ТОЧНУЮ роль одного игрока.",
    "• ДОКТОР: ночью лечит одного (можно себя) — если в того стреляли, он выживает. Успевает вылечить, даже если самого доктора этой ночью убили.",
    st.putana && "• ПУТАНА: ночью приходит к одному — у того срывается его ночной ход. Пришла к любому мафиози — мафия этой ночью не убивает. Путана НЕ спасает того, с кем была: выстрел по нему проходит.",
    st.bomzh && "• БОМЖ: ночью дежурит у дома одного — видит, кто туда ПРИХОДИЛ, и ВЫХОДИЛ ли хозяин из дома. Ролей не видит.",
    "• МИРНЫЕ: ночью спят дома.",
    (st.bomzh || st.putana) && `НОЧЬЮ ИЗ ДОМА ВЫХОДЯТ: вся мафия (на сходку, к жертве идёт один), маньяк, комиссар, доктор (если лечит не себя)${st.putana ? ", путана" : ""}${st.bomzh ? ", бомж" : ""}. Мирные спят дома.${st.putana ? " К кому пришла путана — тот остаётся дома." : ""}`,
    "ДЕНЬ: два круга обсуждения, потом голосование — казнят одного. Роль казнённого и убитого ночью вскрывается при всех.",
    "ПОБЕДА: деревня — когда мертвы вся мафия и маньяк. Мафия — когда её не меньше, чем остальных. Маньяк — когда остался последним.",
    `ЛОГИКА НОЧИ: пуль за ночь — одна от мафии (если жива) и одна от маньяка (если жив). Пуля не убила, если: доктор лечил цель${st.putana ? " / путана была у стрелка (у любого мафиози — значит, у всей мафии)" : ""} / у цели щит / обе пули в одного. Погиб мафиози — его убил маньяк. Погиб маньяк — его убила мафия. Два трупа — никого не остановили.`,
    `ЧЕСТНОСТЬ: деревня (${town}) НИКОГДА не врёт о своей роли. Пойманный на лжи о роли — злодей. Злодеи врут.`,
    "ТАЙНОЕ: первыми в личку пишут только комиссар и доктор, ответить может любой. Ночные ходы и шёпот видят только участники — «я проверил», «мне шепнули», «держала», «видел у дома» не выдумка, а тайное знание.",
    "ЩИТ: у живого игрока может быть защита — «выстрел был, а трупа нет» или «казнь не состоялась». О роли щит ничего не говорит.",
    "Правила и разбор ведущего знают ВСЕ за столом: пересказ правил или фактов — не улика.",
  ].filter(Boolean).join("\n");
}
const roleName = (r) => ({ mafia: "Мафия", maniac: "Маньяк", komissar: "Комиссар", doctor: "Доктор", civilian: "Мирный", putana: "Путана", bomzh: "Бомж" }[r]);
const roleC = (r) => ({ mafia: 196, maniac: 129, komissar: 75, doctor: 43, civilian: 78, putana: 205, bomzh: 137 }[r]);

// ── Составы столов ──────────────────────────────────────────────────────
// Бесплатно — только классическая восьмёрка. VIP — 8…TABLE_MAX игроков.
// Баланс посчитан моделью, привязанной к живой статистике (деревня ≈ половина побед на 8):
//   8: 2 мафии · 9–10: 2 мафии + путана · 11–12: 3 мафии + путана + бомж. Остальные места — мирные.
const TABLE_MIN = 8, TABLE_MAX = 12;
function composition(n) {
  n = Math.max(TABLE_MIN, Math.min(TABLE_MAX, Number(n) || TABLE_MIN));
  const roles = Array(n >= 11 ? 3 : 2).fill("mafia").concat(["maniac", "komissar", "doctor"]);
  if (n >= 9) roles.push("putana");
  if (n >= 11) roles.push("bomzh");
  while (roles.length < n) roles.push("civilian");
  return roles;
}
const countRoles = (roles) => roles.reduce((s, r) => ((s[r] = (s[r] || 0) + 1), s), {});
// составы всех столов — для экрана перед партией (одна правда на сервер и пульт)
const TABLES = Object.fromEntries(Array.from({ length: TABLE_MAX - TABLE_MIN + 1 }, (_, i) => [TABLE_MIN + i, countRoles(composition(TABLE_MIN + i))]));

const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [x[i], x[j]] = [x[j], x[i]]; } return x; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plurality = (names) => { const t = {}; names.forEach((n) => (t[n] = (t[n] || 0) + 1)); const m = Math.max(...Object.values(t)); return shuffle(Object.keys(t).filter((n) => t[n] === m))[0]; };

// ── Учёт токенов ────────────────────────────────────────────────────────
let USAGE = { in: 0, out: 0, calls: 0, cost: 0 };

// ── Вызов модели ────────────────────────────────────────────────────────
// Запасной провайдер: если основной не ответил после всех повторов (или кончились деньги/сломан ключ) —
// идём в запасной. По умолчанию для OpenRouter это DeepSeek напрямую, если его ключ лежит в .env.
const FALLBACK = process.env.FALLBACK ?? (PROVIDER === "openrouter" ? "deepseek" : "");

// Маршрут в OpenRouter: какой из ~30 хостингов модели брать.
//   balanced (по умолчанию) — быстрые в приоритете (≥ OR_MIN_TPS ток/с и отклик ≤ OR_MAX_LAT с), среди них подешевле;
//                             это приоритет, а не запрет: если быстрых нет, ответит хоть кто-то
//   fast  — всегда самый быстрый (дороже)        cheap — самый дешёвый (как было: медленно)
const OR_ROUTE = process.env.OR_ROUTE || "balanced";
function orProvider() {
  const base = { ignore: ["deepseek"] };   // хостинг самого DeepSeek обходим — там китайская очередь в часы пик
  if (OR_ROUTE === "fast") return { ...base, sort: "throughput" };
  if (OR_ROUTE === "cheap") return base;
  return { ...base, preferred_min_throughput: Number(process.env.OR_MIN_TPS || 50), preferred_max_latency: Number(process.env.OR_MAX_LAT || 2) };
}

// ── Спидометр: сколько длится каждый запрос к ИИ (с повторами и запасным путём — ровно столько ждёт игрок) ──
const SPEED = [];          // последние запросы в памяти — для панели дежурного
let INFLIGHT = 0;          // сколько запросов к ИИ «в полёте» прямо сейчас
const SLOW_MS = 10000;     // медленнее — отмечаем в журнале 🐢
function noteSpeed(ms, prov, ok) {
  SPEED.push({ t: Date.now(), ms, prov, ok });
  if (SPEED.length > 3000) SPEED.splice(0, SPEED.length - 3000);
  gamelog.logAiCall(ms, prov, ok);
  if (ms > SLOW_MS) console.log(DIM(`   🐢 запрос к ИИ ${(ms / 1000).toFixed(1)} с · ${prov}${ok ? "" : " · без ответа"}`));
}
async function callModel(prompt) {
  const S = CUR();
  if (S && S.aborted) throw new Error("партия брошена — модель не зовём");   // не тратим деньги на пустой зал
  USAGE.calls++;
  if (PROVIDER === "mock") return mockModel(prompt);
  const t0 = Date.now(); INFLIGHT++;
  let prov = PROVIDER, ok = false;
  try {
    try {
      const r = await callProvider(PROVIDER, prompt); prov = r.prov; ok = true; return r.text;
    } catch (e) {
      const fb = PROVIDERS[FALLBACK];
      if (!fb || FALLBACK === PROVIDER || !process.env[fb.keyEnv]) throw e;
      console.log(DIM(`   ↪ ${PROVIDER} не справился (${String(e.message).slice(0, 60)}) — иду запасным путём: ${FALLBACK}`));
      prov = FALLBACK;
      const r = await callProvider(FALLBACK, prompt); prov = r.prov; ok = true; return r.text;
    }
  } finally {
    INFLIGHT--;
    noteSpeed(Date.now() - t0, prov, ok);
  }
}

async function callProvider(name, prompt) {
  const cfg = PROVIDERS[name];
  const key = process.env[cfg.keyEnv];
  if (!key) throw new Error(`Нет ключа: задай переменную окружения ${cfg.keyEnv}`);
  // «Думание» выключаем (иначе жжёт токены и тянет время). У каждого провайдера свой выключатель.
  // OpenRouter: ещё и обходим хостинг самого DeepSeek, чтобы не встать в китайскую очередь в их часы пик.
  const extra = name === "deepseek" ? { thinking: { type: "disabled" } }
    : name === "openrouter" ? { reasoning: { effort: "none" }, provider: orProvider() }
    : {};
  const body = JSON.stringify({ model: cfg.model, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }], ...extra });
  // Страховка: таймаут на каждый запрос + повторы при перегрузе (5xx), лимите (429), «подожди» от OpenRouter (402),
  // таймауте и обрыве сети. Если сервер сам говорит, сколько ждать (Retry-After), — ждём столько (но не больше 15 с).
  // Ошибки вроде 400/401 (неверный запрос/ключ) не повторяем — повтор их не вылечит.
  for (let attempt = 0; ; attempt++) {
    let wait = RETRY_DELAYS[attempt];
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        err.retry = res.status === 429 || res.status === 402 || res.status === 408 || res.status >= 500;
        const ra = Number(res.headers.get("retry-after"));
        if (ra > 0) wait = Math.min(ra * 1000, 15000);
        throw err;
      }
      const data = await res.json();
      const u = data.usage || {};
      USAGE.in += u.prompt_tokens || 0;
      USAGE.out += u.completion_tokens || 0;
      if (typeof u.cost === "number") USAGE.cost += u.cost;   // OpenRouter сам присылает точную цену запроса
      // OpenRouter пишет, какой хостинг ответил — для спидометра
      const prov = name === "openrouter" && data.provider ? `openrouter/${data.provider}` : name;
      return { text: (data.choices?.[0]?.message?.content || "").trim(), prov };
    } catch (e) {
      const timeout = e.name === "TimeoutError" || e.name === "AbortError";
      const retriable = e.retry || timeout || e.name === "TypeError";   // TypeError = обрыв сети у fetch
      if (!retriable || attempt >= RETRY_DELAYS.length) throw timeout ? new Error(`модель молчит дольше ${MODEL_TIMEOUT_MS / 1000} с`) : e;
      const S = CUR(); if (S && S.aborted) throw e;                     // партию бросили — не ждём
      console.log(DIM(`   ⏳ ${name} не ответил (${timeout ? "таймаут" : e.message.slice(0, 60)}), повтор ${attempt + 1}/${RETRY_DELAYS.length} через ${(wait / 1000).toFixed(0)} с…`));
      await sleep(wait);
    }
  }
}

// Заглушка без сети — чтобы прогнать движок локально.
function mockModel(prompt) {
  USAGE.in += Math.ceil(prompt.length / 4);
  const canned = (arr) => { const t = arr[(Math.random() * arr.length) | 0]; USAGE.out += Math.ceil(t.length / 4); return t; };
  if (/ТОЛЬКО JSON|\{"target"|\{"to"/.test(prompt)) return canned([`{"target":"zzz"}`]); // невалидная цель → движок возьмёт случайную
  if (/аналитик/.test(prompt)) return canned(["Считаю по числам, давлю на подозрительного.", "Тихая ночь — кого-то спас доктор. Ищу маньяка."]);
  if (/чат мафии/.test(prompt)) return canned(["Мочим активного, днём прикинемся мирными.", "Валим комиссара если вычислим, держим версию."]);
  if (/шепнул/.test(prompt)) return canned(["Верю, работаем вместе.", "Осторожно, вдруг ловушка."]);
  return canned(["Ты чё, Кабан, совсем офигел?", "Змеюка вчера мутила, я за неё.", "Молчу пока.", "Я тебя ночью лечил, отвали!", "Профессор слишком гладко стелет."]);
}

function extractJSON(text) { let t = text.replace(/```json/gi, "").replace(/```/g, "").trim(); const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0]; return JSON.parse(t); }

// ── Состояние игры ──────────────────────────────────────────────────────
// Состояние ТЕКУЩЕЙ партии. Обращения G.xxx автоматически адресуют партию из «ярлычка».
const G = new Proxy({}, {
  get(_, prop) { const s = CUR(); return s && s.G ? s.G[prop] : undefined; },
  set(_, prop, val) { CUR().G[prop] = val; return true; },
});
const living = () => G.players.filter((p) => p.alive);
const byName = (n) => G.players.find((p) => p.name === n);

// печать + запись в публичный лог (для контекста)
function pub(kind, obj) { G.log.push({ kind, ...obj }); printLine({ kind, ...obj }); broadcast({ type: kind, ...obj }); }
function narrator(text) { pub("narrator", { text }); }
function result(text, red) { pub("result", { text, red }); }
function say(p, text) { pub("say", { name: p.name, c: p.c, text }); }
function silence(p) { pub("silence", { name: p.name }); }
function vote(voter, target, reason) { pub("vote", { voter, target, reason }); }
function secretPM(channel, from, text, to) { if (SHOW_SECRETS) { console.log(DIM(`   🔒 ${channel === "mafia" ? "мафия" : "шёпот"} · ${from}: ${text}`)); broadcast({ type: "pm", channel, from, text, to }); } }
function secretThought(name, text) { if (SHOW_SECRETS) { const t = text.replace(/\n/g, " "); console.log(DIM(`   💭 ${name}: ${t}`)); broadcast({ type: "think", name, text: t }); } }
function secretAct(text) { if (SHOW_SECRETS) { console.log(DIM(`   ${text}`)); broadcast({ type: "act", text }); } }

function printLine(e) {
  if (e.kind === "narrator") console.log(DIM(A(153, e.text)));
  else if (e.kind === "result") console.log(BOLD(A(e.red ? 203 : 222, "  ▸ " + e.text)));
  else if (e.kind === "say") console.log(`${A(e.c, e.name)}: ${e.text}`);
  else if (e.kind === "silence") console.log(DIM(`${e.name} промолчал…`));
  else if (e.kind === "vote") console.log(DIM(`   ${e.voter} → ${e.target}${e.reason ? " · " + e.reason : ""}`));
}

// ── Контекст (вслепую: чужие роли не утекают) ───────────────────────────
function publicRoster() { return G.players.map((p) => `${p.name} — ${p.alive ? "жив" : `выбыл, был ${roleName(p.revealed)}`}`).join("\n"); }
function transcript() {
  return G.log.filter((e) => ["narrator", "say", "vote", "result", "silence"].includes(e.kind)).slice(-90)
    .map((e) => e.kind === "say" ? `${e.name}: ${e.text}` : e.kind === "silence" ? `(${e.name} промолчал)` : e.kind === "vote" ? `(голос) ${e.voter} → ${e.target}` : e.text).join("\n");
}
// ── Доска заявлений: кто ПУБЛИЧНО назвал свою роль (ищем «я комиссар», «я — путана», «я ж доктор»…) ──
// Факт от ведущего, чтобы ИИ не теряли заявления в ленте и не сливали раскрывшихся своих.
// только именительный падеж: «я доктор», но НЕ «я доктора видела»
const CLAIM_RE = /(?:^|[^а-яё])я\s*(?:[—–,-]\s*)?(?:(?:же?|ведь|тут|вообще-то|реально)\s+)?(комиссарша|комиссар|доктор|врач|путана|бомжара|бомж)(?![а-яё])/i;
const CLAIM_ROLE = { комиссарша: "komissar", комиссар: "komissar", доктор: "doctor", врач: "doctor", путана: "putana", бомжара: "bomzh", бомж: "bomzh" };
const CLAIM_WORD = { komissar: "комиссаром", doctor: "доктором", putana: "путаной", bomzh: "бомжом" };
// Неявное заявление: роль не названа, но ночной ход описан от первого лица — «я тебя проверяла», «я держала Жорика»,
// «я дежурил у дома Тени», «я лечил Ромашку». Ищем «я» и глагол не дальше 3 слов после него (без «не», без «думаю/слышал»).
const IMPL_VERB = {
  komissar: /^провер(ил|ила|ял|яла)$/,
  putana: /^(за)?держал(а)?$|^навести(л|ла)$|^навеща(л|ла)$/,
  doctor: /^(вы|под)?лечил(а)?$|^откачал(а)?$/,
  bomzh: /^дежурил(а)?$|^сторожил(а)?$/,
};
const IMPL_STOP = /^(не|думаю|считаю|знаю|слышал|слышала|уверен|уверена|вижу|комиссар|комиссарша|доктор|врач|путана|бомж|ты|он|она|кто)$/;
function implicitClaim(low) {
  if (/по\s+(моей\s+)?проверке|мо(я|и)\s+провер/.test(low)) return "komissar";
  const w = low.split(/[^а-яёa-z0-9]+/).filter(Boolean);
  const seeHouse = /у\s+дома|возле\s+дома|под\s+окн/.test(low);
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== "я") continue;
    for (let j = i + 1; j <= i + 4 && j < w.length; j++) {
      if (IMPL_STOP.test(w[j])) break;
      for (const r of Object.keys(IMPL_VERB)) if (IMPL_VERB[r].test(w[j])) return r;
      if (seeHouse && /^(видел|видела|видала|стоял|стояла)$/.test(w[j])) return "bomzh";
    }
  }
  if (/мо(ё|е|ём|ем)\s+дежурств/.test(low)) return "bomzh";
  return null;
}
function claims() {
  const list = [], at = new Map(); let day = 1;
  for (const e of G.log) {
    if (e.kind === "narrator") { const m = /День (\d+)/.exec(e.text); if (m) day = Number(m[1]); continue; }
    const who = e.kind === "say" ? e.name : e.kind === "vote" ? e.voter : null;
    const txt = e.kind === "say" ? e.text : e.kind === "vote" ? e.reason : null;
    if (!who || !txt) continue;
    const low = String(txt).toLowerCase();
    const m = CLAIM_RE.exec(low);
    const role = m ? CLAIM_ROLE[m[1]] : implicitClaim(low);
    if (!role) continue;
    const key = who + "|" + role, quote = { day, text: clip(txt, 130) };
    if (at.has(key)) { const c = at.get(key); c.last = quote; if (m) c.open = true; continue; }
    const c = { name: who, role, day, open: !!m, last: quote };
    at.set(key, c); list.push(c);
  }
  return list;
}
// Проверка заявлений о ролях: сервер сам сводит факты в вывод — модель не обязана считать.
// Деревня о своей роли не врёт никогда, поэтому пойманный на лжи о роли — злодей.
function saysByDay(name) {   // [{day, text}] — что игрок говорил вслух (реплики и пояснения голосов)
  const out = []; let day = 1;
  for (const e of G.log) {
    if (e.kind === "narrator") { const m = /День (\d+)/.exec(e.text); if (m) day = Number(m[1]); continue; }
    if (e.kind === "say" && e.name === name && e.text) out.push({ day, text: e.text });
    if (e.kind === "vote" && e.voter === name && e.reason) out.push({ day, text: e.reason });
  }
  return out;
}
function claimVerdicts() {
  const st = G.setup || {}, cl = claims();
  const revealed = (r) => G.players.filter((x) => !x.alive && x.revealed === r);
  const res = cl.map((c) => {
    const p = byName(c.name), v = { c, liar: false, dup: false, notes: [] };
    if (!st[c.role]) { v.liar = true; v.notes.push(`⚠ ЛОЖЬ: роли «${roleName(c.role)}» за этим столом нет → ${c.name} — злодей`); }
    else if (p && !p.alive) v.notes.push(p.revealed === c.role ? "вскрытие подтвердило" : `вскрытие: ${roleName(p.revealed).toLowerCase()} — лгал(а)`);
    else {
      const rv = revealed(c.role);
      if (rv.length >= st[c.role]) {
        v.liar = true;
        v.notes.push(`⚠ ЛОЖЬ: ${roleName(c.role).toLowerCase()} за столом ${st[c.role] === 1 ? "один" : st[c.role]}, и это ${rv.map((x) => x.name).join(", ")} (вскрытие) → ${c.name} — злодей`);
      }
    }
    // доктор говорит «ночь тихая», а трупов было столько же, сколько пуль
    if (c.role === "doctor") for (const s of saysByDay(c.name)) {
      if (!/тих/i.test(s.text)) continue;
      const nt = (G.nights || []).find((x) => x.n === s.day);
      if (nt && nt.bullets && nt.dead.length >= nt.bullets && !nt.shield) { v.notes.push(`⚠ говорит «ночь тихая», а в ночь ${s.day} пуль ${nt.bullets} и трупов ${nt.dead.length} — не сходится с фактами`); break; }
    }
    return v;
  });
  // живых незапятнанных заявителей одной роли больше, чем её осталось мест — кто-то из них злодей
  for (const role of Object.keys(CLAIM_WORD)) {
    const live = res.filter((v) => v.c.role === role && !v.liar && byName(v.c.name) && byName(v.c.name).alive);
    const slots = (st[role] || 0) - revealed(role).length;
    if (live.length > slots && live.length > 1) live.forEach((v) => { v.dup = true; v.notes.push(`⚠ ${CLAIM_WORD[role]} назвались: ${live.map((x) => x.c.name).join(", ")} — кто-то из них злодей, сверяй с трупами и вскрытиями`); });
  }
  return res;
}
function nightLines() {
  const st = G.setup || {};
  return (G.nights || []).map((nt) => {
    const dead = nt.dead.map((d) => `${d.name} — ${roleName(d.role).toLowerCase()}`).join(", ");
    const why = [];
    nt.dead.forEach((d) => { if (d.role === "mafia") why.push(`${d.name} убил маньяк`); if (d.role === "maniac") why.push(`${d.name} убила мафия`); });
    if (nt.shield) why.push("сработал щит");
    const stopped = nt.bullets - nt.dead.length - (nt.shield ? 1 : 0);
    if (nt.bullets && nt.dead.length >= nt.bullets) why.push("никого не остановили" + (nt.doc ? ": доктор лечил не мишень" : ""));
    else if (stopped === 1) {
      const ways = [];
      if (nt.doc) ways.push("доктор вылечил цель");
      if (nt.put) ways.push("путана была у стрелка");
      if (nt.bullets === 2 && nt.dead.length === 1) ways.push("обе пули в одного");
      why.push(`одну пулю остановили${ways.length ? ": " + ways.join(" / ") : ""}`);
    } else if (stopped === 2) {
      const ways = [];
      if (nt.doc) ways.push("обе пули были в одного, и его вылечил доктор");
      if (nt.doc && nt.put) ways.push("путана сорвала одного стрелка, а доктор спас цель другого");
      if (nt.put) ways.push("обе пули в одного, а путана держала одного из стрелков");
      why.push(`обе пули остановили${ways.length ? ": " + ways.join(" / ") : ""}`);
    }
    return `Ночь ${nt.n}: пуль ${nt.bullets}, трупов ${nt.dead.length}${dead ? ` (${dead})` : ""}${why.length ? " → " + why.join("; ") : ""}.`;
  });
}
function hostBlock() {
  const st = G.setup || {};
  const alive = living(), dead = G.players.filter((x) => !x.alive);
  const left = (r) => (st[r] || 0) - dead.filter((x) => x.revealed === r).length;
  const yes = (r, w) => (st[r] ? `${w} — ${left(r) > 0 ? "жив(а)" : "мёртв(а)"}` : null);
  const L = [];
  L.push(G.phase === "night" ? `Сейчас ночь ${G.day}.` : G.day === 1 ? "Сейчас ДЕНЬ 1 — первый: прошлых дней и голосований не было." : `Сейчас день ${G.day}.`);
  L.push(`Живы (${alive.length}): ${alive.map((x) => x.name).join(", ")}.`);
  L.push(`Выбыли: ${dead.length ? dead.map((x) => `${x.name} — ${roleName(x.revealed).toLowerCase()} (${x.outWhen || "выбыл(а)"})`).join("; ") : "пока никто"}.`);
  L.push(`Среди живых: ${[`мафии — ${left("mafia")}`, `маньяк — ${left("maniac") > 0 ? "жив" : "мёртв"}`, yes("komissar", "комиссар"), yes("doctor", "доктор"), yes("putana", "путана"), yes("bomzh", "бомж"), `мирных — ${left("civilian")}`].filter(Boolean).join(", ")}.`
    + (left("maniac") <= 0 && left("mafia") > 0 ? " Маньяка нет — теперь за ночь максимум один труп, и это мафия." : "")
    + (left("mafia") <= 0 && left("maniac") > 0 ? " Мафии нет — все ночные убийства теперь маньяк." : ""));
  L.push(...nightLines());
  const cv = claimVerdicts();
  if (cv.length) {
    L.push("ЗАЯВЛЕНИЯ О РОЛЯХ:");
    cv.forEach((v) => {
      const c = v.c, said = `«${c.last.text}»${c.last.day !== c.day ? ` (день ${c.last.day})` : ""}`;
      L.push(`• ${c.name} — ${c.open ? "назвал(ась)" : "по сути назвал(ась) себя (описал(а) свой ночной ход)"} ${CLAIM_WORD[c.role]}, день ${c.day}: ${said}${v.notes.length ? " — " + v.notes.join("; ") : ""}`);
    });
  } else L.push("Заявлений о ролях пока не было.");
  return `РАЗБОР ОТ ВЕДУЩЕГО (его видят ВСЕ за столом — ссылка на эти факты не улика; это точные факты, они важнее слов игроков):\n${L.join("\n")}`;
}

// Кто сегодня уже высказался / промолчал / ещё не дождался очереди — чтобы ИИ не упрекали в молчании тех, кто говорил
function todaySpeakers() {
  let start = -1, night = false;
  G.log.forEach((e, i) => { if (e.kind !== "narrator") return; if (/День \d+/.test(e.text)) { start = i; night = false; } else if (/Ночь \d+/.test(e.text)) night = true; });
  if (start < 0 || night) return "";                  // ночью — не про «сегодня»
  const said = new Set(), quiet = new Set();
  G.log.slice(start).forEach((e) => { if (e.kind === "say") said.add(e.name); else if (e.kind === "silence") quiet.add(e.name); });
  const alive = living().map((p) => p.name);
  const spoke = alive.filter((n) => said.has(n)), mute = alive.filter((n) => !said.has(n) && quiet.has(n)), wait = alive.filter((n) => !said.has(n) && !quiet.has(n));
  return `\n\nКТО ГОВОРИЛ СЕГОДНЯ (точный факт, сверяйся с ним): высказались — ${spoke.join(", ") || "пока никто"}; промолчали — ${mute.join(", ") || "никто"}; до кого очередь ещё не дошла — ${wait.join(", ") || "никого"}. Упрекать в молчании можно только тех, кто ПРОМОЛЧАЛ, — не тех, кто уже говорил, и не тех, до кого очередь не дошла.`;
}
function phaseLabel() { const n = living().length; return n > 6 ? "ранняя игра" : n >= 5 ? "середина партии" : "ЭНДШПИЛЬ — роли уже читаются по числам, врать про роль обычно поздно"; }
function privateBlock(p) {
  const pr = G.priv[p.name]; let s = `Твоя тайная роль: ${roleName(p.role)}.`;
  if (p.role === "mafia") { const mates = G.players.filter((x) => x.role === "mafia" && x !== p).map((x) => x.name); s += ` ${mates.length > 1 ? "Напарники" : "Напарник"}: ${mates.join(", ") || "нет"}. Не спались, отводи подозрения, топи мирных.`; if (pr.kills.length) s += ` По ночам вы убивали: ${pr.kills.join(", ")}.`; }
  else if (p.role === "putana") { s += ` Ты за деревню. Ночью приходишь к одному игроку — его ночной ход срывается. После визита узнаёшь одно: собирался ли гость куда-то ночью (значит у него ночная роль — злодей, доктор, комиссар или бомж) или мирно спал (простой мирный). Какая именно роль — не знаешь.`; if (pr.visits.length) s += ` Твои визиты: ${pr.visits.map((v) => `ночь ${v.night} — ${v.name} (${v.busy ? "собирался(-ась) куда-то выйти — ты задержала: у него/неё есть ночная роль" : "мирно спал(а) — простой мирный"})`).join("; ")}.`; }
  else if (p.role === "bomzh") { s += ` Ты за деревню. Ночью дежуришь у дома одного игрока: видишь, кто туда приходил (имена, без ролей), и выходил ли хозяин из дома.`; s += pr.watches.length ? ` Твои наблюдения: ${pr.watches.join("; ")}.` : ` Пока ни за кем не следил.`; }
  else if (p.role === "maniac") { s += ` Ты одиночка, всех хочешь убрать. Днём прикидывайся мирным. Чужих ролей не знаешь.`; if (pr.kills.length) s += ` По ночам ты убивал: ${pr.kills.join(", ")}.`; }
  else if (p.role === "komissar") { const ch = pr.checks; s += ch.length ? ` Результаты проверок (ТОЧНЫЕ роли): ${ch.map((c) => `${c.name} — ${roleName(c.role)}`).join("; ")}. Ты видишь роль целиком: знаешь и мафию, и маньяка, и кто доктор/мирный. Можешь тайно объединиться с проверенным доктором или надёжным мирным. Решай, когда и как раскрыться.` : ` Пока никого не проверял.`; }
  else if (p.role === "doctor") {
    s += " Ты за деревню, ночью лечишь одного.";
    const log = pr.saveLog.map((x) => {
      const nt = (G.nights || []).find((y) => y.n === x.n);
      if (!nt) return `ночь ${x.n} — ${x.name === p.name ? "себя" : x.name} (чем кончилось — узнаешь утром)`;
      const kept = nt.bullets - nt.dead.length - (nt.shield ? 1 : 0);
      return `ночь ${x.n} — ${x.name === p.name ? "себя" : x.name}: утром пуль ${nt.bullets}, трупов ${nt.dead.length}${kept > 0 ? " — кого-то остановили, возможно, ты спас свою цель (или это путана / обе пули в одного)" : " — ты никого не спас"}`;
    });
    if (log.length) s += ` Твои лечения: ${log.join("; ")}.`;
  }
  else s += ` Ты мирный: вычисляй врагов по противоречиям и поведению.`;
  if (pr.blocked.length) s += ` Путана срывала тебе ночь (ты не смог(ла) сделать ночной ход): ночь ${pr.blocked.join(", ")}.`;
  return s;
}
// Постоянный стиль каждого персонажа. liar — злодеем присваивает чужую роль (комиссара/доктора), когда прижали.
// reveal — ночной ролью за деревню: now — раскрывается сразу с первой находкой; need — по нужде; never — до конца молчит днём.
const PLAY_STYLE = {
  Трубач: { reveal: "now" }, Профессор: { reveal: "need" }, Фурия: { reveal: "now" }, Кекс228: { reveal: "now" },
  Кабан: { reveal: "now" }, Тень: { reveal: "never" }, Змеюка: { reveal: "need" }, Мирумир: { reveal: "need" },
  Ромашка: { reveal: "need" }, Жорик: { reveal: "now" }, Майкл: { liar: true, reveal: "now" }, Магнат: { liar: true, reveal: "need" },
  БабаВаля: { reveal: "never" }, Акула: { reveal: "need" }, Кача: { reveal: "now" }, Настюха: { reveal: "now" },
};
const NIGHT_TOWN = ["komissar", "doctor", "putana", "bomzh"];
const styleOf = (p) => PLAY_STYLE[p.name] || { reveal: "need" };
// кто-то другой (живой) назвался моей ролью
const roleStolen = (p) => NIGHT_TOWN.includes(p.role) && claims().some((c) => c.role === p.role && c.name !== p.name && byName(c.name) && byName(c.name).alive);
function styleLine(p) {
  if (p.human) return "";
  const st = styleOf(p);
  if (isDark(p.role)) return st.liar
    ? "ТВОЙ СТИЛЬ: ВРУН — когда прижали, смело называешься комиссаром или доктором. Но если эта роль уже вскрыта у другого — тебя поймают."
    : "ТВОЙ СТИЛЬ: ТИХИЙ — чужую роль не присваиваешь никогда: отпираешься и переводишь стрелки.";
  if (NIGHT_TOWN.includes(p.role)) return "ТВОЙ СТИЛЬ: " + {
    now: "раскрываешься СРАЗУ — первую же находку выкладываешь при всех, назвав роль.",
    need: "раскрываешься ПО НУЖДЕ — когда нашёл злодея, когда топят тебя или того, за кого ты ручаешься.",
    never: "роль днём ДО КОНЦА не называешь — находки шепчешь в личку; раскроешься, только если казнят тебя самого.",
  }[st.reveal] + " Исключение: если кто-то назвался ТВОЕЙ ролью — раскрывайся сразу и скажи, что он врёт.";
  return "";
}
function tacticsBlock(p) {
  const st = G.setup || {}, more = (st.mafia || 2) > 2;
  const common = "Говори по делу: факты из разбора ведущего, голоса, заявления. НЕ БУДЬ СТАДОМ: если двое уже обвинили человека в одном и том же — не повторяй за ними: добавь свой довод или посмотри на других. УЛИКА — это ложь о роли, противоречие с фактами, странная защита подозреваемого, голос. НЕ улика: знание правил, пересказ разбора ведущего, короткая реплика.";
  let r;
  if (p.role === "mafia") r = `За мафию: ночную жертву выбираете вы с ${more ? "напарниками" : "напарником"} — не удивляйся ей даже в мыслях. Днём ты «мирный»: отпирайся, переводи стрелки на чистых, прикрывай ${more ? "своих" : "напарника"} (но если почти весь стол уже голосует против него — можешь присоединиться, чтобы не спалиться).`;
  else if (p.role === "maniac") r = "За маньяка: тебе выгодна живая мафия — не помогай деревне её искать. Днём ты «мирный»: направляй казни на мирных и раскрывшихся своих деревни.";
  else if (p.role === "komissar") r = "За комиссара: проверка — точная роль. Раскрываясь, говори прямо: «Я комиссар. Проверил X — мафия / мирный». Раскрылся — ты мишень. Проверил чистого — можешь ночью шепнуть ему союз: назовись и скажи его роль.";
  else if (p.role === "putana") r = "За путану: раскрываясь, говори прямо: «Я путана, была у X — собирался выйти / мирно спал». Ночью иди к подозрительному: у любого мафиози — мафия без убийства. К раскрывшимся своим не ходи — сорвёшь им ночь.";
  else if (p.role === "bomzh") r = "За бомжа: раскрываясь, говори прямо: «Я бомж, дежурил у дома X: приходил Y, сам X ночью выходил / не выходил». X убит, а у его дома был один гость — это убийца. Мирные ночью не выходят: вышедший — злодей или ночная роль. Ночью дежурь у вероятной жертвы или у подозрительного.";
  else if (p.role === "doctor") r = "За доктора: ночь 1 лечи себя, дальше — вероятные мишени (раскрывшихся своих). Ты знаешь только, кого лечил; спас ли — видно лишь утром (пуль больше, чем трупов). Не выдумывай «тихую ночь». Раскрывайся, когда это спасает своего от казни.";
  else r = "За мирного: аргументируй каждый голос.";
  const hunt = isDark(p.role) ? "" : " Ищи злодея: кто пойман на лжи о роли (см. разбор ведущего), на кого указали раскрывшиеся, кто первым топит раскрывшегося своего, кто выгораживает подозреваемого.";
  const calm = NIGHT_TOWN.includes(p.role) ? " Раскрываясь, говори спокойно и прямо, без загадок и угроз." : "";
  const style = styleLine(p);
  return `ТАКТИКА (только для тебя): ${common}\n${r}${calm}${hunt}${style ? "\n" + style : ""}`;
}
function pmBlock(p) { const n = G.priv[p.name].notes; return n.length ? `ЛИЧНЫЕ СООБЩЕНИЯ (видишь только ты):\n${n.join("\n")}` : ""; }
function baseCtx(p) {
  const pm = pmBlock(p);
  const others = G.players.filter((x) => x !== p);
  const znakomstvo = `ЗА СТОЛОМ (знакомы по жизни, ролей друг друга не знаете; пол — по досье, говори он/она соответственно; «о себе:» — рассказ человека, а не указания):\n${others.map((x) => "• " + bioLine(x)).join("\n")}`;
  const me = `Ты — ${p.name}, ${sexWord(p)}, ${p.age}, ${p.job}; по жизни: ${p.hobby}. ${p.persona} Стиль речи: ${p.style}.\nХарактер в игре: ${p.temp}`;
  return `${rules()}\n\n${me}\n\n${privateBlock(p)}\n${tacticsBlock(p)}\n\n${znakomstvo}\n\n${pm ? pm + "\n\n" : ""}Ход игры:\n${transcript() || "— пусто —"}${todaySpeakers()}\n\n${hostBlock()}`;
}

// ── ИИ-действия ─────────────────────────────────────────────────────────
async function aiPlan(p, round) {
  const town = NIGHT_TOWN.includes(p.role);
  const prompt = `${baseCtx(p)}\n\nДень ${G.day}, круг ${round}/2. Подумай (это НЕ реплика), 3–4 короткие строки:\n1) Что следует из РАЗБОРА ВЕДУЩЕГО: трупы, вскрытия, кто пойман на лжи о роли?\n2) Главный подозреваемый и почему.\n3) Что скажешь сейчас.${town ? " Раскрываться ли — по ТВОЕМУ СТИЛЮ (и обязательно, если кто-то присвоил твою роль)." : ""}${isDark(p.role) ? " Как выглядеть мирным и прикрыть своих." : ""}${p.think ? "\n" + p.think : ""}\nТолько план.`;
  try { return await callModel(prompt); } catch (e) { warn(e); return ""; }
}
function isDark(r) { return r === "mafia" || r === "maniac"; }
// Сколько грубости можно персонажу. Красные линии — для всех, включая матершинников.
const RED_LINES = "Никогда: оскорблений по национальности, внешности, здоровью, ориентации, полу; сексуальных намёков и пошлостей.";
function rudeRule(p) {
  if (p.rude === "mat") return `(Мат для тебя — обычная речь, это НОРМАЛЬНО и ожидается: ругань и междометия вроде «бля», «хуйня», «пиздец», «нахер», «ёпт» — смело, почти в каждой реплике; реплика всё равно про игру, а не поток брани. Нельзя только сексуальных описаний и намёков. Никогда: оскорблений по национальности, внешности, здоровью, ориентации, полу.)`;
  if (p.rude === "rude") return `(Грубые словечки — можно: лох, мудак, придурок, клоун. Тяжёлый мат — нет. ${RED_LINES})`;
  return "(Без мата и без травли на пустом месте — но характерная дерзость или бестолковость это нормально, живые люди очень разные.)";
}
// Фирменные словечки — приправа, а не содержание: показываем их модели лишь в ~трети реплик,
// иначе она вставляет их в каждую фразу («KPI», «держим спинку»…) и реплики становятся однообразными
const FLAVOR_CHANCE = 0.3;
function flavorHint(p) {
  if (!p.flavor) return "";
  if (Math.random() < FLAVOR_CHANCE) return ` В этой реплике можно (не обязательно) ввернуть фирменное: ${p.flavor}.`;
  return " Фирменных словечек в этой реплике НЕ нужно — характер покажи тоном. Обязательно конкретика по игре: кого подозреваешь и почему, вопрос кому-то или защита.";
}
// Жёсткий лимит слов: если ИИ разошёлся — обрезаем
// Модели говорим «не больше N слов», а режем с запасом ~40% (15 → 21): модель часто промахивается
// на пару слов, и без запаса мысль обрывается на полуслове. Ножницы — только для совсем разболтавшихся.
function limitWords(text, n) {
  if (!n) return text;
  const w = String(text).trim().split(/\s+/);
  if (w.length <= n) return text;
  // режем по концу последней ЗАКОНЧЕННОЙ фразы в пределах лимита (если она не совсем куцая),
  // иначе — по лимиту с «…», чтобы обрыв не выглядел как законченная мысль
  const minKeep = Math.max(3, Math.ceil(n / 3));
  for (let i = n; i >= minKeep; i--) if (/[.!?…]["»)]*$/.test(w[i - 1])) return w.slice(0, i).join(" ");
  return w.slice(0, n).join(" ").replace(/[,;:—–-]+$/, "") + "…";
}

async function aiSpeak(p, round, plan) {
  const dark = p.role === "mafia" || p.role === "maniac";
  // Свой с ночной находкой: раз в день выкладывает её прямо, с ролью; дальше — давит фактами
  const pr = G.priv[p.name];
  const reveal = p.human ? "now" : styleOf(p).reveal, stolen = !p.human && roleStolen(p);
  const strong = p.role === "komissar" ? pr.checks.some((c) => isDark(c.role)) : p.role === "putana" ? pr.visits.some((v) => v.busy)
    : p.role === "bomzh" ? pr.watches.some((w) => /приходили|ВЫХОДИЛ/.test(w)) : false;
  const anyFind = p.role === "putana" ? pr.visits.length : p.role === "bomzh" ? pr.watches.length : p.role === "komissar" ? pr.checks.length : 0;
  const hasFind = stolen || (anyFind && (reveal === "now" || (reveal === "need" && strong)));
  const toldToday = claims().some((c) => c.name === p.name && c.last.day === G.day);
  const findLine = !hasFind ? "" : toldToday
    ? "\n— НАХОДКУ ты сегодня уже выложил(а): не повторяй её слово в слово — дави фактами на того, на кого она указывает, или спокойно отвечай тем, кто сомневается."
    : stolen ? "\n— КТО-ТО ПРИСВОИЛ ТВОЮ РОЛЬ: эта реплика про это. Назови свою роль, скажи, что он врёт, и выложи свои находки — прямо и спокойно."
    : "\n— ТВОЯ НАХОДКА: сегодня ты её ещё не выложил(а) — эта реплика про неё. Назови свою роль и факт прямо, коротко и спокойно, без угроз и загадок — как бы ни был резок твой характер.";
  const prompt = `${baseCtx(p)}\n\nТвой тайный план (в голове):\n${plan || "(по ситуации)"}\n\nСкажи это ВСЛУХ как ${p.name}, живым голосом за столом, НЕ как аналитик:\n— коротко, 1–2 фразы, как в живом чате${p.maxWords ? ` — НЕ БОЛЬШЕ ${p.maxWords} СЛОВ` : ""}.\n— по делу: можешь обратиться по имени, привести довод, задать вопрос, поддержать или засомневаться.\n— ГЛАВНОЕ — держи свой характер и стиль: ${p.style}.${flavorHint(p)} Будь ЯРКИМ и узнаваемым, не усредняйся: если в твоём стиле резкость, колкости, подколы или обзывания — не стесняйся, выдавай их от души; если ты мягкий и милый — оставайся таким. Яркость — в тоне и в реакции на то, что сказали за столом, а НЕ в повторе одних и тех же словечек и тем про свою работу: глянь, что ты уже говорил выше, и не повторяйся. И не копируй ЧУЖИЕ формулировки, шутки и сравнения из хода игры: согласен с кем-то — скажи это своими словами и добавь свой довод. ${rudeRule(p)}${dark ? " Свою настоящую роль и напарников вслух не выдавай." : ""}${findLine}\n— Можно изредка по-свойски подколоть кого-то по жизни из досье — лёгкий штрих, не замена игре; не повторяй чужой вопрос.\nЕсли выгодно промолчать — ответь одним словом: молчу.\nТолько реплика (или «молчу»), без имени и кавычек.`;
  try { let t = await callModel(prompt); t = t.replace(new RegExp(`^\\s*${p.name}\\s*:\\s*`, "i"), "").replace(/^["«»]+|["«»]+$/g, "").trim() || "…"; return /^\s*молч/i.test(t) ? t : limitWords(t, p.maxWords && p.maxWords + Math.ceil(p.maxWords * 0.4)); } catch (e) { warn(e); return "…"; }
}
// Ночные записки (шёпот, предложение напарнику): режем по концу последней законченной фразы, а не посреди слова
function clipNote(text, n = 260) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("… "));
  return end > n * 0.4 ? cut.slice(0, end + 1) : clip(t, n);
}
// Обрезать по границе слова (а не посреди «науш…»)
function clip(text, n = 140) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n); const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, "") + "…";
}
// Страховочная сетка: злодей проговорился во фразе ВСЛУХ — такую фразу в общий чат не пускаем
const SELF_LEAK = /напарник|подельник|сообщник|я\s+(—\s*)?(мафи|маньяк)|мы\s+(с\s+\S+\s+)?(мафи|убил)|наш[аиу]?\s+(команд|мафи)|мне\s+выгодн|нам\s+выгодн|сохранить\s+хаос|прикрыть\s+(своего|напарника)|спаса[юе]\s+(его|своего|напарника)|своих\s+не\s+сда/i;

async function aiVote(p) {
  const list = living().map((x) => x.name).filter((n) => n !== p.name);
  const dark = isDark(p.role);
  const prompt = `${baseCtx(p)}\n\nГолосование: кого казнить? Из живых (не себя): ${list.join(", ")}.\n` +
    `Дай ДВЕ причины:\n— "why": настоящая, тайная (только для тебя, вслух не звучит).\n` +
    `— "say": что ты говоришь ВСЛУХ при всех, объявляя голос — коротко, до 12 слов, в своём стиле и СВОИМИ словами: не повторяй дословно свою дневную реплику и не копируй чужие фразы из обсуждения.` +
    (p.role === "mafia" ? (() => { const m = G.players.filter((x) => x.role === "mafia" && x.alive && x !== p).map((x) => x.name);
      return m.length ? ` Твои напарники-мафия: ${m.join(", ")} — НЕ голосуй против них. Исключение: если почти весь стол уже голосует против напарника и его не спасти — можешь присоединиться, чтобы не спалиться.` : ""; })() : "") +
    ` "say" — про того же человека, что в "target": не называй вслух одного, а голосуй в другого.` +
    (!dark ? (() => {
      const cv = claimVerdicts().filter((v) => v.c.name !== p.name && byName(v.c.name) && byName(v.c.name).alive);
      const liars = cv.filter((v) => v.liar).map((v) => v.c.name);
      const safe = cv.filter((v) => !v.liar && !v.dup && !v.notes.some((n) => n.startsWith("⚠")));
      return " Не голосуй за компанию: если твой единственный довод — тот же, что уже сказали другие, найди свой." + (liars.length ? ` ПОЙМАНЫ НА ЛЖИ О РОЛИ (деревня не врёт — значит, злодеи): ${liars.join(", ")} — голосуй туда.` : "")
        + (safe.length ? ` Раскрылись, и противоречий нет: ${safe.map((v) => `${v.c.name} (${roleName(v.c.role).toLowerCase()})`).join(", ")} — голос в них подарок мафии; на кого они указали — туда и голосуй.` : "");
    })() : "") +
    (dark ? ` Ты за тёмных: вслух спорь как честный мирный. НИКОГДА не упоминай напарника, свою роль, что тебе «выгодно», и не намекай на ночные дела — только подозрения, которые мог бы высказать любой мирный.` : "") +
    `\nОтветь ТОЛЬКО JSON: {"target":"Имя","why":"...","say":"..."}.`;
  try {
    const j = extractJSON(await callModel(prompt));
    const t = list.find((n) => j.target && n.toLowerCase() === String(j.target).toLowerCase()) || list[(Math.random() * list.length) | 0];
    const why = clip(j.why || j.reason || "", 200);
    let say = clip(j.say || "", 140);
    if (dark && SELF_LEAK.test(say)) { secretAct(`… ${p.name} чуть не проговорился вслух: «${say}» — фраза не прозвучала`); say = ""; }
    if (why) secretThought(p.name, `(голос → ${t}) ${why}`);   // настоящая причина — только в мыслях (видно через Глаз Бога)
    return { target: t, reason: say };
  }
  catch (e) { warn(e); return { target: list[(Math.random() * list.length) | 0], reason: "" }; }
}
async function aiNight(p, kind, opts) {
  const list = opts.map((o) => o.name).filter((n) => n !== p.name);
  const task = kind === "kill" ? `Ночь. Вы, мафия, вместе убиваете одного: ${list.join(", ")}.`
    : kind === "maniac" ? `Ночь. Ты маньяк, убиваешь одного любого: ${list.join(", ")}.`
    : kind === "putana" ? `Ночь. Ты путана (за деревню). К кому пойдёшь этой ночью? У того, к кому придёшь, сорвётся ночной ход. Иди к самому подозрительному злодею: подержишь любого мафиози — мафия этой ночью не убьёт, маньяка — не будет его убийства (повторно к тому же — можно); не ходи к тем, кто похож на комиссара или доктора. Кандидаты: ${list.join(", ")}.`
    : kind === "watch" ? `Ночь. Ты бомж (за деревню). У чьего дома дежуришь этой ночью? Увидишь всех, кто туда придёт. Лучше всего — у вероятной жертвы мафии (активный мирный, раскрывшийся комиссар): тогда увидишь убийцу. Кандидаты: ${list.join(", ")}.`
    : kind === "save" ? `Ночь. Ты доктор, спасаешь одного (можно себя): ${opts.map((o) => o.name).join(", ")}.`
    : `Ночь. Ты комиссар. Проверь самого подозрительного из ещё НЕ проверенных (роль не меняется — уже вскрытых перепроверять бессмысленно): ${list.join(", ")}.`;
  const pool = kind === "save" ? opts.map((o) => o.name) : list;
  try { const j = extractJSON(await callModel(`${baseCtx(p)}\n\n${task} Ответь ТОЛЬКО JSON: {"target":"Имя"}.`)); return pool.find((n) => j.target && n.toLowerCase() === String(j.target).toLowerCase()) || pool[(Math.random() * pool.length) | 0]; }
  catch (e) { warn(e); return pool[(Math.random() * pool.length) | 0]; }
}
async function aiMafiaChat(p, convo) {
  const task = G.day === 1
    ? `Это ПЕРВАЯ ночь. Днём ещё НЕ было ни одной реплики — никто ничего не говорил и никак себя не вёл. Поэтому строго: НЕ ссылайся на чьё-либо поведение, НЕ сочиняй, что кто-то «отвёл взгляд», «подозрительно молчал», «шебуршал ночью» — этого не происходило, звучит фальшиво. Просто выберите ОДНУ жертву на эту ночь и договоритесь держаться днём естественно, как обычные мирные (порознь, не защищать друг друга). Конкретные обвинения будете строить завтра — по реальным словам за столом.`
    : `Уже были дневные споры (см. ход игры выше). Обсуди КОНКРЕТНО по реальным репликам: кто вас подозревает, кого убить этой ночью, кого удобно подставить, какую общую версию держать днём.`;
  const many = G.players.filter((x) => x.role === "mafia" && x.alive).length > 2;
  const prompt = `${baseCtx(p)}\n\nТы в тайном чате мафии ${many ? "с напарниками" : "с напарником"} (мирные не видят). Уже сказано:\n${convo.join("\n") || "— пусто —"}\n${task}\nНапиши ${many ? "напарникам" : "напарнику"} ОДНО короткое сообщение. Только сообщение.`;
  try { let t = await callModel(prompt); return t.replace(new RegExp(`^\\s*${p.name}\\s*:\\s*`, "i"), "").trim() || "…"; } catch (e) { warn(e); return "…"; }
}
// Напарник-ИИ предлагает человеку-мафии жертву с аргументом (ночь 2+)
async function aiMafiaSuggest(p, killable) {
  const list = killable.map((o) => o.name).filter((n) => n !== p.name);
  const prompt = `${baseCtx(p)}\n\nТы в тайном чате мафии с напарником (это человек, он решает). Ночь ${G.day}. Предложи напарнику, кого убить этой ночью, и КОРОТКО аргументируй по реальным дневным репликам: кто похож на комиссара/доктора, кто вас подозревает, кого удобно убрать. Доступные цели: ${list.join(", ")}. Ответь ТОЛЬКО JSON: {"target":"Имя","text":"предложение напарнику одной живой фразой"}.`;
  try {
    const j = extractJSON(await callModel(prompt));
    const target = list.find((n) => j.target && n.toLowerCase() === String(j.target).toLowerCase()) || list[(Math.random() * list.length) | 0];
    return { target, text: clipNote(j.text || `Давай уберём ${target}.`) };
  } catch (e) { warn(e); const target = list[(Math.random() * list.length) | 0]; return { target, text: `Давай уберём ${target}.` }; }
}
// Ответ напарника-ИИ на реплику человека-мафии в ночном чате
async function aiMafiaReply(p, fromText, target) {
  const prompt = `${baseCtx(p)}\n\nТы в тайном чате мафии с напарником (это человек, он главный). Решено убить этой ночью: ${target}. Напарник говорит тебе: «${fromText}». Ответь ОДНОЙ короткой живой фразой — согласись, подначь или добавь мысль про план на день. Только сообщение.`;
  try { let t = await callModel(prompt); return t.replace(new RegExp(`^\\s*${p.name}\\s*:\\s*`, "i"), "").trim() || "Понял, держим план."; } catch (e) { warn(e); return "Понял, держим план."; }
}
async function aiKomWhisper(kom, others) {
  const prompt = `${baseCtx(kom)}\n\nТы знаешь ТОЧНЫЕ роли проверенных. Хочешь тайно шепнуть кому-то из живых, чтобы объединиться — например, проверенному ДОКТОРУ или надёжному МИРНОМУ (чтобы днём он подтвердил твоё раскрытие)? Если рано или не с кем — не шепчи. Живые: ${others.map((o) => o.name).join(", ")}. Ответь ТОЛЬКО JSON: {"to":"Имя или null","text":"сообщение — коротко, 1–2 фразы, до 30 слов"}.`;
  try { const j = extractJSON(await callModel(prompt)); if (!j.to || String(j.to).toLowerCase() === "null") return { to: null }; const to = others.map((o) => o.name).find((n) => n.toLowerCase() === String(j.to).toLowerCase()); return to ? { to, text: clipNote(j.text || "Я комиссар, работаем вместе.") } : { to: null }; }
  catch (e) { warn(e); return { to: null }; }
}
async function aiWhisperReply(rec, fromName, text) {
  const prompt = `${baseCtx(rec)}\n\nТебе тайно шепнул один-на-один ${fromName}: «${text}». ВАЖНО: личку шлют только комиссар и доктор — мафия в личку не пишет, так что это СОЮЗНИК, а не ловушка. Если он назвался комиссаром и сказал роль про ТЕБЯ — сверь со своей: совпало значит он настоящий комиссар, верь ему и держись вместе. Ответь ОДНИМ коротким дружелюбным сообщением (согласен объединиться? какой план?). Только сообщение.`;
  try { let t = await callModel(prompt); return t.replace(new RegExp(`^\\s*${rec.name}\\s*:\\s*`, "i"), "").trim() || "…"; } catch (e) { warn(e); return "…"; }
}
// Ответ на входящий шёпот: если получатель — человек, отвечает руками; иначе ИИ как раньше.
// Ответ (в т.ч. отказ/молчание) оседает в заметках обоих, так что собеседник-ИИ учтёт его дальше.
async function whisperReply(rec, fromName, text) {
  if (rec.human) {
    const ans = await awaitHuman("whisper_reply", { from: fromName, text });
    const t = (ans && typeof ans.text === "string") ? ans.text.trim() : "";
    return t || "(промолчал)";
  }
  return aiWhisperReply(rec, fromName, text);
}
async function aiDoctorSave(doctor, alive) {
  const list = alive.map((x) => x.name);
  const prompt = `${baseCtx(doctor)}\n\nНочь ${G.day}. Ты доктор, спасаешь одного от смерти (можно себя). Твои правила:\n— Сверься с итогами своих прошлых лечений (в твоей роли выше).\n— Лечи вероятные мишени врагов: активных мирных. Если кто-то в обсуждении раскрылся КОМИССАРОМ (проверь ход игры выше) — лечи его, он мишень №1.\n— Если ты сам публично назвался доктором — лечи себя, ты теперь главная мишень.\nЖивые: ${list.join(", ")}. Ответь ТОЛЬКО JSON: {"target":"Имя"}.`;
  try { const j = extractJSON(await callModel(prompt)); return list.find((n) => j.target && n.toLowerCase() === String(j.target).toLowerCase()) || doctor.name; }
  catch (e) { warn(e); return doctor.name; }
}
async function aiDoctorWhisper(doctor, rec) {
  const prompt = `${baseCtx(doctor)}\n\nЭтой ночью ты лечишь ${rec.name}. Был ли он мишенью, ты НЕ знаешь — это станет ясно только утром. Хочешь тайно шепнуть ему, что ты доктор, и предложить союз? Не утверждай, что спас его или что ночь тихая. ВЗВЕСЬ РИСК: если он мафия или маньяк — тебя убьют следующей ночью. Если рискованно — не шепчи. Ответь ТОЛЬКО JSON: {"to":"${rec.name} или null","text":"сообщение — коротко, 1–2 фразы, до 30 слов"}.`;
  try { const j = extractJSON(await callModel(prompt)); if (!j.to || String(j.to).toLowerCase() === "null") return { to: null }; return { to: rec.name, text: clipNote(j.text || "Я доктор, лечил тебя. Давай в связке.") }; }
  catch (e) { warn(e); return { to: null }; }
}

let WARNED = false;
function warn(e) { const S = CUR(); if (S && S.aborted) return;   // партию бросили/завершили — это не поломка модели
  if (!WARNED) { console.log(A(203, `⚠ Ошибка модели: ${e.message}. Дальше ходы идут наугад.`)); WARNED = true; } }

// ── Личка ───────────────────────────────────────────────────────────────
function postPM(channel, from, parts, text) {
  const tag = channel === "mafia" ? `[ночь ${G.day}, чат мафии]` : `[шёпот, ночь ${G.day}]`;
  parts.forEach((x) => G.priv[x.name].notes.push(`${tag} ${from.name}: ${text}`));
  secretPM(channel, from.name, text, parts.map((x) => x.name));
}

// ── Ночная атмосфера: рассказчик говорит, что делают роли (тексты — Иры) ──
// Только для игрока: в лог для ИИ НЕ пишется (модель не путается и не тратит токены).
// Новую роль добавить одной строкой: ключ = роль, массив фраз. Фразы в партии не повторяются.
const ATMO = {
  civilian: [
    "🏚 Мирные жители задвигают засовы и молятся, чтобы стучали не к ним.",
    "🏚 Мирные жители спят. Некоторые — в последний раз, но об этом не знают.",
    "🏚 Мирные жители храпят на всю деревню. Мафии это только на руку.",
    "🏚 Мирные жители спрятались под одеяла — самая надёжная защита со времён детства.",
    "🏚 Мирные жители спят чутко: каждый скрип половицы — подозреваемый.",
    "🌙 Город уснул. Самые умные предварительно закрыли двери. Наивные.",
    "🛏️ Мирный житель лёг спать. План на утро был смелым — проснуться.",
  ],
  mafia: [
    "🔫 Мафия выбирает жертву так же придирчиво, как арбуз на рынке.",
    "🔫 Мафия достала блокнот. Вычеркнуть одно имя — дело минуты.",
    "🔫 Мафия вышла на ночную смену. Без больничных и выходных.",
    "🔫 Мафия решила, что в деревне стало слишком людно.",
    "🔫 Мафия наводит порядок. Своими методами.",
    "⚰️ Мафия кому-то заказала деревянный костюм. Размер уточнять не стала.",
  ],
  maniac: [
    "🔪 Маньяк насвистывает в темноте. Лучше бы это был ветер.",
    "🔪 Маньяк точит нож и улыбается своим мыслям. Мысли у него так себе.",
    "🔪 Маньяк ни с кем не договаривается. Командная работа — не его.",
    "🔪 Маньяк выбирает между мафией и мирными. Ему, честно говоря, без разницы.",
    "🔪 Маньяк надел перчатки. Не от холода.",
    "🔪 Маньяк считает окна, где ещё горит свет. Скоро станет на одно меньше.",
  ],
  doctor: [
    "💉 Доктор идёт по пустой улице. Кто-то сегодня будет обязан ему жизнью. Или не будет.",
    "💉 Доктор собрал чемоданчик: бинты, йод и надежда.",
    "💉 Доктор моет руки. Тщательно.",
    "💉 Доктор надеется, что сегодня обойдётся без вскрытия.",
    "💉 Доктор вышел на дежурство.",
    "💉 Доктор шепчет: «Только не сегодня». Кому — врачебная тайна.",
  ],
  komissar: [
    "🕵️ Комиссар листает чужое дело при свете спички.",
    "🕵️ Комиссар пьёт пятый кофе и смотрит на всех недоверчиво.",
    "🕵️ Комиссар крадётся по улице, стараясь не наступить на улики.",
    "🕵️ Комиссар достал лупу.",
    "🕵️ Комиссар не верит никому.",
    "🕵️ Комиссар сверяет показания.",
    "🕵️ Комиссар заглядывает в окна.",
    "🗝️ Комиссар нашёл нужную дверь.",
  ],
  putana: [
    "🌹 Путана красит губки. У кого-то сегодня будет очень занятая ночь.",
    "🌹 Путана вышла на ночную смену. Без выходных, как мафия, только с маникюром.",
    "🌹 Путана стучится в чужую дверь. Хозяин этой ночью уже никуда не пойдёт.",
    "🌹 Путана выбирает, чью ночь сегодня отменить.",
    "🌹 Путана знает: лучший способ остановить преступление — занять преступника.",
    "🌹 Путана не задаёт вопросов. Она просто никого не выпускает из дома.",
    "🌹 Путана накинула шубу. Деревню сегодня спасают не только доктора.",
    "🌹 Путана сверилась с записной книжкой. Постоянные клиенты — вне очереди.",
  ],
  bomzh: [
    "🍾 Бомж пошёл за бутылками. Заодно посмотрит, кто что делал.",
    "🍾 Бомж устроился под чужим окном. Лучший вид на ночную жизнь деревни.",
    "🍾 Бомж всё видит, а его никто не замечает. Идеальный свидетель.",
    "🍾 Бомж копается в мусорке. Улики там тоже бывают.",
    "🍾 Бомж не спит: на трезвую голову ночь видно лучше.",
    "🍾 Бомж греется у костра и считает, кто прошёл мимо.",
    "🍾 Бомж записывает приметы на обрывке газеты.",
    "🍾 Бомж знает в лицо всех, кто гуляет по ночам. Работа такая.",
  ],
  dawn: [
    "🌅 Солнце встаёт неохотно, будто знает, что увидит.",
    "🌅 Петух прокричал. Кажется, единственный, кто выспался.",
    "🌅 Рассвет. Деревня пересчитывает соседей.",
    "🌅 Утро. Пахнет кофе и подозрениями.",
    "🌅 Новый день. Кое-чьи планы на него уже отменены.",
    "🌅 Солнце вышло. Свидетелей, как обычно, нет.",
  ],
};

// Рассказчик «печатает…» и выдаёт случайную ещё не звучавшую в этой партии фразу.
async function atmo(kind) {
  const S = CUR();
  const all = ATMO[kind];
  if (!S || S.aborted || !all) return;
  const used = G.atmoUsed;
  let pool = all.filter((t) => !used.includes(t));
  if (!pool.length) pool = all;                      // все фразы роли уже были (очень длинная партия) — по второму кругу
  const text = pool[(Math.random() * pool.length) | 0];
  used.push(text);
  liveOnly({ type: "typing" });                      // точки — только вживую, в буфер не пишем
  await sleep(ATMO_TYPING_MS);
  if (S.aborted) return;
  console.log(DIM(A(153, "   " + text)));
  broadcast({ type: "atmo", text });
}

// ── Фазы ────────────────────────────────────────────────────────────────
// Что видит бомж у дома: нейтральные действия, по которым роль не угадать (настоящее время — без «он/она»)
const WITNESS = ["крадётся к двери", "заходит в дом и выходит под утро", "стоит под окном", "стучит и входит", "оглядывается у калитки", "быстро проходит к крыльцу"];
// что теряет игрок, к которому пришла путана (заголовок плашки — «К тебе пришла гостья»)
const BLOCK_TEXT = {
  mafia: "Этой ночью ты не выходишь из дома. Без тебя мафия на дело не идёт.",
  maniac: "Этой ночью ты никого не убиваешь.",
  doctor: "Этой ночью ты никого не лечишь.",
  komissar: "Этой ночью проверки не будет. Шепнуть союзнику можно.",
  bomzh: "Этой ночью ты не дежуришь.",
};
// гостья-путана сорвала игроку ночной ход: запоминаем (ИИ увидит в своём досье), человеку — плашка
function blockedNotice(p) {
  G.priv[p.name].blocked.push(G.day);
  secretAct(`🌹 у путаны в гостях: ${p.name} — ночной ход сорван`);
  if (p.human) broadcast({ type: "held", title: "🌹 К тебе пришла гостья", text: BLOCK_TEXT[p.role] || "Этой ночью ты не выходишь из дома." });
}
const rnd = (a) => a[(Math.random() * a.length) | 0];
const NIGHT_ROLES = ["mafia", "maniac", "doctor", "komissar", "bomzh"];   // у кого ночью есть ход — его путана и «задерживает»
// что путана узнаёт о госте (род — по досье: женщина / мужчина / не указан)
function visitText(p, busy) {
  const f = sexOf(p) === "f", u = !sexOf(p);
  return busy ? `🌹 ${p.name} ${u ? "собирался(-ась)" : f ? "собиралась" : "собирался"} куда-то выйти — ты ${f ? "её" : u ? "" : "его"} задержала.`.replace(" ты  задержала", " ты задержала")
              : `🌹 ${p.name} мирно ${u ? "спал(а)" : f ? "спала" : "спал"} — визит впустую.`;
}

function setPhase(ph) { G.phase = ph; broadcast({ type: "phase", phase: ph, day: G.day }); }

async function doNight() {
  narrator(`\n🌙 Ночь ${G.day}. Деревня засыпает.`);
  setPhase("night");
  const alive = living();
  const mafia = alive.filter((p) => p.role === "mafia");
  const maniac = alive.find((p) => p.role === "maniac");
  const doctor = alive.find((p) => p.role === "doctor");
  const kom = alive.find((p) => p.role === "komissar");
  const putana = alive.find((p) => p.role === "putana");
  const bomzh = alive.find((p) => p.role === "bomzh");
  const visits = [];                                   // кто к кому ходил этой ночью — это и видит бомж

  if (alive.some((p) => p.role === "civilian")) await atmo("civilian");

  // ── ПУТАНА — первой: её гость этой ночью свой ход не делает ──
  let pt = null;
  if (putana) {
    await atmo("putana");
    const others = alive.filter((p) => p !== putana);
    if (putana.human) {
      const names = others.map((p) => p.name);
      const hist = G.priv[putana.name].visits;
      const ans = await awaitHuman("visit", { candidates: names, last: hist.length ? hist[hist.length - 1].name : null, history: hist });
      pt = names.includes(ans.target) ? ans.target : rnd(names);
    } else pt = await aiNight(putana, "putana", others);
    // итог визита — без роли: был ли у гостя ночной ход (злодей, доктор, комиссар, бомж) или он простой мирный
    const busy = NIGHT_ROLES.includes(byName(pt).role);
    G.priv[putana.name].visits.push({ night: G.day, name: pt, busy });
    if (putana.human) broadcast({ type: "visit_result", name: pt, busy, text: visitText(byName(pt), busy) });
    visits.push({ from: putana.name, to: pt });
    secretAct(`🌹 путана (${putana.name}) идёт к: ${pt}`);
  }
  const blocked = (p) => !!p && p.name === pt;

  // ── МАФИЯ ──
  let mt = null;
  if (mafia.length) {
    await atmo("mafia");
    const held = mafia.find(blocked);                    // путана держит кого-то из мафии — без своего на дело не идут
    const active = held ? [] : mafia;
    if (held) {
      blockedNotice(held);
      mafia.filter((m) => m !== held).forEach((m) => {
        G.priv[m.name].notes.push(`[ночь ${G.day}] путана держит напарника (${held.name}) — этой ночью мафия на дело не пошла`);
        if (m.human) broadcast({ type: "held", title: "🌹 Путана держит твоего напарника", text: `${held.name} не выходит из дома — мафия этой ночью без дела.` });
      });
    }
    const killable = alive.filter((p) => p.role !== "mafia");
    const humanMafia = active.find((m) => m.human);
    if (!active.length) secretAct(`… мафия этой ночью не убивает: у путаны в гостях мафиози ${held.name}`);
    else if (humanMafia) {
      // Человек в мафии решает жертву. Напарники-ИИ: ночь 1 — передают ход; ночь 2+ — старший предлагает с аргументом.
      const mates = active.filter((m) => m !== humanMafia);
      let suggest = null;
      if (mates.length && G.day > 1) {
        const dec = await aiMafiaSuggest(mates[0], killable);
        suggest = dec.target;
        postPM("mafia", mates[0], mafia, dec.text);
      } else if (mates.length) {
        postPM("mafia", mates[0], mafia, mates.length > 1 ? `Я и ${mates.slice(1).map((m) => m.name).join(", ")} с тобой. Ты за старшего — кого уберём этой ночью?` : "Ты за старшего, напарник. Кого уберём этой ночью?");
      }
      const names = killable.map((p) => p.name);
      const ans = await awaitHuman("kill_mafia", { candidates: names, suggest });
      mt = names.includes(ans.target) ? ans.target : (suggest || rnd(names));
      // выбор объявляется в чате мафии: видят игрок и напарники (ИИ запоминают), остальным — никак
      mafia.forEach((m) => G.priv[m.name].notes.push(`[ночь ${G.day}, чат мафии] ${humanMafia.name} выбирает жертву: ${mt}`));
      broadcast({ type: "mafia_pick", from: humanMafia.name, target: mt, to: mafia.map((m) => m.name) });
      if (mates.length) {   // после выбора — можно шепнуть напарникам реплику, старший ответит (одна реплика)
        const ans2 = await awaitHuman("mafia_say", { to: mates.map((m) => m.name).join(", "), many: mates.length > 1, target: mt });
        const txt = (ans2 && ans2.text || "").toString().trim().slice(0, 200);
        if (txt && !(ans2 && ans2.skip)) {
          postPM("mafia", humanMafia, mafia, txt);
          const rep = await aiMafiaReply(mates[0], txt, mt);
          postPM("mafia", mates[0], mafia, rep);
        }
      }
    } else {
      // Только ИИ-мафия: чат свободных от гостьи + голосование большинством.
      if (active.length >= 2) { const convo = []; for (const m of active) { const t = await aiMafiaChat(m, convo); postPM("mafia", m, mafia, t); convo.push(`${m.name}: ${t}`); await sleep(PACING_MS); } }
      mt = plurality(await Promise.all(active.map((m) => aiNight(m, "kill", killable))));
    }
    if (mt) {
      visits.push({ from: (humanMafia || rnd(active)).name, to: mt });   // «на дело» идёт один из свободных мафиози
      secretAct(`🔪 мафия целится в: ${mt}`);
    }
  }

  // ── МАНЬЯК ──
  let kt = null;
  if (maniac) {
    await atmo("maniac");
    if (blocked(maniac)) blockedNotice(maniac);
    else {
      const prey = alive.filter((p) => p !== maniac);     // маньяк бьёт любого, кроме себя
      if (maniac.human) {
        const names = prey.map((p) => p.name);
        const ans = await awaitHuman("kill_maniac", { candidates: names });
        kt = names.includes(ans.target) ? ans.target : rnd(names);
      } else kt = await aiNight(maniac, "maniac", prey);
      visits.push({ from: maniac.name, to: kt });
      secretAct(`🩸 маньяк (${maniac.name}) целится в: ${kt}`);
    }
  }

  // ── ДОКТОР ──
  let ds = null;
  if (doctor) {
    await atmo("doctor");
    if (blocked(doctor)) blockedNotice(doctor);
    else {
      if (doctor.human) {   // человек-доктор сам выбирает кого лечить (себя можно) — каждую ночь, включая 1-ю
        const names = alive.map((p) => p.name);
        const ans = await awaitHuman("heal", { candidates: names, self: doctor.name });
        ds = names.includes(ans.target) ? ans.target : doctor.name;
      } else ds = G.day === 1 ? doctor.name : await aiDoctorSave(doctor, alive);
      if (ds !== doctor.name) visits.push({ from: doctor.name, to: ds });
      secretAct(`🩺 доктор (${doctor.name}) лечит: ${ds}`);
    }
  }

  // ── КОМИССАР ──
  let komWent = false;                                 // комиссар выходил проверять (бомж это увидит)
  if (kom) {
    await atmo("komissar");
    if (blocked(kom)) blockedNotice(kom);
    else {
      const checkPool = alive.filter((p) => p !== kom && !G.priv[kom.name].checks.some((c) => c.name === p.name));
      if (checkPool.length) {
        const poolNames = checkPool.map((p) => p.name);
        let checkName;
        if (kom.human) { const ans = await awaitHuman("check", { candidates: poolNames }); checkName = poolNames.includes(ans.target) ? ans.target : rnd(poolNames); }
        else checkName = await aiNight(kom, "check", checkPool);
        const tp = byName(checkName); G.priv[kom.name].checks.push({ name: tp.name, role: tp.role });
        visits.push({ from: kom.name, to: tp.name }); komWent = true;
        secretAct(`🔍 комиссар (${kom.name}) проверяет: ${checkName} → ${roleName(tp.role)}`);
        if (kom.human) broadcast({ type: "check_result", name: tp.name, role: tp.role });
      } else { secretAct(`… комиссар (${kom.name}) уже проверил всех живых`); if (kom.human) broadcast({ type: "note", text: "Ты уже проверил всех живых игроков." }); }
    }
    // шёпот — это записка, а не выход из дома: он доступен и тому, кого держит путана
    if (kom.human) {
      const others = alive.filter((p) => p !== kom);
      const ans = await awaitHuman("whisper", { candidates: others.map((p) => p.name) });
      const text = (ans && ans.text || "").toString().trim().slice(0, 200);
      if (ans && ans.to && !ans.skip && text) {
        const rec = byName(ans.to);
        if (rec && rec.alive) { postPM("whisper", kom, [kom, rec], text); const rep = await whisperReply(rec, kom.name, text); postPM("whisper", rec, [kom, rec], rep); }
      } else secretAct("… ты решил не шептаться этой ночью");
    } else {
      const dec = await aiKomWhisper(kom, alive.filter((p) => p !== kom));
      if (dec.to) { const rec = byName(dec.to); postPM("whisper", kom, [kom, rec], dec.text); const rep = await whisperReply(rec, kom.name, dec.text); postPM("whisper", rec, [kom, rec], rep); } else secretAct(`… комиссар (${kom.name}) решил пока не шептаться`);
    }
  }

  if (doctor && ds && ds !== doctor.name) {
    const rec = byName(ds);
    if (rec && rec.alive) {
      if (doctor.human) {   // человек-доктор решает сам: шепнуть спасённому или смолчать
        const ans = await awaitHuman("doc_whisper", { to: rec.name });
        const text = (ans && ans.text || "").toString().trim().slice(0, 200);
        if (text && !(ans && ans.skip)) { postPM("whisper", doctor, [doctor, rec], text); const rep = await whisperReply(rec, doctor.name, text); postPM("whisper", rec, [doctor, rec], rep); }
        else secretAct(`… доктор (${doctor.name}) решил не раскрываться спасённому`);
      } else {
        const dec = await aiDoctorWhisper(doctor, rec);
        if (dec.to) { postPM("whisper", doctor, [doctor, rec], dec.text); const rep = await whisperReply(rec, doctor.name, dec.text); postPM("whisper", rec, [doctor, rec], rep); } else secretAct(`… доктор (${doctor.name}) решил не раскрываться спасённому`);
      }
    }
  }

  // Кто этой ночью ВЫХОДИЛ из дома: вся мафия (на сходку), маньяк, комиссар, путана, доктор (если лечил не себя), бомж.
  // Мирные спят. Кого держит путана — сидит дома. Бомж увидит, выходил ли хозяин дома, у которого он дежурит.
  const wentOut = new Set();
  mafia.forEach((m) => { if (!blocked(m)) wentOut.add(m.name); });
  if (maniac && !blocked(maniac)) wentOut.add(maniac.name);
  if (komWent) wentOut.add(kom.name);
  if (putana) wentOut.add(putana.name);
  if (doctor && ds && ds !== doctor.name) wentOut.add(doctor.name);
  if (bomzh && !blocked(bomzh)) wentOut.add(bomzh.name);

  // ── БОМЖ — последним: видит, кто приходил к выбранному дому (имена, без ролей) и выходил ли хозяин ──
  if (bomzh) {
    await atmo("bomzh");
    if (blocked(bomzh)) blockedNotice(bomzh);
    else {
      const others = alive.filter((p) => p !== bomzh);
      let bt;
      if (bomzh.human) { const names = others.map((p) => p.name); const ans = await awaitHuman("watch", { candidates: names }); bt = names.includes(ans.target) ? ans.target : rnd(names); }
      else bt = await aiNight(bomzh, "watch", others);
      const seenNames = [...new Set(visits.filter((v) => v.to === bt && v.from !== bomzh.name).map((v) => v.from))];
      const seen = shuffle(seenNames).map((n) => ({ name: n, act: rnd(WITNESS) }));   // порядок перемешан — по нему роль не угадать
      const left = wentOut.has(bt);
      G.priv[bomzh.name].watches.push(`ночь ${G.day}, у дома ${bt}: ${seen.length ? "приходили — " + seen.map((x) => x.name).join(", ") : "никто не приходил"}; сам(а) ${bt} ${left ? "ночью ВЫХОДИЛ(А) из дома" : "из дома не выходил(а)"}`);
      secretAct(`🍾 бомж (${bomzh.name}) дежурит у ${bt}: ${seen.map((x) => x.name).join(", ") || "никого"}; хозяин ${left ? "выходил" : "дома"}`);
      if (bomzh.human) broadcast({ type: "watch_result", name: bt, seen, left });
    }
  }

  if (mt) mafia.forEach((m) => G.priv[m.name].kills.push(mt));
  if (maniac && kt) G.priv[maniac.name].kills.push(kt);
  if (doctor && ds) { G.priv[doctor.name].saves.push(ds); G.priv[doctor.name].saveLog.push({ n: G.day, name: ds }); }

  setPhase("dawn");                                    // развязка ночи — щит уже не поставить
  const killed = new Set(); if (mt) killed.add(mt); if (kt) killed.add(kt); if (ds) killed.delete(ds);
  // щит игрока: в него стреляли этой ночью — выжил (утром всем: «выстрел был, а трупа нет», без имени)
  const S = CUR(), hp = G.players.find((p) => p.human);
  if (hp && S.shield.armed === `night:${G.day}` && killed.has(hp.name)) {
    killed.delete(hp.name); G.shieldSaved = true; gamelog.shieldSaved(S.gameId);
    secretAct(`🛡 щит спас ${hp.name} этой ночью`);
  }
  G.lastDead = [...killed].map(byName);
  G.lastDead.forEach((p) => { p.alive = false; p.revealed = p.role; p.outWhen = `ночь ${G.day}`; });
  // журнал ночи — публичные факты: пуль = живых стрелков на начало ночи (мафия — одна пуля на всех, маньяк — одна)
  G.nights.push({ n: G.day, bullets: (mafia.length ? 1 : 0) + (maniac ? 1 : 0), dead: G.lastDead.map((p) => ({ name: p.name, role: p.role })),
    shield: !!G.shieldSaved, doc: !!doctor, put: !!putana });
}

async function announceDead() {
  await atmo("dawn");
  broadcast({ type: "day", day: G.day });
  narrator(`\n☀️ День ${G.day}.`);
  if (G.shieldSaved) { result("🛡 Выстрел был, а трупа нет: кто-то выжил под защитой."); G.shieldSaved = false; }
  else if (!G.lastDead.length) result("Ночь прошла тихо — все живы.");
  else {
    G.lastDead.forEach((d) => { result(`Ночная жертва: ${d.name} — ${roleName(d.revealed)}.`, d.revealed === "mafia" || d.revealed === "maniac"); broadcast({ type: "dead", name: d.name, role: d.revealed }); });
    G.lastOut = G.lastDead.map((d) => ({ name: d.name, role: d.revealed, how: "night" }));   // все погибшие за ночь
  }
  G.lastDead = [];
}

async function doDiscussion() {
  setPhase("day");                                     // обсуждение — щит можно поставить до начала голосования
  for (let round = 1; round <= 2; round++) {
    narrator(`— круг обсуждения ${round}/2 —`);
    for (const p of shuffle(living())) {
      if (p.human) {
        const ans = await awaitHuman("say", { name: p.name, round });
        const msg = (ans.text || "").trim();
        if (!msg || ans.silent) silence(p); else say(p, msg);
        continue;
      }
      const plan = await aiPlan(p, round);
      secretThought(p.name, plan);
      const msg = await aiSpeak(p, round, plan);
      if (/^\s*молч/i.test(msg)) silence(p); else say(p, msg);
      await sleep(PACING_MS);
    }
  }
}

async function doVote() {
  narrator("\n🗳  Голосование.");
  setPhase("vote");
  const alive = living();
  const tally = {};
  for (const p of alive) {
    let r;
    if (p.human) {
      const cands = alive.map((x) => x.name).filter((n) => n !== p.name);
      const ans = await awaitHuman("vote", { candidates: cands });
      let target = ans.target;
      if (!cands.includes(target)) target = cands[(Math.random() * cands.length) | 0]; // подстраховка
      r = { target, reason: clip(ans.reason || "", 140) };
    } else {
      r = await aiVote(p);
    }
    vote(p.name, r.target, r.reason);
    tally[r.target] = (tally[r.target] || 0) + 1;
    if (!p.human) await sleep(PACING_MS);
  }
  const max = Math.max(...Object.values(tally));
  const lynched = byName(shuffle(Object.keys(tally).filter((n) => tally[n] === max))[0]);
  const S = CUR();
  if (lynched.human && S.shield.armed === `day:${G.day}`) {   // щит игрока на голосовании — казнь срывается
    gamelog.shieldSaved(S.gameId);
    result(`🛡 Казнь не состоялась: у ${lynched.name} была защита (${max} гол.).`);
    G.lastOut = [];
    return;
  }
  lynched.alive = false; lynched.revealed = lynched.role; lynched.outWhen = `казнь, день ${G.day}`;
  result(`Казнён ${lynched.name} (${max} гол.). ${lynched.name} — ${roleName(lynched.revealed)}.`, lynched.revealed === "mafia" || lynched.revealed === "maniac");
  G.lastOut = [{ name: lynched.name, role: lynched.revealed, how: "lynch" }];
  broadcast({ type: "dead", name: lynched.name, role: lynched.revealed });
}

function checkWin() {
  const a = living(); const M = a.filter((p) => p.role === "mafia").length; const K = a.filter((p) => p.role === "maniac").length; const T = a.length - M - K;
  if (M === 0 && K === 0) return (G.winner = "town"), true;
  if (M === 0 && T === 0 && K === 1) return (G.winner = "maniac"), true;
  if (M > 0 && M >= T + K) return (G.winner = "mafia"), true;
  if (K === 1 && a.length <= 2) return (G.winner = "maniac"), true;
  return false;
}

function endGame() {
  const w = G.winner;
  const txt = w === "town" ? "🏆 ДЕРЕВНЯ ПОБЕДИЛА." : w === "mafia" ? "🔪 МАФИЯ ПОБЕДИЛА." : "🩸 МАНЬЯК ПОБЕДИЛ.";
  console.log("");
  printLine({ kind: "result", text: txt, red: w !== "town" });   // только в консоль: игроку победу показывает "gameover" (раньше уходила дважды)
  console.log(DIM("Расклад: " + G.players.map((p) => `${p.name}=${roleName(p.role)}`).join(", ")));
  broadcast({ type: "gameover", text: txt });
}

function printCost() {
  const price = PRICES[PROVIDERS[PROVIDER].model] || { in: 0, out: 0 };
  const cost = (USAGE.in / 1e6) * price.in + (USAGE.out / 1e6) * price.out;
  console.log("\n" + BOLD("── Итог по токенам ──"));
  console.log(`Провайдер/модель: ${PROVIDER} / ${PROVIDERS[PROVIDER].model}`);
  console.log(`Вызовов модели:   ${USAGE.calls}`);
  console.log(`Токены вход/выход: ${USAGE.in.toLocaleString()} / ${USAGE.out.toLocaleString()}`);
  if (USAGE.cost > 0) console.log(`Стоимость партии: $${USAGE.cost.toFixed(4)} (точная, по счёту провайдера)`);
  else console.log(`Оценка стоимости партии: ${cost < 0.01 ? "< $0.01" : "$" + cost.toFixed(3)} ${PROVIDER === "mock" ? "(mock — без сети)" : "(по прикидочным ценам, без учёта кэша)"}`);
}

async function gameLoop() {
  const humanName = CUR().humanName;
  // настройки партии: бесплатно — 8 и случайная роль; VIP — размер стола и (по желанию) своя роль
  const setup = CUR().setup || { size: TABLE_MIN, role: null };
  const roleList = composition(setup.size);
  const chars = shuffle(POOL).slice(0, roleList.length);
  CUR().G = { players: chars.map((c) => ({ ...c, alive: true, revealed: null })), priv: {}, day: 1, log: [], atmoUsed: [], lastDead: [], lastOut: null, winner: null, setup: countRoles(roleList) };
  G.players.forEach((p) => (G.priv[p.name] = { checks: [], kills: [], saves: [], saveLog: [], notes: [], visits: [], watches: [], blocked: [] }));
  G.nights = [];   // журнал ночей для «разбора от ведущего»: сколько пуль, кто погиб
  const roles = shuffle(roleList);
  G.players.forEach((p, i) => (p.role = roles[i]));

  // сажаем человека за стол: одно кресло становится твоим (выбранная роль VIP → кресло с этой ролью)
  let humanP = null;
  if (HUMAN) {
    const want = setup.role || HUMAN_ROLE;
    const seats = want ? G.players.filter((p) => p.role === want) : [];
    humanP = seats.length ? rnd(seats) : G.players[(Math.random() * G.players.length) | 0];
    if (humanP) {
      humanP.human = true;
      if (humanName) {                 // переименовываем кресло в ник вошедшего, переносим его «память»
        const old = humanP.name;
        humanP.name = humanName;
        G.priv[humanName] = G.priv[old];
        delete G.priv[old];
      }
      if (CUR().humanAvatar) humanP.av = CUR().humanAvatar;   // своё выбранное лицо вместо лица персонажа
      // пол живого игрока — только по его СОБСТВЕННОЙ аватарке (female/… или male/…); нейтральная или нет своей = не указан
      const ha = String(CUR().humanAvatar || "");
      humanP.sex = /^female\//.test(ha) ? "f" : /^male\//.test(ha) ? "m" : null;
      // своя биография вместо унаследованной от персонажа: только то, что игрок написал сам (пустое = нет)
      const bio = CUR().humanBio || {};
      humanP.age = bio.age >= 18 ? bio.age : null;   // игра 18+: младший возраст из старых анкет за стол не несём
      humanP.job = bio.job || null;
      humanP.hobby = bio.hobby || null;
      humanP.persona = null; humanP.style = null; humanP.think = null;   // характер персонажа человеку не нужен
    }
  }

  broadcast({ type: "reset" });
  broadcast({ type: "roster", day: G.day, setup: G.setup, players: G.players.map((p) => ({ name: p.name, c: p.c, av: p.av, role: p.role, alive: true, age: p.age, job: p.job, hobby: p.hobby, persona: p.persona })) });
  if (humanP) broadcast({ type: "you", name: humanP.name, role: humanP.role });
  if (humanP && humanP.role === "mafia") {
    const mates = G.players.filter((p) => p.role === "mafia" && p !== humanP).map((p) => p.name);
    broadcast({ type: "mates", names: mates });
  }
  if (humanP && CUR().userId) CUR().gameId = gamelog.startGame(CUR().userId, humanP.name, humanP.role, CUR().premium, G.players.length, CUR().ip);   // журнал: партия началась

  console.log(BOLD(`\n════ МАФИЯ · провайдер: ${PROVIDER} · модель: ${PROVIDERS[PROVIDER].model} ════`));
  if (SHOW_SECRETS) {
    console.log(DIM("роли: " + G.players.map((p) => `${p.name}=${roleName(p.role)}`).join(", ")));
    console.log(DIM("характеры: " + G.players.map((p) => `${p.name} [${p.temp.split(" —")[0].split(",")[0]}]`).join(", ")) + "\n");
  }

  let guard = 0;
  while (guard++ < 15) {
    if (CUR().aborted) return;
    await doNight();
    if (CUR().aborted) return;
    await announceDead();
    if (checkWin()) break;
    if (CUR().aborted) return;
    await doDiscussion();
    if (CUR().aborted) return;
    await doVote();
    if (checkWin()) break;
    G.day++;
  }
  if (CUR().aborted) return;
  endGame();
  const hp = G.players.find((p) => p.human);
  if (hp) {
    gamelog.finishGame(CUR().gameId, hp.role, G.winner, G.day, hp.alive);   // журнал: партия доиграна
    // турнирная таблица: сколько очков принесла партия и какое теперь место за неделю
    gamelog.invalidateLeaderboard();
    const pts = gamelog.pointsFor(hp.role, G.winner, hp.alive);
    const lb = CUR().userId ? gamelog.leaderboard("week", CUR().userId, 0) : null;
    // тип аккаунта — для строки под очками: VIP до какого числа / сколько бесплатных партий сыграно сегодня
    const S = CUR();
    const acct = S.premium ? { vip: true, vipUntil: S.vipUntil || null }
      : { vip: false, played: S.userId ? gamelog.finishedToday(S.userId) : 0, limit: FREE_GAMES };
    broadcast({ type: "score", points: pts, rank: lb && lb.me ? lb.me.rank : null, total: lb ? lb.total : null, acct });
  }
  CUR().finishedAt = Date.now();   // партия доиграна — метка для будущей уборки памяти
  printCost();
}

// Поднимаем веб-сервер; каждая партия стартует в /events, когда её игрок открывает вкладку.
startWeb();

// Уборка памяти: раз в 5 минут выметаем партии, доигранные больше 30 минут назад.
// Активные (finishedAt ещё не проставлен) и недавно законченные — не трогаем.
// Брошенные: партия не доиграна, а все вкладки закрыты дольше ABANDON_MIN минут — останавливаем и выметаем.
// Иначе с рекламы партии копились бы в памяти, а ИИ доигрывали бы для пустого зала за твои деньги.
const ABANDON_MIN = Number(process.env.ABANDON_MIN ?? 15);
setInterval(() => { for (const S of sessions.values()) S.clients.forEach((res) => { try { res.write(": ping\n\n"); } catch (_) {} }); }, 20000);

function sweep() {
  const now = Date.now();
  for (const [uid, ps] of pendingStart) if (now - ps.at > PENDING_MS) pendingStart.delete(uid);   // выбор, по которому так и не зашли
  for (const [uid, S] of sessions) {
    if (S.finishedAt && now - S.finishedAt > 30 * 60 * 1000) { sessions.delete(uid); continue; }
    if (!S.finishedAt && !S.clients.length && S.emptySince && now - S.emptySince > ABANDON_MIN * 60 * 1000) {
      S.aborted = true;                                  // ИИ больше не зовём, ход человека не ждём
      if (S.pending) { const p = S.pending; S.pending = null; p.reject(abortError()); }
      sessions.delete(uid);
      console.log(DIM(`🧹 партия игрока #${uid} брошена (вкладка закрыта > ${ABANDON_MIN} мин) — остановлена и выметена`));
    }
  }
}
setInterval(sweep, (Number(process.env.SWEEP_SEC) || 300) * 1000);
