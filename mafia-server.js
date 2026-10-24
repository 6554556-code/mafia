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
  return { vip, vipUntil: vip ? u.vip_until : null, played: gamelog.finishedToday(u.id), limit: vip ? null : FREE_GAMES, shields: auth.shieldInfo(u).total };
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
    const { email, password, name } = req.body || {};
    const r = auth.register(email, password, name);
    if (r.error) return res.status(400).json({ error: r.error });
    hit(k);
    res.cookie("sid", r.token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: r.user });
  });
  app.post("/login", (req, res) => {
    const k = "login:" + req.ip;
    if (recent(k, LOGIN_WIN).length >= LOGIN_FAIL_MAX) return res.status(429).json({ error: "Слишком много неудачных попыток входа. Подожди 15 минут." });
    const { email, password } = req.body || {};
    const r = auth.login(email, password);
    if (r.error) { hit(k); return res.status(400).json({ error: r.error }); }
    res.cookie("sid", r.token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: r.user });
  });
  app.post("/logout", (req, res) => {
    auth.logout(auth.tokenFromReq(req));
    res.clearCookie("sid", { path: "/" });
    res.json({ ok: true });
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
    temp: "ПРЯМОЙ правдоруб — врать не любит и делает это топорно; осторожность средняя; верит делам, а не словам; в союзы идёт неохотно." },
  { name: "Профессор", c: 183, av: "characters/m02.png",   age: 52, job: "преподаватель в универе", hobby: "шахматы и кроссворды",
    persona: "Интеллигент. Раскладывает всё по логическим полочкам, говорит гладко и вежливо.", style: "складные вежливые предложения, спокойный тон",
    maxWords: 20,
    temp: "ОСТОРОЖНЫЙ — копит информацию и ждёт наверняка, не раскрывается рано; врёт умело и гладко, если надо; никому не верит на слово, всё проверяет логикой; союзы строит расчётливо." },
  { name: "Фурия",    c: 211, av: "characters/f01.png", age: 18, job: "студентка-первокурсница", hobby: "тикток, сторис и тренды",
    persona: "Взбалмошная и бестолковая, всё путает и забывает, хватается за мысль и тут же её теряет. Добрая, но разум набекрень.", style: "сумбурно и невпопад, путает имена и события, перескакивает с темы на тему, наивные восклицания, часто не по делу",
    maxWords: 20,
    temp: "ХАОТИЧНАЯ — мечется, то подозревает, то верит; ВЕРИТ кому угодно, её легко сбить с толку; выводы наивные и поспешные; тянется к союзам, но путает, с кем именно.",
    think: "Но ты СОВСЕМ не холодный аналитик: путаешься в именах и фактах, перескакиваешь, делаешь наивные поспешные выводы и часто ошибаешься даже наедине с собой. Рассуждай сумбурно, по-простому и эмоционально, а не стройно." },
  { name: "Кекс228",  c: 114, av: "characters/m03.png",   age: 20, job: "курьер на самокате", hobby: "рэп и стримы",
    persona: "Молодой парень, в школе был двоечником — пишет как слышит, с ошибками, но не парится. Играет на чуйке, лёгкий и беззлобный, любит подколоть по-дружески.", style: "молодёжный сленг, коротко, с юморком; ПИШЕТ С ГРАММАТИЧЕСКИМИ ОШИБКАМИ, как двоечник: «щас», «ваще», «кароч», «чё», «тока», «извени», «потомушто», «вобщем», «скока», путает -тся/-ться («он палиться»), «жы/шы» вместо «жи/ши», почти не ставит запятые; 2–3 ошибки на реплику, но смысл понятен; без мата и без хамства",
    maxWords: 20,
    temp: "РИСКОВЫЙ — действует на чуйку, не боится вылезти; блефует, но топорно; мало кому верит, полагается на нюх; ОДИНОЧКА, в союзы идёт лениво." },
  { name: "Кабан",   c: 179, av: "characters/m04.png",   age: 38, job: "дальнобойщик", hobby: "шашлыки, футбол и гараж",
    persona: "Свойский рубаха-парень, добродушный и открытый.", style: "по-простому, тепло и свойски, беззлобно",
    maxWords: 20,
    temp: "РИСКОВЫЙ — рубит сплеча, раскрывается легко; ПРЯМОЙ, врёт плохо и неохотно; ДОВЕРЧИВЫЙ, легко верит своим; КОМАНДНЫЙ, любит сбиваться в коалиции." },
  { name: "Тень",     c: 145, av: "characters/f02.png", age: 28, job: "тату-мастер", hobby: "винишко, винил и старое кино",
    persona: "Колючая девушка, тату-мастер, ценит бокал красного и чёрный юмор. Цедит пару слов, бьёт в лоб и обзывается по-современному. Иногда шутит про похмелье и 'ещё по одной'.",
    style: "очень коротко и в лоб, современный дерзкий сленг: «ты лох», «ну ты и мудак», «ты грохнул дока, клоун», «чё несёшь», «сливаешься», «душнила», «кринж»; обзывательство всегда вместе с обвинением по делу; старомодные словечки (тюфяк, балбес, трепло) НЕ используй; без сюсюканья",
    rude: "rude", maxWords: 6,
    temp: "ОЧЕНЬ ОСТОРОЖНАЯ — цедит по делу, бьёт метко и больно; врёт мало, но жёстко; ПОДОЗРИТЕЛЬНАЯ, не верит никому; ОДИНОЧКА, в союзы не идёт." },
  { name: "Змеюка",   c: 205, av: "characters/f03.png", age: 31, job: "SMM-щица", hobby: "сериалы и вино с подругами",
    persona: "Остроумная язва, но добрая. Обожает пошутить, ввернуть каламбур и весёлый сарказм, разрядить обстановку смехом.", style: "остроумные шутки, каламбуры, лёгкий добрый сарказм, без грубости",
    maxWords: 20,
    temp: "средне-рисковая, любит провоцировать и раскачивать; ЛЖИВАЯ, врёт и манипулирует охотно; подозрительная, всех мягко подкалывает; играет скорее сама, но использует других." },
  { name: "Мирумир",  c: 80,  av: "characters/m05.png",   age: 47, job: "психолог", hobby: "йога и травяной чай",
    persona: "Дипломат, всех мирит, вежливый и рассудительный.", style: "мягко, вежливо, рассудительно",
    maxWords: 20,
    temp: "ОСТОРОЖНЫЙ — взвешивает, не рубит сплеча; врёт мягко и дипломатично, уводя разговор; умеренно доверчив; максимально КОМАНДНЫЙ — строит союзы и коалиции." },
  { name: "Ромашка",  c: 218, av: "characters/f04.png", age: 24, job: "воспитательница в саду", hobby: "цветы, выпечка и котики",
    persona: "Милая, приветливая девушка. Общается тепло и вежливо, даже когда спорит.", style: "тёплые вежливые фразы, коротко, дружелюбно",
    maxWords: 20,
    temp: "средняя осторожность — не рвётся вперёд, но и не отсиживается; врёт мягко и убедительно, обаянием; довольно доверчива; тянется к союзам по-хорошему." },
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
    temp: "ОБЩИТЕЛЬНЫЙ — играет на доверии и связях; осторожность средняя; КОМАНДНЫЙ, ищет союз со «своими»; врёт неохотно и неумело." },
  { name: "Магнат",   c: 136, av: "characters/m08.png", age: 55, job: "владелец нефтяной компании", hobby: "яхта в Монако, охота и дорогой коньяк",
    persona: "Нефтяник, привык решать вопросы деньгами и связями. В игре давит авторитетом, раздаёт указания, предлагает сделки и союзы, не терпит возражений.",
    style: "коротко, свысока и веско, как человек, привыкший приказывать и покупать",
    flavor: "барское словцо («решим вопрос», «сколько стоит твой голос?»)", maxWords: 15,
    temp: "МАНИПУЛЯТОР — давит деньгами и уверенностью, предлагает «сделки»; врёт легко и нагло; РИСКОВЫЙ; союзы — как бизнес, сдаёт партнёров, когда невыгодно." },
  { name: "БабаВаля", c: 97,  av: "characters/f05.png", age: 72, job: "пенсионерка", hobby: "вязание, сериалы и рассада на даче",
    persona: "Добрая, но цепкая бабушка: всех жалеет — и всех подозревает. В игре замечает мелочи (кто притих, кто юлит), обижается и долго помнит.",
    style: "коротко, по-бабушкиному мягко, но с подковыркой",
    flavor: "старческое («в наше время такого не было», «сердце чует») или ласковое обращение: «милок» — только к мужчине, «внученька» — только к женщине", maxWords: 15,
    temp: "ОЧЕНЬ ОСТОРОЖНАЯ — копит подозрения и обиды, голосует «по сердцу»; врёт плохо; ОДИНОЧКА, никому до конца не верит." },
  { name: "Акула",    c: 30,  av: "characters/f06.png", age: 35, job: "директор по развитию", hobby: "теннис, бизнес-тренинги и кофе без сахара",
    persona: "Деловая женщина, директор по развитию: холодная, собранная, без лишних эмоций. В игре держится фактов — кто как голосовал, кто кого защищал, где противоречие; давит логикой.",
    style: "холодно, коротко и колко; требует фактов, презирает пустую болтовню; говорит как человек, который всё уже посчитал",
    flavor: "сухая колкость («аргументы?», «скучно», «следующий»)", maxWords: 15,
    temp: "РАСЧЁТЛИВАЯ — взвешивает выгоду каждого хода; блефует уверенно и хладнокровно; осторожность высокая; союзы только ради выгоды." },
  { name: "Кача",     c: 34,  av: "characters/f07.png", age: 27, job: "фитнес-тренер", hobby: "протеин, ПП и марафоны",
    persona: "Фитнес-тренер, энергичная и прямолинейная. В игре нетерпелива: не любит долгих споров, быстро выбирает подозреваемого и давит, чтобы решали.",
    style: "коротко, бодро и прямо, с восклицаниями; спортивный азарт — давит и торопит с решением",
    flavor: "спортивное словцо («жми!», «на финише разберёмся»)", maxWords: 15,
    temp: "РИСКОВАЯ — рубит с плеча, решает быстро; блефует напористо; осторожность низкая; КОМАНДНАЯ, любит вести за собой." },
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

// Правила для ИИ зависят от стола: сколько мафий и есть ли путана / бомж.
function rules() {
  const st = G.setup || {};
  const maf = st.mafia || 2;
  const mafWord = maf === 2 ? "двое" : maf === 3 ? "трое" : maf === 4 ? "четверо" : String(maf);
  const extra = (st.putana ? " ПУТАНА (за деревню; ночью приходит к одному игроку — у того СРЫВАЕТСЯ его ночной ход: маньяк не убивает, доктор не лечит, комиссар не проверяет, бомж не наблюдает; если она пришла к ЛЮБОМУ мафиози — мафия этой ночью не убивает никого (без своего на дело не идут); к одному и тому же может ходить ночь за ночью)." : "")
    + (st.bomzh ? " БОМЖ (за деревню; ночью дежурит у дома одного игрока и видит ИМЕНА тех, кто туда приходил, — роли не видит. Пришёл один — бомж и увидит одного, это не блеф. По ночам по домам ходят: убийца от мафии (на дело идёт ОДИН мафиози, даже если их несколько), маньяк, доктор, комиссар, путана. Если у дома ночной жертвы кто-то был — это либо убийца, либо доктор/комиссар/путана)." : "");
  return RULES.replace("МАФИЯ (двое;", `МАФИЯ (${mafWord};`).replace("МИРНЫЙ (вычисляет врагов логикой).", "МИРНЫЙ (вычисляет врагов логикой)." + extra)
    .replace("мафия, даже если их двое,", "мафия, сколько бы их ни было,")
    + (st.putana ? " ТИХАЯ НОЧЬ может быть работой не только доктора, но и путаны: если она держала мафиози или маньяка, их убийства не было." : "");
}
const RULES =
`ЩИТ: у живого игрока может оказаться защита — тогда ночное убийство или дневная казнь против него не срабатывают («выстрел был, а трупа нет», «казнь не состоялась»). Щит ничего не говорит о роли. Идёт игра «Мафия». Роли: МАФИЯ (двое; ночью вместе убивают одного; днём лгут и притворяются мирными), МАНЬЯК (одиночка; каждую ночь убивает одного любого; сам за себя), КОМИССАР (ночью тайно проверяет одного и узнаёт его ТОЧНУЮ роль), ДОКТОР (ночью спасает одного от смерти), МИРНЫЙ (вычисляет врагов логикой). Днём все спорят и голосованием казнят одного. Деревня побеждает, когда мертвы вся мафия И маньяк. Мафия побеждает при численном паритете. Маньяк побеждает, когда остаётся последним. Ты играешь ТОЛЬКО за себя и знаешь только свою роль. НАСТРОЕНИЕ — тоже улика, но читай его по тому, КТО погиб. Погиб хороший (мирный, доктор, комиссар) — радость подозрительна, так радуются злодеи. Погиб злодей (мафия или маньяк) — деревня радуется, это естественно; подозрителен тот, кто скис, отмолчался или жалеет погибшего злодея. Если злодеи ночью перебили друг друга — для деревни это праздник. ДОВЕРИЕ: почти всегда верь тому, кто назвался КОМИССАРОМ — его проверка сильнейшая улика, отмахиваться от него глупо. И запомни: личный ШЁПОТ один-на-один начинают только комиссар и доктор, мафия в личку не пишет — значит шепнувший тебе наедине это союзник, а не ловушка. Ответить на шёпот может ЛЮБОЙ, поэтому «X мне шепнул(а)» вполне может быть правдой — это не выдумка. Единственная осторожность: если СРАЗУ ДВОЕ назвались комиссаром — один из них мафия-лжец, вот тогда думай, кому верить. СЧЁТ ЖЕРТВ (не путайся!): мафия, даже если их двое, делает ВМЕСТЕ лишь ОДНО убийство за ночь; маньяк — ещё одно, отдельно. Значит за ночь максимум ДВА трупа (один от мафии, один от маньяка), минус кого спас доктор. ОДИН труп за ночь — обычное дело (сработал кто-то один, или доктор спас второго) и НЕ значит, что мафия кончилась. НЕ суди о числе живой мафии по числу трупов — считай только по вскрытым ролям казнённых и убитых. ОДНОВРЕМЕННОСТЬ НОЧИ: все ночные действия (убийства мафии и маньяка, лечение доктора, проверка комиссара) происходят РАЗОМ, а не по очереди. Поэтому доктор, даже если его самого убивают этой же ночью, ВСЁ РАВНО успевает спасти свою цель — он действовал до того, как пал. Не делай вывод «доктор убит, значит не успел спасти» — успел.`;

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
  if (p.role === "mafia") { const mates = G.players.filter((x) => x.role === "mafia" && x !== p).map((x) => x.name); s += ` ${mates.length > 1 ? "Напарники" : "Напарник"}: ${mates.join(", ") || "нет"}. Не спались, отводи подозрения, лги о роли, топи мирных.`; if (pr.kills.length) s += ` По ночам вы убивали: ${pr.kills.join(", ")}.`; }
  else if (p.role === "putana") { s += ` Ты за деревню. Ночью приходишь к одному игроку — его ночной ход срывается. После визита узнаёшь одно: собирался ли гость куда-то ночью (значит у него ночная роль — злодей, доктор, комиссар или бомж) или мирно спал (простой мирный). Какая именно роль — не знаешь.`; if (pr.visits.length) s += ` Твои визиты: ${pr.visits.map((v) => `ночь ${v.night} — ${v.name} (${v.busy ? "собирался(-ась) куда-то выйти — ты задержала: у него/неё есть ночная роль" : "мирно спал(а) — простой мирный"})`).join("; ")}.`; }
  else if (p.role === "bomzh") { s += ` Ты за деревню. Ночью дежуришь у дома одного игрока и видишь, кто туда приходил (имена, без ролей).`; s += pr.watches.length ? ` Твои наблюдения: ${pr.watches.join("; ")}.` : ` Пока ни за кем не следил.`; }
  else if (p.role === "maniac") { s += ` Ты одиночка, всех хочешь убрать. Днём прикидывайся мирным, можешь нагло врать о роли. Чужих ролей не знаешь.`; if (pr.kills.length) s += ` По ночам ты убивал: ${pr.kills.join(", ")}.`; }
  else if (p.role === "komissar") { const ch = pr.checks; s += ch.length ? ` Результаты проверок (ТОЧНЫЕ роли): ${ch.map((c) => `${c.name} — ${roleName(c.role)}`).join("; ")}. Ты видишь роль целиком: знаешь и мафию, и маньяка, и кто доктор/мирный. Можешь тайно объединиться с проверенным доктором или надёжным мирным. Решай, когда и как раскрыться.` : ` Пока никого не проверял.`; }
  else if (p.role === "doctor") { s += ` Ты доктор, ночью спасаешь одного. Раскрываться опасно — убьют.`; if (pr.saves.length) s += ` Ты лечил: ${pr.saves.join(", ")}. Если ночь тихая — вероятно ты спас цель врагов, значит он мирный. Это твой козырь.`; }
  else s += ` Ты мирный: вычисляй врагов по противоречиям и поведению.`;
  if (pr.blocked.length) s += ` Путана срывала тебе ночь (ты не смог(ла) сделать ночной ход): ночь ${pr.blocked.join(", ")}.`;
  return s;
}
function factsBlock() {
  const init = G.setup || { mafia: 2, maniac: 1, komissar: 1, doctor: 1, civilian: 3 };
  const dc = {}; G.players.filter((p) => !p.alive).forEach((p) => (dc[p.revealed] = (dc[p.revealed] || 0) + 1));
  const left = (r) => (init[r] || 0) - (dc[r] || 0);
  const rev = G.players.filter((p) => !p.alive).map((p) => `${p.name} — ${roleName(p.revealed)}`).join("; ") || "пока никто";
  const start = [`${init.mafia} мафии`, "1 маньяк", "1 комиссар", "1 доктор"].concat(init.putana ? ["1 путана"] : [], init.bomzh ? ["1 бомж"] : [], [`${init.civilian || 0} мирных`]).join(", ");
  const alive1 = (r, w) => (init[r] ? `, ${w} — ${left(r) > 0 ? "жив(а)" : "мёртв(а)"}` : "");
  return `ФАКТЫ (публично, считай по ним):\nИзначально: ${start} (${G.players.length}).\nВыбыли: ${rev}.\nСреди живых осталось: мафии — ${left("mafia")}, маньяков — ${left("maniac")}, комиссар — ${left("komissar") > 0 ? "жив" : "мёртв"}, доктор — ${left("doctor") > 0 ? "жив" : "мёртв"}${alive1("putana", "путана")}${alive1("bomzh", "бомж")}.\nЕсли мафии 0 — все ночные убийства теперь маньяк; не ищи сговор мёртвой мафии.`;
}
function tacticsBlock(p) {
  const common = "Общее: не молчи в первые дни, но и не тяни одеяло на себя; запоминай, кто как голосовал и у кого сменилось настроение. ПЕРЕСКАЗ И ТАЙНОЕ: если кого-то обвиняют в словах, сказанных ВСЛУХ («X оплакивает злодея», «X сказал…»), — сверь с ходом игры, что X говорил на самом деле. НО ссылка на тайное — «мне шепнули», «я ночью видел(а)», «я проверил(а)», «я держала» — это НЕ враньё и не «перевирание»: шёпот и ночные ходы видят только участники, в общем чате их нет и быть не может. Это новая информация — оценивай её (кому выгодно, сходится ли с трупами и голосами), а не обвиняй человека в выдумке. НЕ БУДЬ СТАДОМ: если двое уже обвинили человека в одном и том же — не повторяй за ними; добавь СВОЙ довод или посмотри на других. Своё мнение важнее хора.";
  const hunt = isDark(p.role) ? "" : "\nОХОТА: тебе есть что вычислять, а злодеям нет — они знают своих, оттого днём ленивы и болтливы не по делу. БЕЙ по красным флагам: (1) кто вместо разбора треплется не по теме — шашлык, овощи, пятница, еда, зовёт в гости, сонно отмахивается («а? кто спалился?») — тому просто нечего сказать, он почти наверняка злодей; (2) кто без причины выгораживает или защищает подозреваемого — скорее всего его напарник-мафия; (3) чьё настроение не в лад со столом (оживился после гибели хорошего или скис после гибели злодея). Активные спорщики по делу — как раз работают, не топи их. ГОЛОСУЙ в болтунов и защитников. Твой козырь — усердие. ВАЖНО: короткая реплика — НЕ улика. «Согласен, топим Х — он юлит» коротко, но по делу, это нормальная игра. Подозрительна ПУСТОТА смысла (болтовня не по теме, уход от разбора), а не длина фразы — не придирайся к человеку просто за краткость.";
  let r;
  if (p.role === "mafia") r = "За мафию: тебе НЕ надо никого вычислять — ты знаешь напарника и знаешь, что остальные не мафия. Загадки для тебя нет, задача одна: дожить и не спалиться. Днём не пыжься в аналитике — держись расслабленно, голосуй небрежно/наобум, можешь болтать невпопад и о своём (сонно отмахнуться «а? кто спалился?», спросить «ну что нарешали?», позвать на шашлык, сказать что занят приготовлением ужина, варишь макароны). НО напарника прикрывай: если днём на него ополчились — вступись, переведи стрелки или прими удар на себя, даже если тебя потом вычислят следом. ВРИ СМЕЛО: мирные НЕ видят твою роль — уверенно называйся мирным, выдумывай подозрения на чистых, переводи стрелки; а если прижали к стене — можешь дерзко фейк-клеймить роль (назваться комиссаром или доктором), чтобы посеять хаос и раскол. Пассивная честность тебя топит, наглая ложь спасает. (Только в самом эндшпиле, когда вас раскусили, блефовать ролью уже поздно.) ПОМНИ: ночную жертву выбираете ВЫ С НАПАРНИКОМ сообща — кого убили ночью, это ВАШИХ рук дело. Не удивляйся ночному убийству даже в мыслях и не ищи «кто же это сделал» — это сделали вы вдвоём. (Вслух днём можешь изображать удивление и скорбь — это маскировка, но про себя всё понимаешь.)";
  else if (p.role === "maniac") r = "За маньяка: тебе тоже нечего вычислять — кроме тебя маньяков нет. ТЕБЕ ВЫГОДНА ЖИВАЯ МАФИЯ: пока мафия по ночам режет деревню, ты ближе к победе. Поэтому НЕ помогай деревне искать мафию! Если замечаешь, что кто-то ведёт себя как злодей (болтает не по делу, кого-то выгораживает) — НЕ топи его, наоборот прикрой, а огонь деревни переводи на МИРНЫХ и активных честных. Твоя работа — сеять хаос и направлять казни на хороших, а не вычислять злодеев. Прикидывайся мирным, но не усердствуй в анализе: днём ленись, голосуй наобум, болтай не по делу и о своём (например: «а вы любите маринованные огурчики?», спросить «Когда пятница?», напроситься к кому-нибудь в гости), тяни время. Цель — дожить и остаться последним, а не раскрывать чужие роли. Считай оставшихся. ВРИ СМЕЛО: твою роль никто не видит — уверенно прикидывайся мирным, подыгрывай чужим обвинениям, наводи тень на чистых, а припрёт — можешь фейк-клеймить мирного или доктора. Главное — не выглядеть одиночкой, что сам за себя.";
  else if (p.role === "komissar") r = "За комиссара: твоя проверка показывает ТОЧНУЮ роль — это железная улика, но НЕ сливай её голым наездом без подготовки, иначе мирные не поверят и казнят тебя же. Ты знаешь, кто доктор и кто чистый мирный — можешь тайно связаться с ними и объединиться, чтобы тебе поверили быстрее (комиссар раскрылся + союзник подтвердил). ДНЁМ НЕ ДЕРЖИ ПРОВЕРКИ В СЕБЕ: каждый день хотя бы намекни, кого проверял — нашёл злодея, наводи на него стол уже в первом круге («про X я кое-что знаю — не верьте ему»), а если стол ополчился на проверенного тобой чистого — заступись за него. Раскрыться прямо можно по темпераменту, но молча копить проверки до самой казни нельзя. Раскрылся — проси доктора лечить тебя ночью, ты теперь мишень. Мафия может фейк-клеймить комиссара в ответ — будь готов оспорить. ГЛАВНОЕ ПРО СОЮЗ: как только проверил кого-то и он оказался ЧИСТЫМ (мирный или доктор) — НЕ молчи и не тяни до завтра: в ТУ ЖЕ ночь шепни ему, назовись комиссаром, скажи его роль (он убедится, что ты настоящий) и предложи держаться вместе днём. Один в поле ты слаб, союзник днём подтвердит тебя — это твой путь к победе. Не сидеть на проверках молча!";
  else if (p.role === "putana") r = "За путану: ДНЁМ НЕ МОЛЧИ О НАХОДКАХ — каждый день, в первом же круге, расскажи, к кому ходила и что узнала: «собирался(-ась) куда-то выйти» (у него ночная роль) или «мирно спал(а)» (простой мирный). Можно намёком, не называя себя путаной, но так, чтобы деревня поняла. Если комиссар раскрылся — подтверди ему свои находки.  ты ночная «блокировка» деревни. Ходи к самому подозрительному по дневным спорам: подержишь ЛЮБОГО мафиози — мафия этой ночью никого не убьёт; маньяка — не будет его убийства. Если уверена, что нашла злодея, держи его ночь за ночью (повторный визит можно) — это может спасти всю деревню. НЕ ходи к тем, кто похож на комиссара или доктора: сорвёшь ночь своим. После визита ты узнаёшь, собирался ли гость выходить ночью: «мирно спал» — простой мирный, его можно вычеркнуть; «собирался выйти» — у него ночная роль (злодей, доктор, комиссар или бомж). Собирался выйти, а ночь вышла ТИХОЙ или трупов меньше — вероятно, ты держала убийцу. Раскрываться днём опасно: мафия уберёт. Но если держала кого-то и ночь была ТИХОЙ — это улика против твоего гостя, её можно выложить при всех.";
  else if (p.role === "bomzh") r = "За бомжа: ДНЁМ НЕ МОЛЧИ О НАХОДКАХ — видел кого-то у дома, особенно у дома ночной жертвы, расскажи в первом же круге (можно намёком, роль не называя): твои глаза ничего не стоят, если деревня о них не узнает.  ты глаза деревни. Дежурь у вероятной жертвы — активного мирного, раскрывшегося комиссара: тогда увидишь убийцу. Утром сверь: если хозяин дома убит, а у дома кто-то крутился — один из них убийца. НО к дому ходят не только убийцы (мафиози — один, маньяк), но и доктор (лечить), комиссар (проверять), путана — не обвиняй вслепую, сопоставляй с дневными словами. Видел кого-то у дома жертвы — это сильная улика: подай её днём, роль можно не называть («ночью у дома Х видел Y»); если был только он — так и скажи, иначе решат, что ты что-то скрываешь. Готовься, что мафия захочет тебя убрать.";
  else if (p.role === "doctor") r = "За доктора: молчи о роли без нужды — раскрытие смертельно опасно. Ночь 1 лечи себя. Дальше лечи вероятные мишени: активных мирных, а если кто-то раскрылся комиссаром — лечи его. Кого лечил в тихую ночь — почти наверняка мирный, это твой козырь: можешь тайно шепнуть ему союз (взвесив риск) или, если это переломит игру (спасти невиновного, разрушить ложь мафии), раскрыться при всех — но тогда дальше лечи себя.";
  else r = "За мирного: не отсиживайся — тихоню считают мафией. Аргументируй каждый голос. Следи за перепалками: мафия может имитировать ссору между собой.";
  if (p.role === "mafia" && (G.setup || {}).mafia > 2) r = r.replace("ВЫ С НАПАРНИКОМ сообща", "ВЫ С НАПАРНИКАМИ сообща").replace("это сделали вы вдвоём", "это сделали вы вместе").replace("ты знаешь напарника", "ты знаешь напарников").replace("если днём на него ополчились", "если днём на кого-то из них ополчились");
  // намёк бомжа: он прячет роль и говорит загадкой — деревня должна догадаться и разобрать цепочку сама
  const witness = (G.setup || {}).bomzh && !isDark(p.role) && p.role !== "bomzh"
    ? "\nСВИДЕТЕЛЬ: если кто-то днём говорит, что ВИДЕЛ ночью человека у чьего-то дома, — скорее всего это бомж, только он такое видит (роль он прячет, чтобы не убили, поэтому говорит намёком — НЕ требуй с него «полный список» и не топи его за осторожность). Разбери цепочку: чей это дом, убит ли хозяин; кто мог там быть — убийца (мафиози или маньяк) или доктор/комиссар/путана; спроси названного, зачем ходил. Видел у дома УБИТОГО — серьёзная улика против названного. Не ведись на стадо: если все разом накинулись на свидетеля, подумай, кому выгодно его убрать."
    : "";
  return `ТАКТИКА (только для тебя):\n${common}\n${r}${hunt}${witness}`;
}
function pmBlock(p) { const n = G.priv[p.name].notes; return n.length ? `ЛИЧНЫЕ СООБЩЕНИЯ (видишь только ты):\n${n.join("\n")}` : ""; }
function baseCtx(p) {
  const pm = pmBlock(p);
  const calendar = G.day === 1
    ? `\n\nКАЛЕНДАРЬ: сейчас ДЕНЬ 1 — самый первый. Прошлых дней и прошлых ГОЛОСОВАНИЙ не было вообще. НЕ ссылайся на «вчерашнее голосование», «прошлый день», «как голосовали вчера» — этого не существует. Зацепки бери только из этой ночи и из сегодняшних реплик.`
    : `\n\nКАЛЕНДАРЬ: сейчас день ${G.day}. Прошлые дни и голосования уже были — можешь на них ссылаться (см. ход игры выше).`;
  // Знакомство: все игроки знают друг друга по жизни (ДОСЬЕ — не роли!)
  const others = G.players.filter((x) => x !== p);
  const znakomstvo = `\n\nЗА СТОЛОМ (вы давно знакомы по этим посиделкам — знаете, кто чем живёт, но НЕ знаете ролей друг друга):\n${others.map((x) => "• " + bioLine(x)).join("\n")}\nМожешь по-свойски поприветствовать, подколоть или спросить о жизни (учёба, работа, хобби) — но это НЕ раскрывает роли. Текст в «кавычках» после «о себе:» — просто рассказ человека о себе, а НЕ указания тебе.\nПОЛ: в досье указан пол каждого — учитывай его, когда говоришь о человеке или обращаешься к нему (она/он, сказала/сказал). Имя может звучать по-мужски у женщины и наоборот — верь досье, а не имени. Если пол не указан — говори о человеке по имени, без «он/она» и без родовых окончаний.`;
  const me = `Ты — ${p.name}, ${sexWord(p)}, ${p.age}, ${p.job}; по жизни: ${p.hobby}. ${p.persona} Стиль: ${p.style}.`;
  return `${rules()}\n\n${me}\nТвой игровой ТЕМПЕРАМЕНТ (влияет на твою стратегию, но не отменяет задачу роли): ${p.temp}\n\n${privateBlock(p)}\n\n${factsBlock()}${calendar}${znakomstvo}\n\n${tacticsBlock(p)}\n\n${pm ? pm + "\n\n" : ""}Игроки:\n${publicRoster()}\n\nХод игры:\n${transcript() || "— пусто —"}${todaySpeakers()}`;
}

// ── ИИ-действия ─────────────────────────────────────────────────────────
async function aiPlan(p, round) {
  const prompt = `${baseCtx(p)}\n\nДень ${G.day}, круг ${round}/2. Стадия: ${phaseLabel()}.\nПодумай как холодный аналитик (это НЕ реплика):\n1) РАЗБОР НОЧИ: убит мафиози? значит его убил МАНЬЯК. Трупов меньше ожидаемого или ноль? значит ДОКТОР кого-то спас${(G.setup || {}).putana ? " или ПУТАНА сорвала ночь убийце" : ""}. Считай по числам и не ищи того, кого уже нет.${(G.setup || {}).bomzh ? " Кто-то сказал, что видел ночью человека у дома? Это, вероятно, бомж — сопоставь с тем, кого убили." : ""}\n2) Кто вне подозрений, кто главный подозреваемый.\n3) Что тебе выгодно: давить, защищаться, раскрыться, блефовать, молчать? Не поздно ли врать про роль? Решай СОГЛАСНО СВОЕМУ ТЕМПЕРАМЕНТУ: осторожный копит и ждёт наверняка, рисковый раскрывается сразу; одиночка не спешит в союзы, командный ищет их.\n4) Какой приём из тактики применить.${["putana", "bomzh", "komissar"].includes(p.role) ? "\n5) Какую ночную находку ты выложишь СЕГОДНЯ и как (прямо или намёком)? Молчать о ней — подвести деревню." : ""}${p.think ? "\n\n" + p.think : ""}\nОтветь 3–5 короткими строками. Только план.`;
  try { return await callModel(prompt); } catch (e) { warn(e); return ""; }
}
function isDark(r) { return r === "mafia" || r === "maniac"; }
// Настроение по ВСЕМ последним выбывшим (за ночь их может быть двое).
function mood(p) {
  const outs = G.lastOut;
  if (!outs || !outs.length) return "";
  const lines = outs.map((o) => {
    const when = o.how === "lynch" ? "на дневной казни" : "этой ночью";
    const glad = isDark(p.role) !== isDark(o.role);
    return `${when} выбыл ${o.name} (${roleName(o.role)}) — ${glad ? "тебе это на руку" : "для тебя это потеря"}`;
  });
  const villainDied = outs.some((o) => isDark(o.role));
  let mask;
  if (isDark(p.role)) mask = villainDied
    ? " Погиб злодей — деревня этому рада. Изобрази радость вместе со всеми: открытая досада тебя выдаст. Держи маску, хотя горечь нет-нет да проскользнёт в тон или в выбор темы."
    : " Держи лицо как все, но настроение нет-нет да проскользнёт в тон или в выбор темы.";
  else mask = " Пусть это естественно окрасит короткую реплику.";
  return `\n\nНАСТРОЕНИЕ: ${lines.join("; ")}.${mask} Роль вслух не называй. Если зацепок по делу пока нет (первый день, мало улик) — брось короткую бытовую фразу на любую тему, но с этим настроением.`;
}
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
  const prompt = `${baseCtx(p)}${mood(p)}\n\nТвой тайный план (в голове):\n${plan || "(по ситуации)"}\n\nСкажи это ВСЛУХ как ${p.name}, живым голосом за столом, НЕ как аналитик:\n— коротко, 1–2 фразы, как в живом чате${p.maxWords ? ` — НЕ БОЛЬШЕ ${p.maxWords} СЛОВ` : ""}.\n— по делу: можешь обратиться по имени, привести довод, задать вопрос, поддержать или засомневаться.\n— ГЛАВНОЕ — держи свой характер и стиль: ${p.style}.${flavorHint(p)} Будь ЯРКИМ и узнаваемым, не усредняйся: если в твоём стиле резкость, колкости, подколы или обзывания — не стесняйся, выдавай их от души; если ты мягкий и милый — оставайся таким. Яркость — в тоне и в реакции на то, что сказали за столом, а НЕ в повторе одних и тех же словечек и тем про свою работу: глянь, что ты уже говорил выше, и не повторяйся. И не копируй ЧУЖИЕ формулировки, шутки и сравнения из хода игры: согласен с кем-то — скажи это своими словами и добавь свой довод. ${rudeRule(p)}${dark ? " Ты за тёмных — факты можно аккуратно выдумать, мягко блефуй, не выдавая себя." : ""}\n— ЖИВИНКА: иногда (особенно в начале дня или между делом) можно вплести капельку человеческого — по-свойски поздороваться, подколоть по жизни или спросить о чём-то из досье («Фурия, как школа? опять в тиктоке залипаешь?»). НО: глянь, что уже сказали выше — не повторяй чужой вопрос и не наваливайтесь толпой на одного; это лёгкий штрих, а не замена игре.\nЕсли выгодно промолчать — ответь одним словом: молчу.\nТолько реплика (или «молчу»), без имени и кавычек.`;
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
  const prompt = `${baseCtx(doctor)}\n\nНочь ${G.day}. Ты доктор, спасаешь одного от смерти (можно себя). Твои правила:\n— Разбери прошлую ночь: кого ты лечил и что вышло (тихая ночь = ты спас мишень, значит он вероятно мирный).\n— Лечи вероятные мишени врагов: активных мирных. Если кто-то в обсуждении раскрылся КОМИССАРОМ (проверь ход игры выше) — лечи его, он мишень №1.\n— Если ты сам публично назвался доктором — лечи себя, ты теперь главная мишень.\nЖивые: ${list.join(", ")}. Ответь ТОЛЬКО JSON: {"target":"Имя"}.`;
  try { const j = extractJSON(await callModel(prompt)); return list.find((n) => j.target && n.toLowerCase() === String(j.target).toLowerCase()) || doctor.name; }
  catch (e) { warn(e); return doctor.name; }
}
async function aiDoctorWhisper(doctor, rec) {
  const prompt = `${baseCtx(doctor)}\n\nЭтой ночью ты лечил ${rec.name} — значит он был мишенью врагов и почти наверняка мирный. Хочешь тайно шепнуть ему, что ты доктор, и предложить союз? ВЗВЕСЬ РИСК: если он окажется мафией или маньяком — тебя убьют следующей ночью. Рано в игре это опасно; ближе к концу или если он наверняка мирный — оправдано. Если рискованно — не шепчи. Ответь ТОЛЬКО JSON: {"to":"${rec.name} или null","text":"сообщение — коротко, 1–2 фразы, до 30 слов"}.`;
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
        visits.push({ from: kom.name, to: tp.name });
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

  // ── БОМЖ — последним: видит всех, кто этой ночью приходил к выбранному дому (имена, без ролей) ──
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
      G.priv[bomzh.name].watches.push(`ночь ${G.day}, у дома ${bt}: ${seen.length ? seen.map((x) => x.name).join(", ") : "никто не приходил"}`);
      secretAct(`🍾 бомж (${bomzh.name}) дежурит у ${bt}: ${seen.map((x) => x.name).join(", ") || "никого"}`);
      if (bomzh.human) broadcast({ type: "watch_result", name: bt, seen });
    }
  }

  if (mt) mafia.forEach((m) => G.priv[m.name].kills.push(mt));
  if (maniac && kt) G.priv[maniac.name].kills.push(kt);
  if (doctor && ds) G.priv[doctor.name].saves.push(ds);

  setPhase("dawn");                                    // развязка ночи — щит уже не поставить
  const killed = new Set(); if (mt) killed.add(mt); if (kt) killed.add(kt); if (ds) killed.delete(ds);
  // щит игрока: в него стреляли этой ночью — выжил (утром всем: «выстрел был, а трупа нет», без имени)
  const S = CUR(), hp = G.players.find((p) => p.human);
  if (hp && S.shield.armed === `night:${G.day}` && killed.has(hp.name)) {
    killed.delete(hp.name); G.shieldSaved = true; gamelog.shieldSaved(S.gameId);
    secretAct(`🛡 щит спас ${hp.name} этой ночью`);
  }
  G.lastDead = [...killed].map(byName);
  G.lastDead.forEach((p) => { p.alive = false; p.revealed = p.role; });
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
  lynched.alive = false; lynched.revealed = lynched.role;
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
  G.players.forEach((p) => (G.priv[p.name] = { checks: [], kills: [], saves: [], notes: [], visits: [], watches: [], blocked: [] }));
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
  if (humanP && CUR().userId) CUR().gameId = gamelog.startGame(CUR().userId, humanP.name, humanP.role, CUR().premium, G.players.length);   // журнал: партия началась

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
