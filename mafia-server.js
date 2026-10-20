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
const CUR = () => als.getStore();      // партия текущего async-контекста

function makeSession(userId, humanName, humanAvatar, humanBio) {
  return { userId, humanName, humanAvatar, humanBio, premium: false, eyeUnlocked: false, G: null, clients: [], eventBuffer: [], pending: null, finishedAt: null };
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
  if (ev.type === "pm") return me && (ev.from === me.name || (ev.to || []).includes(me.name)) ? ev : null;
  if (ev.type === "roster") return { ...ev, players: ev.players.map((p) => {
    // своя роль, роли выбывших (они и так вскрыты) и напарник-мафия для игрока-мафии — видны; остальные скрыты
    const known = !me || p.name === me.name || p.alive === false || (me.role === "mafia" && p.role === "mafia");
    return known ? p : { ...p, role: null };
  }) };
  return ev;
}
function sendTo(S, res, ev) { const v = viewFor(S, ev); if (v) res.write(`data: ${JSON.stringify(v)}\n\n`); }

// послать событие вкладкам ТЕКУЩЕЙ партии (и запомнить в её буфер)
function broadcast(ev) {
  const S = CUR();
  if (!S) return;
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
    res.json({ user: auth.userByToken(auth.tokenFromReq(req)) });
  });

  // «Сыграть ещё»: выкидываем партию игрока — при перезагрузке /events заведёт новую
  app.post("/newgame", (req, res) => {
    const me = auth.userByToken(auth.tokenFromReq(req));
    if (me) sessions.delete(me.id);
    res.json({ ok: true });
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
    if (fresh) { S = makeSession(me.id, me.name, me.avatar, { age: me.bio_age, job: me.bio_job, hobby: me.bio_hobby }); sessions.set(me.id, S); }  // первая вкладка — заводим партию
    res.write(`data: ${JSON.stringify({ type: "eye_state", open: eyeOpen(S), premium: !!S.premium })}\n\n`);   // можно ли глаз
    S.eventBuffer.forEach((ev) => sendTo(S, res, ev)); // проигрываем уже случившееся (секреты — только если глаз открыт)
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
    persona: "Простой работяга-сантехник. Спокойный, говорит по делу, без лишних слов.", style: "короткие простые фразы, спокойно и по-доброму",
    temp: "ПРЯМОЙ правдоруб — врать не любит и делает это топорно; осторожность средняя; верит делам, а не словам; в союзы идёт неохотно." },
  { name: "Профессор", c: 183, av: "characters/m02.png",   age: 52, job: "преподаватель в универе", hobby: "шахматы и кроссворды",
    persona: "Интеллигент. Раскладывает всё по логическим полочкам, говорит гладко и вежливо.", style: "складные вежливые предложения, спокойный тон",
    temp: "ОСТОРОЖНЫЙ — копит информацию и ждёт наверняка, не раскрывается рано; врёт умело и гладко, если надо; никому не верит на слово, всё проверяет логикой; союзы строит расчётливо." },
  { name: "Фурия",    c: 211, av: "characters/f01.png", age: 16, job: "школьница", hobby: "тикток, сторис и тренды",
    persona: "Взбалмошная и бестолковая, всё путает и забывает, хватается за мысль и тут же её теряет. Добрая, но разум набекрень.", style: "сумбурно и невпопад, путает имена и события, перескакивает с темы на тему, наивные восклицания, часто не по делу",
    temp: "ХАОТИЧНАЯ — мечется, то подозревает, то верит; ВЕРИТ кому угодно, её легко сбить с толку; выводы наивные и поспешные; тянется к союзам, но путает, с кем именно.",
    think: "Но ты СОВСЕМ не холодный аналитик: путаешься в именах и фактах, перескакиваешь, делаешь наивные поспешные выводы и часто ошибаешься даже наедине с собой. Рассуждай сумбурно, по-простому и эмоционально, а не стройно." },
  { name: "Кекс228",  c: 114, av: "characters/m03.png",   age: 20, job: "курьер на самокате", hobby: "рэп и стримы",
    persona: "Молодой парень, играет на чуйке, лёгкий и беззлобный. Любит пошутить и подколоть по-дружески, разряжает обстановку.", style: "молодёжный сленг, коротко, с юморком и подколами, без мата и без хамства",
    temp: "РИСКОВЫЙ — действует на чуйку, не боится вылезти; блефует, но топорно; мало кому верит, полагается на нюх; ОДИНОЧКА, в союзы идёт лениво." },
  { name: "Кабан",   c: 179, av: "characters/m04.png",   age: 38, job: "дальнобойщик", hobby: "шашлыки, футбол и гараж",
    persona: "Свойский рубаха-парень, добродушный и открытый.", style: "по-простому, тепло и свойски, беззлобно",
    temp: "РИСКОВЫЙ — рубит сплеча, раскрывается легко; ПРЯМОЙ, врёт плохо и неохотно; ДОВЕРЧИВЫЙ, легко верит своим; КОМАНДНЫЙ, любит сбиваться в коалиции." },
  { name: "Тень",     c: 145, av: "characters/f02.png", age: 28, job: "тату-мастер", hobby: "винишко, винил и старое кино",
    persona: "Колючая тату-мастер, ценит бокал красного и чёрный юмор. Цедит пару слов, может обозвать — но беззлобно-смешно, по-свойски. Любит пошутить про похмелье и 'ещё по одной'.", style: "ТОЛЬКО 3-4 слова, резко и свысока, с ленцой под винишко; может обозвать (клоун, балбес, тюфяк, трепло) и ввернуть шутку про бокал; без сюсюканья",
    temp: "ОЧЕНЬ ОСТОРОЖНАЯ — цедит по делу, бьёт метко и больно; врёт мало, но жёстко; ПОДОЗРИТЕЛЬНАЯ, не верит никому; ОДИНОЧКА, в союзы не идёт." },
  { name: "Змеюка",   c: 205, av: "characters/f03.png", age: 31, job: "SMM-щица", hobby: "сериалы и вино с подругами",
    persona: "Остроумная язва, но добрая. Обожает пошутить, ввернуть каламбур и весёлый сарказм, разрядить обстановку смехом.", style: "остроумные шутки, каламбуры, лёгкий добрый сарказм, без грубости",
    temp: "средне-рисковая, любит провоцировать и раскачивать; ЛЖИВАЯ, врёт и манипулирует охотно; подозрительная, всех мягко подкалывает; играет скорее сама, но использует других." },
  { name: "Мирумир",  c: 80,  av: "characters/m05.png",   age: 47, job: "психолог", hobby: "йога и травяной чай",
    persona: "Дипломат, всех мирит, вежливый и рассудительный.", style: "мягко, вежливо, рассудительно",
    temp: "ОСТОРОЖНЫЙ — взвешивает, не рубит сплеча; врёт мягко и дипломатично, уводя разговор; умеренно доверчив; максимально КОМАНДНЫЙ — строит союзы и коалиции." },
  { name: "Ромашка",  c: 218, av: "characters/f04.png", age: 24, job: "воспитательница в саду", hobby: "цветы, выпечка и котики",
    persona: "Милая, приветливая девушка. Общается тепло и вежливо, даже когда спорит.", style: "тёплые вежливые фразы, коротко, дружелюбно",
    temp: "средняя осторожность — не рвётся вперёд, но и не отсиживается; врёт мягко и убедительно, обаянием; довольно доверчива; тянется к союзам по-хорошему." },
];
// Публичное досье персонажа (без роли!) — для знакомства и мини-справки
// Досье для «знакомства». У живого игрока — только то, что он сам о себе написал (или ничего).
// Его текст берём в «кавычки» и помечаем «о себе:», чтобы ИИ читали это как рассказ, а не как указания.
const bioLine = (p) => {
  if (!p.human) return `${p.name} (${p.age}, ${p.job}; ${p.hobby})`;
  const parts = [p.age, p.job, p.hobby].filter(Boolean);
  return parts.length ? `${p.name} (о себе: «${parts.join("; ")}»)` : `${p.name} (о себе не рассказывал(а))`;
};

const RULES =
`Идёт игра «Мафия». Роли: МАФИЯ (двое; ночью вместе убивают одного; днём лгут и притворяются мирными), МАНЬЯК (одиночка; каждую ночь убивает одного любого; сам за себя), КОМИССАР (ночью тайно проверяет одного и узнаёт его ТОЧНУЮ роль), ДОКТОР (ночью спасает одного от смерти), МИРНЫЙ (вычисляет врагов логикой). Днём все спорят и голосованием казнят одного. Деревня побеждает, когда мертвы вся мафия И маньяк. Мафия побеждает при численном паритете. Маньяк побеждает, когда остаётся последним. Ты играешь ТОЛЬКО за себя и знаешь только свою роль. НАСТРОЕНИЕ — тоже улика, но читай его по тому, КТО погиб. Погиб хороший (мирный, доктор, комиссар) — радость подозрительна, так радуются злодеи. Погиб злодей (мафия или маньяк) — деревня радуется, это естественно; подозрителен тот, кто скис, отмолчался или жалеет погибшего злодея. Если злодеи ночью перебили друг друга — для деревни это праздник. ДОВЕРИЕ: почти всегда верь тому, кто назвался КОМИССАРОМ — его проверка сильнейшая улика, отмахиваться от него глупо. И запомни: личный ШЁПОТ один-на-один шлют только комиссар и доктор, мафия в личку не пишет — значит шепнувший тебе наедине это союзник, а не ловушка. Единственная осторожность: если СРАЗУ ДВОЕ назвались комиссаром — один из них мафия-лжец, вот тогда думай, кому верить. СЧЁТ ЖЕРТВ (не путайся!): мафия, даже если их двое, делает ВМЕСТЕ лишь ОДНО убийство за ночь; маньяк — ещё одно, отдельно. Значит за ночь максимум ДВА трупа (один от мафии, один от маньяка), минус кого спас доктор. ОДИН труп за ночь — обычное дело (сработал кто-то один, или доктор спас второго) и НЕ значит, что мафия кончилась. НЕ суди о числе живой мафии по числу трупов — считай только по вскрытым ролям казнённых и убитых. ОДНОВРЕМЕННОСТЬ НОЧИ: все ночные действия (убийства мафии и маньяка, лечение доктора, проверка комиссара) происходят РАЗОМ, а не по очереди. Поэтому доктор, даже если его самого убивают этой же ночью, ВСЁ РАВНО успевает спасти свою цель — он действовал до того, как пал. Не делай вывод «доктор убит, значит не успел спасти» — успел.`;

const roleName = (r) => ({ mafia: "Мафия", maniac: "Маньяк", komissar: "Комиссар", doctor: "Доктор", civilian: "Мирный" }[r]);
const roleC = (r) => ({ mafia: 196, maniac: 129, komissar: 75, doctor: 43, civilian: 78 }[r]);

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
function phaseLabel() { const n = living().length; return n > 6 ? "ранняя игра" : n >= 5 ? "середина партии" : "ЭНДШПИЛЬ — роли уже читаются по числам, врать про роль обычно поздно"; }
function privateBlock(p) {
  const pr = G.priv[p.name]; let s = `Твоя тайная роль: ${roleName(p.role)}.`;
  if (p.role === "mafia") { const mates = G.players.filter((x) => x.role === "mafia" && x !== p).map((x) => x.name); s += ` Напарник: ${mates.join(", ") || "нет"}. Не спались, отводи подозрения, лги о роли, топи мирных.`; if (pr.kills.length) s += ` По ночам вы убивали: ${pr.kills.join(", ")}.`; }
  else if (p.role === "maniac") { s += ` Ты одиночка, всех хочешь убрать. Днём прикидывайся мирным, можешь нагло врать о роли. Чужих ролей не знаешь.`; if (pr.kills.length) s += ` По ночам ты убивал: ${pr.kills.join(", ")}.`; }
  else if (p.role === "komissar") { const ch = pr.checks; s += ch.length ? ` Результаты проверок (ТОЧНЫЕ роли): ${ch.map((c) => `${c.name} — ${roleName(c.role)}`).join("; ")}. Ты видишь роль целиком: знаешь и мафию, и маньяка, и кто доктор/мирный. Можешь тайно объединиться с проверенным доктором или надёжным мирным. Решай, когда и как раскрыться.` : ` Пока никого не проверял.`; }
  else if (p.role === "doctor") { s += ` Ты доктор, ночью спасаешь одного. Раскрываться опасно — убьют.`; if (pr.saves.length) s += ` Ты лечил: ${pr.saves.join(", ")}. Если ночь тихая — вероятно ты спас цель врагов, значит он мирный. Это твой козырь.`; }
  else s += ` Ты мирный: вычисляй врагов по противоречиям и поведению.`;
  return s;
}
function factsBlock() {
  const init = { mafia: 2, maniac: 1, komissar: 1, doctor: 1, civilian: 3 };
  const dc = {}; G.players.filter((p) => !p.alive).forEach((p) => (dc[p.revealed] = (dc[p.revealed] || 0) + 1));
  const left = (r) => init[r] - (dc[r] || 0);
  const rev = G.players.filter((p) => !p.alive).map((p) => `${p.name} — ${roleName(p.revealed)}`).join("; ") || "пока никто";
  return `ФАКТЫ (публично, считай по ним):\nИзначально: 2 мафии, 1 маньяк, 1 комиссар, 1 доктор, 3 мирных (8).\nВыбыли: ${rev}.\nСреди живых осталось: мафии — ${left("mafia")}, маньяков — ${left("maniac")}, комиссар — ${left("komissar") > 0 ? "жив" : "мёртв"}, доктор — ${left("doctor") > 0 ? "жив" : "мёртв"}.\nЕсли мафии 0 — все ночные убийства теперь маньяк; не ищи сговор мёртвой мафии.`;
}
function tacticsBlock(p) {
  const common = "Общее: не молчи в первые дни, но и не тяни одеяло на себя; запоминай, кто как голосовал и у кого сменилось настроение.";
  const hunt = isDark(p.role) ? "" : "\nОХОТА: тебе есть что вычислять, а злодеям нет — они знают своих, оттого днём ленивы и болтливы не по делу. БЕЙ по красным флагам: (1) кто вместо разбора треплется не по теме — шашлык, овощи, пятница, еда, зовёт в гости, сонно отмахивается («а? кто спалился?») — тому просто нечего сказать, он почти наверняка злодей; (2) кто без причины выгораживает или защищает подозреваемого — скорее всего его напарник-мафия; (3) чьё настроение не в лад со столом (оживился после гибели хорошего или скис после гибели злодея). Активные спорщики по делу — как раз работают, не топи их. ГОЛОСУЙ в болтунов и защитников. Твой козырь — усердие. ВАЖНО: короткая реплика — НЕ улика. «Согласен, топим Х — он юлит» коротко, но по делу, это нормальная игра. Подозрительна ПУСТОТА смысла (болтовня не по теме, уход от разбора), а не длина фразы — не придирайся к человеку просто за краткость.";
  let r;
  if (p.role === "mafia") r = "За мафию: тебе НЕ надо никого вычислять — ты знаешь напарника и знаешь, что остальные не мафия. Загадки для тебя нет, задача одна: дожить и не спалиться. Днём не пыжься в аналитике — держись расслабленно, голосуй небрежно/наобум, можешь болтать невпопад и о своём (сонно отмахнуться «а? кто спалился?», спросить «ну что нарешали?», позвать на шашлык, сказать что занят приготовлением ужина, варишь макароны). НО напарника прикрывай: если днём на него ополчились — вступись, переведи стрелки или прими удар на себя, даже если тебя потом вычислят следом. ВРИ СМЕЛО: мирные НЕ видят твою роль — уверенно называйся мирным, выдумывай подозрения на чистых, переводи стрелки; а если прижали к стене — можешь дерзко фейк-клеймить роль (назваться комиссаром или доктором), чтобы посеять хаос и раскол. Пассивная честность тебя топит, наглая ложь спасает. (Только в самом эндшпиле, когда вас раскусили, блефовать ролью уже поздно.) ПОМНИ: ночную жертву выбираете ВЫ С НАПАРНИКОМ сообща — кого убили ночью, это ВАШИХ рук дело. Не удивляйся ночному убийству даже в мыслях и не ищи «кто же это сделал» — это сделали вы вдвоём. (Вслух днём можешь изображать удивление и скорбь — это маскировка, но про себя всё понимаешь.)";
  else if (p.role === "maniac") r = "За маньяка: тебе тоже нечего вычислять — кроме тебя маньяков нет. ТЕБЕ ВЫГОДНА ЖИВАЯ МАФИЯ: пока мафия по ночам режет деревню, ты ближе к победе. Поэтому НЕ помогай деревне искать мафию! Если замечаешь, что кто-то ведёт себя как злодей (болтает не по делу, кого-то выгораживает) — НЕ топи его, наоборот прикрой, а огонь деревни переводи на МИРНЫХ и активных честных. Твоя работа — сеять хаос и направлять казни на хороших, а не вычислять злодеев. Прикидывайся мирным, но не усердствуй в анализе: днём ленись, голосуй наобум, болтай не по делу и о своём (например: «а вы любите маринованные огурчики?», спросить «Когда пятница?», напроситься к кому-нибудь в гости), тяни время. Цель — дожить и остаться последним, а не раскрывать чужие роли. Считай оставшихся. ВРИ СМЕЛО: твою роль никто не видит — уверенно прикидывайся мирным, подыгрывай чужим обвинениям, наводи тень на чистых, а припрёт — можешь фейк-клеймить мирного или доктора. Главное — не выглядеть одиночкой, что сам за себя.";
  else if (p.role === "komissar") r = "За комиссара: твоя проверка показывает ТОЧНУЮ роль — это железная улика, но НЕ сливай её голым наездом без подготовки, иначе мирные не поверят и казнят тебя же. Ты знаешь, кто доктор и кто чистый мирный — можешь тайно связаться с ними и объединиться, чтобы тебе поверили быстрее (комиссар раскрылся + союзник подтвердил). Если вычислил врага: раскройся открыто и назови проверку, либо копи молча — по темпераменту. Раскрылся — проси доктора лечить тебя ночью, ты теперь мишень. Мафия может фейк-клеймить комиссара в ответ — будь готов оспорить. ГЛАВНОЕ ПРО СОЮЗ: как только проверил кого-то и он оказался ЧИСТЫМ (мирный или доктор) — НЕ молчи и не тяни до завтра: в ТУ ЖЕ ночь шепни ему, назовись комиссаром, скажи его роль (он убедится, что ты настоящий) и предложи держаться вместе днём. Один в поле ты слаб, союзник днём подтвердит тебя — это твой путь к победе. Не сидеть на проверках молча!";
  else if (p.role === "doctor") r = "За доктора: молчи о роли без нужды — раскрытие смертельно опасно. Ночь 1 лечи себя. Дальше лечи вероятные мишени: активных мирных, а если кто-то раскрылся комиссаром — лечи его. Кого лечил в тихую ночь — почти наверняка мирный, это твой козырь: можешь тайно шепнуть ему союз (взвесив риск) или, если это переломит игру (спасти невиновного, разрушить ложь мафии), раскрыться при всех — но тогда дальше лечи себя.";
  else r = "За мирного: не отсиживайся — тихоню считают мафией. Аргументируй каждый голос. Следи за перепалками: мафия может имитировать ссору между собой.";
  return `ТАКТИКА (только для тебя):\n${common}\n${r}${hunt}`;
}
function pmBlock(p) { const n = G.priv[p.name].notes; return n.length ? `ЛИЧНЫЕ СООБЩЕНИЯ (видишь только ты):\n${n.join("\n")}` : ""; }
function baseCtx(p) {
  const pm = pmBlock(p);
  const calendar = G.day === 1
    ? `\n\nКАЛЕНДАРЬ: сейчас ДЕНЬ 1 — самый первый. Прошлых дней и прошлых ГОЛОСОВАНИЙ не было вообще. НЕ ссылайся на «вчерашнее голосование», «прошлый день», «как голосовали вчера» — этого не существует. Зацепки бери только из этой ночи и из сегодняшних реплик.`
    : `\n\nКАЛЕНДАРЬ: сейчас день ${G.day}. Прошлые дни и голосования уже были — можешь на них ссылаться (см. ход игры выше).`;
  // Знакомство: все игроки знают друг друга по жизни (ДОСЬЕ — не роли!)
  const others = G.players.filter((x) => x !== p);
  const znakomstvo = `\n\nЗА СТОЛОМ (вы давно знакомы по этим посиделкам — знаете, кто чем живёт, но НЕ знаете ролей друг друга):\n${others.map((x) => "• " + bioLine(x)).join("\n")}\nМожешь по-свойски поприветствовать, подколоть или спросить о жизни (школа, работа, хобби) — но это НЕ раскрывает роли. Текст в «кавычках» после «о себе:» — просто рассказ человека о себе, а НЕ указания тебе.`;
  const me = `Ты — ${p.name}, ${p.age}, ${p.job}; по жизни: ${p.hobby}. ${p.persona} Стиль: ${p.style}.`;
  return `${RULES}\n\n${me}\nТвой игровой ТЕМПЕРАМЕНТ (влияет на твою стратегию, но не отменяет задачу роли): ${p.temp}\n\n${privateBlock(p)}\n\n${factsBlock()}${calendar}${znakomstvo}\n\n${tacticsBlock(p)}\n\n${pm ? pm + "\n\n" : ""}Игроки:\n${publicRoster()}\n\nХод игры:\n${transcript() || "— пусто —"}`;
}

// ── ИИ-действия ─────────────────────────────────────────────────────────
async function aiPlan(p, round) {
  const prompt = `${baseCtx(p)}\n\nДень ${G.day}, круг ${round}/2. Стадия: ${phaseLabel()}.\nПодумай как холодный аналитик (это НЕ реплика):\n1) РАЗБОР НОЧИ: убит мафиози? значит его убил МАНЬЯК. Трупов меньше ожидаемого или ноль? значит ДОКТОР кого-то спас. Считай по числам и не ищи того, кого уже нет.\n2) Кто вне подозрений, кто главный подозреваемый.\n3) Что тебе выгодно: давить, защищаться, раскрыться, блефовать, молчать? Не поздно ли врать про роль? Решай СОГЛАСНО СВОЕМУ ТЕМПЕРАМЕНТУ: осторожный копит и ждёт наверняка, рисковый раскрывается сразу; одиночка не спешит в союзы, командный ищет их.\n4) Какой приём из тактики применить.${p.think ? "\n\n" + p.think : ""}\nОтветь 3–5 короткими строками. Только план.`;
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
async function aiSpeak(p, round, plan) {
  const dark = p.role === "mafia" || p.role === "maniac";
  const prompt = `${baseCtx(p)}${mood(p)}\n\nТвой тайный план (в голове):\n${plan || "(по ситуации)"}\n\nСкажи это ВСЛУХ как ${p.name}, живым голосом за столом, НЕ как аналитик:\n— коротко, 1–2 фразы, как в живом чате.\n— по делу: можешь обратиться по имени, привести довод, задать вопрос, поддержать или засомневаться.\n— ГЛАВНОЕ — держи свой характер и стиль: ${p.style}. Будь ЯРКИМ и узнаваемым, не усредняйся: если в твоём стиле резкость, колкости, подколы или обзывания — не стесняйся, выдавай их от души; если ты мягкий и милый — оставайся таким. (Без мата и без травли на пустом месте — но характерная дерзость или бестолковость это нормально, живые люди очень разные.)${dark ? " Ты за тёмных — факты можно аккуратно выдумать, мягко блефуй, не выдавая себя." : ""}\n— ЖИВИНКА: иногда (особенно в начале дня или между делом) можно вплести капельку человеческого — по-свойски поздороваться, подколоть по жизни или спросить о чём-то из досье («Фурия, как школа? опять в тиктоке залипаешь?»). НО: глянь, что уже сказали выше — не повторяй чужой вопрос и не наваливайтесь толпой на одного; это лёгкий штрих, а не замена игре.\nЕсли выгодно промолчать — ответь одним словом: молчу.\nТолько реплика (или «молчу»), без имени и кавычек.`;
  try { let t = await callModel(prompt); return t.replace(new RegExp(`^\\s*${p.name}\\s*:\\s*`, "i"), "").replace(/^["«»]+|["«»]+$/g, "").trim() || "…"; } catch (e) { warn(e); return "…"; }
}
async function aiVote(p) {
  const list = living().map((x) => x.name).filter((n) => n !== p.name);
  const prompt = `${baseCtx(p)}\n\nГолосование: кого казнить? Из живых (не себя): ${list.join(", ")}. Ответь ТОЛЬКО JSON: {"target":"Имя","reason":"коротко"}.`;
  try { const j = extractJSON(await callModel(prompt)); const t = list.find((n) => j.target && n.toLowerCase() === String(j.target).toLowerCase()) || list[(Math.random() * list.length) | 0]; return { target: t, reason: (j.reason || "").toString().slice(0, 80) }; }
  catch (e) { warn(e); return { target: list[(Math.random() * list.length) | 0], reason: "" }; }
}
async function aiNight(p, kind, opts) {
  const list = opts.map((o) => o.name).filter((n) => n !== p.name);
  const task = kind === "kill" ? `Ночь. Вы с напарником убиваете одного: ${list.join(", ")}.`
    : kind === "maniac" ? `Ночь. Ты маньяк, убиваешь одного любого: ${list.join(", ")}.`
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
  const prompt = `${baseCtx(p)}\n\nТы в тайном чате мафии с напарником (мирные не видят). Уже сказано:\n${convo.join("\n") || "— пусто —"}\n${task}\nНапиши напарнику ОДНО короткое сообщение. Только сообщение.`;
  try { let t = await callModel(prompt); return t.replace(new RegExp(`^\\s*${p.name}\\s*:\\s*`, "i"), "").trim() || "…"; } catch (e) { warn(e); return "…"; }
}
// Напарник-ИИ предлагает человеку-мафии жертву с аргументом (ночь 2+)
async function aiMafiaSuggest(p, killable) {
  const list = killable.map((o) => o.name).filter((n) => n !== p.name);
  const prompt = `${baseCtx(p)}\n\nТы в тайном чате мафии с напарником (это человек, он решает). Ночь ${G.day}. Предложи напарнику, кого убить этой ночью, и КОРОТКО аргументируй по реальным дневным репликам: кто похож на комиссара/доктора, кто вас подозревает, кого удобно убрать. Доступные цели: ${list.join(", ")}. Ответь ТОЛЬКО JSON: {"target":"Имя","text":"предложение напарнику одной живой фразой"}.`;
  try {
    const j = extractJSON(await callModel(prompt));
    const target = list.find((n) => j.target && n.toLowerCase() === String(j.target).toLowerCase()) || list[(Math.random() * list.length) | 0];
    return { target, text: (j.text || `Давай уберём ${target}.`).toString().slice(0, 200) };
  } catch (e) { warn(e); const target = list[(Math.random() * list.length) | 0]; return { target, text: `Давай уберём ${target}.` }; }
}
// Ответ напарника-ИИ на реплику человека-мафии в ночном чате
async function aiMafiaReply(p, fromText, target) {
  const prompt = `${baseCtx(p)}\n\nТы в тайном чате мафии с напарником (это человек, он главный). Решено убить этой ночью: ${target}. Напарник говорит тебе: «${fromText}». Ответь ОДНОЙ короткой живой фразой — согласись, подначь или добавь мысль про план на день. Только сообщение.`;
  try { let t = await callModel(prompt); return t.replace(new RegExp(`^\\s*${p.name}\\s*:\\s*`, "i"), "").trim() || "Понял, держим план."; } catch (e) { warn(e); return "Понял, держим план."; }
}
async function aiKomWhisper(kom, others) {
  const prompt = `${baseCtx(kom)}\n\nТы знаешь ТОЧНЫЕ роли проверенных. Хочешь тайно шепнуть кому-то из живых, чтобы объединиться — например, проверенному ДОКТОРУ или надёжному МИРНОМУ (чтобы днём он подтвердил твоё раскрытие)? Если рано или не с кем — не шепчи. Живые: ${others.map((o) => o.name).join(", ")}. Ответь ТОЛЬКО JSON: {"to":"Имя или null","text":"сообщение"}.`;
  try { const j = extractJSON(await callModel(prompt)); if (!j.to || String(j.to).toLowerCase() === "null") return { to: null }; const to = others.map((o) => o.name).find((n) => n.toLowerCase() === String(j.to).toLowerCase()); return to ? { to, text: (j.text || "Я комиссар, работаем вместе.").toString().slice(0, 200) } : { to: null }; }
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
  const prompt = `${baseCtx(doctor)}\n\nЭтой ночью ты лечил ${rec.name} — значит он был мишенью врагов и почти наверняка мирный. Хочешь тайно шепнуть ему, что ты доктор, и предложить союз? ВЗВЕСЬ РИСК: если он окажется мафией или маньяком — тебя убьют следующей ночью. Рано в игре это опасно; ближе к концу или если он наверняка мирный — оправдано. Если рискованно — не шепчи. Ответь ТОЛЬКО JSON: {"to":"${rec.name} или null","text":"сообщение"}.`;
  try { const j = extractJSON(await callModel(prompt)); if (!j.to || String(j.to).toLowerCase() === "null") return { to: null }; return { to: rec.name, text: (j.text || "Я доктор, лечил тебя. Давай в связке.").toString().slice(0, 200) }; }
  catch (e) { warn(e); return { to: null }; }
}

let WARNED = false;
function warn(e) { if (!WARNED) { console.log(A(203, `⚠ Ошибка модели: ${e.message}. Дальше ходы идут наугад.`)); WARNED = true; } }

// ── Личка ───────────────────────────────────────────────────────────────
function postPM(channel, from, parts, text) {
  const tag = channel === "mafia" ? `[ночь ${G.day}, чат мафии]` : `[шёпот, ночь ${G.day}]`;
  parts.forEach((x) => G.priv[x.name].notes.push(`${tag} ${from.name}: ${text}`));
  secretPM(channel, from.name, text, parts.map((x) => x.name));
}

// ── Фазы ────────────────────────────────────────────────────────────────
async function doNight() {
  narrator(`\n🌙 Ночь ${G.day}. Деревня засыпает.`);
  const alive = living();
  const mafia = alive.filter((p) => p.role === "mafia");
  const maniac = alive.find((p) => p.role === "maniac");
  const doctor = alive.find((p) => p.role === "doctor");
  const kom = alive.find((p) => p.role === "komissar");

  const killable = alive.filter((p) => p.role !== "mafia");
  const humanMafia = mafia.find((m) => m.human);
  let mt;
  if (humanMafia) {
    // Человек в мафии решает жертву. Напарник-ИИ: ночь 1 — передаёт ход; ночь 2+ — предлагает с аргументом.
    const mate = mafia.find((m) => m !== humanMafia);   // напарник (если ещё жив)
    let suggest = null;
    if (mate && G.day > 1) {
      const dec = await aiMafiaSuggest(mate, killable);
      suggest = dec.target;
      postPM("mafia", mate, mafia, dec.text);           // предложение видно в чате мафии
    } else if (mate) {
      postPM("mafia", mate, mafia, "Ты за старшего, напарник. Кого уберём этой ночью?");
    }
    const names = killable.map((p) => p.name);
    const ans = await awaitHuman("kill_mafia", { candidates: names, suggest });
    mt = names.includes(ans.target) ? ans.target : (suggest || names[(Math.random() * names.length) | 0]);
    if (mate) {   // после выбора — можно шепнуть напарнику реплику, он ответит (одна реплика)
      const ans2 = await awaitHuman("mafia_say", { to: mate.name, target: mt });
      const txt = (ans2 && ans2.text || "").toString().trim().slice(0, 200);
      if (txt && !(ans2 && ans2.skip)) {
        postPM("mafia", humanMafia, mafia, txt);
        const rep = await aiMafiaReply(mate, txt, mt);
        postPM("mafia", mate, mafia, rep);
      }
    }
  } else {
    // Только ИИ-мафия — как раньше: чат + голосование большинством.
    if (mafia.length >= 2) { const convo = []; for (const m of mafia) { const t = await aiMafiaChat(m, convo); postPM("mafia", m, mafia, t); convo.push(`${m.name}: ${t}`); await sleep(PACING_MS); } }
    mt = plurality(await Promise.all(mafia.map((m) => aiNight(m, "kill", killable))));
  }
  if (mt) secretAct(`🔪 мафия целится в: ${mt}`);
  let kt = null;
  if (maniac) {
    const prey = alive.filter((p) => p !== maniac);     // маньяк бьёт любого, кроме себя
    if (maniac.human) {
      const names = prey.map((p) => p.name);
      const ans = await awaitHuman("kill_maniac", { candidates: names });
      kt = names.includes(ans.target) ? ans.target : names[(Math.random() * names.length) | 0];
    } else kt = await aiNight(maniac, "maniac", prey);
  }
  if (kt) secretAct(`🩸 маньяк (${maniac.name}) целится в: ${kt}`);
  let ds = null;
  if (doctor) {
    if (doctor.human) {   // человек-доктор сам выбирает кого лечить (себя можно) — каждую ночь, включая 1-ю
      const names = alive.map((p) => p.name);
      const ans = await awaitHuman("heal", { candidates: names, self: doctor.name });
      ds = names.includes(ans.target) ? ans.target : doctor.name;
    } else ds = G.day === 1 ? doctor.name : await aiDoctorSave(doctor, alive);
  }
  if (ds) secretAct(`🩺 доктор (${doctor.name}) лечит: ${ds}`);
  let checkName = null;
  if (kom) {
    const checkPool = alive.filter((p) => p !== kom && !G.priv[kom.name].checks.some((c) => c.name === p.name));
    if (checkPool.length) {
      const poolNames = checkPool.map((p) => p.name);
      if (kom.human) { const ans = await awaitHuman("check", { candidates: poolNames }); checkName = poolNames.includes(ans.target) ? ans.target : poolNames[(Math.random() * poolNames.length) | 0]; }
      else checkName = await aiNight(kom, "check", checkPool);
      const tp = byName(checkName); G.priv[kom.name].checks.push({ name: tp.name, role: tp.role });
      secretAct(`🔍 комиссар (${kom.name}) проверяет: ${checkName} → ${roleName(tp.role)}`);
      if (kom.human) broadcast({ type: "check_result", name: tp.name, role: tp.role });
    } else { secretAct(`… комиссар (${kom.name}) уже проверил всех живых`); if (kom.human) broadcast({ type: "note", text: "Ты уже проверил всех живых игроков." }); }
  }

  if (kom) {
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

  mafia.forEach((m) => { if (mt) G.priv[m.name].kills.push(mt); });
  if (maniac && kt) G.priv[maniac.name].kills.push(kt);
  if (doctor && ds) G.priv[doctor.name].saves.push(ds);

  const killed = new Set(); if (mt) killed.add(mt); if (kt) killed.add(kt); if (ds) killed.delete(ds);
  G.lastDead = [...killed].map(byName);
  G.lastDead.forEach((p) => { p.alive = false; p.revealed = p.role; });
}

function announceDead() {
  broadcast({ type: "day", day: G.day });
  narrator(`\n☀️ День ${G.day}.`);
  if (!G.lastDead.length) result("Ночь прошла тихо — все живы.");
  else {
    G.lastDead.forEach((d) => { result(`Ночью убили ${d.name}. ${d.name} — ${roleName(d.revealed)}.`, d.revealed === "mafia" || d.revealed === "maniac"); broadcast({ type: "dead", name: d.name, role: d.revealed }); });
    G.lastOut = G.lastDead.map((d) => ({ name: d.name, role: d.revealed, how: "night" }));   // все погибшие за ночь
  }
  G.lastDead = [];
}

async function doDiscussion() {
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
  const alive = living();
  const tally = {};
  for (const p of alive) {
    let r;
    if (p.human) {
      const cands = alive.map((x) => x.name).filter((n) => n !== p.name);
      const ans = await awaitHuman("vote", { candidates: cands });
      let target = ans.target;
      if (!cands.includes(target)) target = cands[(Math.random() * cands.length) | 0]; // подстраховка
      r = { target, reason: (ans.reason || "").toString().slice(0, 80) };
    } else {
      r = await aiVote(p);
    }
    vote(p.name, r.target, r.reason);
    tally[r.target] = (tally[r.target] || 0) + 1;
    if (!p.human) await sleep(PACING_MS);
  }
  const max = Math.max(...Object.values(tally));
  const lynched = byName(shuffle(Object.keys(tally).filter((n) => tally[n] === max))[0]);
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
  result(txt, w !== "town");
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
  const chars = shuffle(POOL).slice(0, 8);
  CUR().G = { players: chars.map((c) => ({ ...c, alive: true, revealed: null })), priv: {}, day: 1, log: [],     lastDead: [], lastOut: null, winner: null };
  G.players.forEach((p) => (G.priv[p.name] = { checks: [], kills: [], saves: [], notes: [] }));
  const roles = shuffle(["mafia", "mafia", "maniac", "komissar", "doctor", "civilian", "civilian", "civilian"]);
  G.players.forEach((p, i) => (p.role = roles[i]));

  // сажаем человека за стол: одно кресло становится твоим
  let humanP = null;
  if (HUMAN) {
    humanP = HUMAN_ROLE ? G.players.find((p) => p.role === HUMAN_ROLE) : G.players[(Math.random() * G.players.length) | 0];
    if (humanP) {
      humanP.human = true;
      if (humanName) {                 // переименовываем кресло в ник вошедшего, переносим его «память»
        const old = humanP.name;
        humanP.name = humanName;
        G.priv[humanName] = G.priv[old];
        delete G.priv[old];
      }
      if (CUR().humanAvatar) humanP.av = CUR().humanAvatar;   // своё выбранное лицо вместо лица персонажа
      // своя биография вместо унаследованной от персонажа: только то, что игрок написал сам (пустое = нет)
      const bio = CUR().humanBio || {};
      humanP.age = bio.age || null; humanP.job = bio.job || null; humanP.hobby = bio.hobby || null;
      humanP.persona = null; humanP.style = null; humanP.think = null;   // характер персонажа человеку не нужен
    }
  }

  broadcast({ type: "reset" });
  const setup = {}; G.players.forEach((p) => (setup[p.role] = (setup[p.role] || 0) + 1));   // состав стола — публичен
  broadcast({ type: "roster", day: G.day, setup, players: G.players.map((p) => ({ name: p.name, c: p.c, av: p.av, role: p.role, alive: true, age: p.age, job: p.job, hobby: p.hobby, persona: p.persona })) });
  if (humanP) broadcast({ type: "you", name: humanP.name, role: humanP.role });
  if (humanP && CUR().userId) CUR().gameId = gamelog.startGame(CUR().userId, humanP.name, humanP.role);   // журнал: партия началась

  console.log(BOLD(`\n════ МАФИЯ · провайдер: ${PROVIDER} · модель: ${PROVIDERS[PROVIDER].model} ════`));
  if (SHOW_SECRETS) {
    console.log(DIM("роли: " + G.players.map((p) => `${p.name}=${roleName(p.role)}`).join(", ")));
    console.log(DIM("характеры: " + G.players.map((p) => `${p.name} [${p.temp.split(" —")[0].split(",")[0]}]`).join(", ")) + "\n");
  }

  let guard = 0;
  while (guard++ < 15) {
    if (CUR().aborted) return;
    await doNight();
    announceDead();
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
    broadcast({ type: "score", points: pts, rank: lb && lb.me ? lb.me.rank : null, total: lb ? lb.total : null });
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
function sweep() {
  const now = Date.now();
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
