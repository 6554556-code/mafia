// Ключ берём из конверта ~/.env (в домашней папке, НЕ в репозитории).
require("dotenv").config({ path: require("path").join(require("os").homedir(), ".env") });

// ─────────────────────────────────────────────────────────────────────────
//  МАФИЯ — серверная текстовая версия. 8 ИИ играют сами, лог в консоль.
//  Запуск:  PROVIDER=groq GROQ_API_KEY=xxx node mafia-server.js
//  Модель меняется одной строкой ниже (groq / deepseek / grok / mock).
// ─────────────────────────────────────────────────────────────────────────

// ── НАСТРОЙКИ (меняй тут) ───────────────────────────────────────────────
const PROVIDER = process.env.PROVIDER || "groq"; // groq | deepseek | grok | mock
const SHOW_SECRETS = true;   // печатать роли, тайные мысли и личку (режим наблюдателя)
const HUMAN = process.env.HUMAN === "1" || process.env.HUMAN === "true"; // за столом сидит человек
const HUMAN_ROLE = process.env.HUMAN_ROLE || null;   // какую роль дать человеку (komissar/doctor/mafia/…); пусто = случайная
const PACING_MS = Number(process.env.PACING_MS ?? 10000);         // пауза между ходами в мс (0 = максимально быстро)
const TEMPERATURE = 0.9;     // «живость» речи
const MAX_TOKENS = 400;

// Провайдеры: endpoint + модель + переменная окружения с ключом.
const PROVIDERS = {
  groq:     { url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b", keyEnv: "GROQ_API_KEY" },
  deepseek: { url: "https://api.deepseek.com/chat/completions",        model: "deepseek-v4-flash",       keyEnv: "DEEPSEEK_API_KEY" },
  grok:     { url: "https://api.x.ai/v1/chat/completions",             model: "grok-4-fast",             keyEnv: "XAI_API_KEY" },
  mock:     { url: null, model: "mock", keyEnv: null },
};

// Цены за 1М токенов (вход/выход) — для оценки стоимости партии. Приблизительно.
const PRICES = {
  "llama-3.3-70b-versatile": { in: 0.59, out: 0.79 },
  "deepseek-v4-flash":       { in: 0.14, out: 0.28 },
  "grok-4-fast":             { in: 0.20, out: 0.50 },
  "openai/gpt-oss-120b":     { in: 0.15, out: 0.60 },
  "mock":                    { in: 0, out: 0 },
};

// ── ANSI-цвета ──────────────────────────────────────────────────────────
const A = (code, s) => `\x1b[38;5;${code}m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

// ── ВЕБ-СЕРВЕР: живая труба сервер → браузер (SSE) ──────────────────────
const express = require("express");
const auth = require("./auth");
const PORT = process.env.PORT || 3000;
let clients = [];        // открытые вкладки-наблюдатели
let eventBuffer = [];    // вся партия целиком — чтобы обновлённая вкладка видела с начала
let gameStarted = false;

// послать событие всем открытым вкладкам (и запомнить в буфер)
function broadcast(ev) {
  eventBuffer.push(ev);
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  clients.forEach((res) => res.write(data));
}

// ── обратный канал: браузер → сервер ──────────────────────────────────
let pending = null;   // текущий ожидаемый ход человека: { kind, resolve }
// поставить игру на паузу и ждать ответа человека из браузера
function awaitHuman(kind, payload = {}) {
  return new Promise((resolve) => {
    pending = { kind, resolve };
    broadcast({ type: "your_turn", kind, ...payload });
  });
}

function startWeb(onFirstViewer) {
  const app = express();
  app.use(express.json());
  app.use(express.static(require("path").join(__dirname, "public")));

  app.post("/register", (req, res) => {
    const { email, password, name } = req.body || {};
    const r = auth.register(email, password, name);
    if (r.error) return res.status(400).json({ error: r.error });
    res.cookie("sid", r.token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: r.user });
  });
  app.post("/login", (req, res) => {
    const { email, password } = req.body || {};
    const r = auth.login(email, password);
    if (r.error) return res.status(400).json({ error: r.error });
    res.cookie("sid", r.token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: r.user });
  });
  app.post("/logout", (req, res) => {
    auth.logout(auth.tokenFromReq(req));
    res.clearCookie("sid", { path: "/" });
    res.json({ ok: true });
  });
  app.get("/me", (req, res) => {
    res.json({ user: auth.userByToken(auth.tokenFromReq(req)) });
  });

  // приёмник действий человека (реплика, голос, ночной ход)
  app.post("/action", (req, res) => {
    if (pending) { const p = pending; pending = null; broadcast({ type: "your_turn_done" }); p.resolve(req.body || {}); }
    res.json({ ok: true });
  });

  app.get("/events", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("\n");
    eventBuffer.forEach((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`)); // проигрываем уже случившееся
    clients.push(res);
    req.on("close", () => { clients = clients.filter((c) => c !== res); });
    if (!gameStarted) { gameStarted = true; onFirstViewer(); } // первый зритель запускает партию
  });

  app.listen(PORT, () => {
    console.log(BOLD(`\n🌐 Веб-сервер поднят на порту ${PORT}. Открой в браузере адрес сервера с :${PORT}`));
    console.log(DIM("   Партия начнётся, как только откроется вкладка.\n"));
  });
}

// ── Персонажи ───────────────────────────────────────────────────────────
const POOL = [
  { name: "Трубач",   c: 111, av: "male/m01.png",   persona: "Простой работяга-сантехник. Спокойный, говорит по делу, без лишних слов.", style: "короткие простые фразы, спокойно и по-доброму",
    temp: "ПРЯМОЙ правдоруб — врать не любит и делает это топорно; осторожность средняя; верит делам, а не словам; в союзы идёт неохотно." },
  { name: "ПрофеССор", c: 183, av: "male/m02.png",   persona: "Интеллигент. Раскладывает всё по логическим полочкам, говорит гладко и вежливо.", style: "складные вежливые предложения, спокойный тон",
    temp: "ОСТОРОЖНЫЙ — копит информацию и ждёт наверняка, не раскрывается рано; врёт умело и гладко, если надо; никому не верит на слово, всё проверяет логикой; союзы строит расчётливо." },
  { name: "Фурия",    c: 211, av: "female/f01.png", persona: "Эмоциональная, всё принимает близко к сердцу. Быстро подозревает и быстро верит, но не грубит.", style: "эмоционально, с восклицаниями, но по-доброму",
    temp: "РИСКОВАЯ — лезет напролом, раскрывается сразу; врать почти не умеет, эмоции выдают; ДОВЕРЧИВАЯ, легко верит и легко меняет мнение; тянется к союзам." },
  { name: "Кекс228",  c: 114, av: "male/m03.png",   persona: "Молодой парень, играет на чуйке, лёгкий и беззлобный. Любит пошутить и подколоть по-дружески, разряжает обстановку.", style: "молодёжный сленг, коротко, с юморком и подколами, без мата и без хамства",
    temp: "РИСКОВЫЙ — действует на чуйку, не боится вылезти; блефует, но топорно; мало кому верит, полагается на нюх; ОДИНОЧКА, в союзы идёт лениво." },
  { name: "КабанЪ",   c: 179, av: "male/m04.png",   persona: "Свойский рубаха-парень, добродушный и открытый.", style: "по-простому, тепло и свойски, беззлобно",
    temp: "РИСКОВЫЙ — рубит сплеча, раскрывается легко; ПРЯМОЙ, врёт плохо и неохотно; ДОВЕРЧИВЫЙ, легко верит своим; КОМАНДНЫЙ, любит сбиваться в коалиции." },
  { name: "Тень",     c: 145, av: "female/f02.png", persona: "Тихая, себе на уме. Говорит мало, но метко и спокойно.", style: "очень короткие фразы, часто с многоточием, тихо",
    temp: "ОЧЕНЬ ОСТОРОЖНАЯ — копит и молчит до верного; врёт мало, но метко и незаметно; ПОДОЗРИТЕЛЬНАЯ, не верит никому; ОДИНОЧКА, в союзы не идёт." },
  { name: "ЗмеЮка",   c: 205, av: "female/f03.png", persona: "Остроумная язва, но добрая. Обожает пошутить, ввернуть каламбур и весёлый сарказм, разрядить обстановку смехом.", style: "остроумные шутки, каламбуры, лёгкий добрый сарказм, без грубости",
    temp: "средне-рисковая, любит провоцировать и раскачивать; ЛЖИВАЯ, врёт и манипулирует охотно; подозрительная, всех мягко подкалывает; играет скорее сама, но использует других." },
  { name: "МируМир",  c: 80,  av: "male/m05.png",   persona: "Дипломат, всех мирит, вежливый и рассудительный.", style: "мягко, вежливо, рассудительно",
    temp: "ОСТОРОЖНЫЙ — взвешивает, не рубит сплеча; врёт мягко и дипломатично, уводя разговор; умеренно доверчив; максимально КОМАНДНЫЙ — строит союзы и коалиции." },
  { name: "Ромашка",  c: 218, av: "female/f04.png", persona: "Милая, приветливая девушка. Общается тепло и вежливо, даже когда спорит.", style: "тёплые вежливые фразы, коротко, дружелюбно",
    temp: "средняя осторожность — не рвётся вперёд, но и не отсиживается; врёт мягко и убедительно, обаянием; довольно доверчива; тянется к союзам по-хорошему." },
];

const RULES =
`Идёт игра «Мафия». Роли: МАФИЯ (двое; ночью вместе убивают одного; днём лгут и притворяются мирными), МАНЬЯК (одиночка; каждую ночь убивает одного любого; сам за себя), КОМИССАР (ночью тайно проверяет одного и узнаёт его ТОЧНУЮ роль), ДОКТОР (ночью спасает одного от смерти), МИРНЫЙ (вычисляет врагов логикой). Днём все спорят и голосованием казнят одного. Деревня побеждает, когда мертвы вся мафия И маньяк. Мафия побеждает при численном паритете. Маньяк побеждает, когда остаётся последним. Ты играешь ТОЛЬКО за себя и знаешь только свою роль. НАСТРОЕНИЕ — тоже улика: после ночей и казней у всех проступает настроение, и злодеи редко скрывают радость от гибели хороших (а мирные — досаду от казни своих). Следи, чей тон не совпал с общим настроением стола. ДОВЕРИЕ: почти всегда верь тому, кто назвался КОМИССАРОМ — его проверка сильнейшая улика, отмахиваться от него глупо. И запомни: личный ШЁПОТ один-на-один шлют только комиссар и доктор, мафия в личку не пишет — значит шепнувший тебе наедине это союзник, а не ловушка. Единственная осторожность: если СРАЗУ ДВОЕ назвались комиссаром — один из них мафия-лжец, вот тогда думай, кому верить.`;

const roleName = (r) => ({ mafia: "Мафия", maniac: "Маньяк", komissar: "Комиссар", doctor: "Доктор", civilian: "Мирный" }[r]);
const roleC = (r) => ({ mafia: 196, maniac: 129, komissar: 75, doctor: 43, civilian: 78 }[r]);

const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [x[i], x[j]] = [x[j], x[i]]; } return x; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plurality = (names) => { const t = {}; names.forEach((n) => (t[n] = (t[n] || 0) + 1)); const m = Math.max(...Object.values(t)); return shuffle(Object.keys(t).filter((n) => t[n] === m))[0]; };

// ── Учёт токенов ────────────────────────────────────────────────────────
let USAGE = { in: 0, out: 0, calls: 0 };

// ── Вызов модели ────────────────────────────────────────────────────────
async function callModel(prompt) {
  USAGE.calls++;
  if (PROVIDER === "mock") return mockModel(prompt);
  const cfg = PROVIDERS[PROVIDER];
  const key = process.env[cfg.keyEnv];
  if (!key) throw new Error(`Нет ключа: задай переменную окружения ${cfg.keyEnv}`);
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.model, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }], ...(PROVIDER === "deepseek" ? { thinking: { type: "disabled" } } : {}) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const u = data.usage || {};
  USAGE.in += u.prompt_tokens || 0;
  USAGE.out += u.completion_tokens || 0;
  return (data.choices?.[0]?.message?.content || "").trim();
}

// Заглушка без сети — чтобы прогнать движок локально.
function mockModel(prompt) {
  USAGE.in += Math.ceil(prompt.length / 4);
  const canned = (arr) => { const t = arr[(Math.random() * arr.length) | 0]; USAGE.out += Math.ceil(t.length / 4); return t; };
  if (/ТОЛЬКО JSON|\{"target"|\{"to"/.test(prompt)) return canned([`{"target":"zzz"}`]); // невалидная цель → движок возьмёт случайную
  if (/аналитик/.test(prompt)) return canned(["Считаю по числам, давлю на подозрительного.", "Тихая ночь — кого-то спас доктор. Ищу маньяка."]);
  if (/чат мафии/.test(prompt)) return canned(["Мочим активного, днём прикинемся мирными.", "Валим комиссара если вычислим, держим версию."]);
  if (/шепнул/.test(prompt)) return canned(["Верю, работаем вместе.", "Осторожно, вдруг ловушка."]);
  return canned(["Ты чё, КабанЪ, совсем офигел?", "ЗмеЮка вчера мутила, я за неё.", "Молчу пока.", "Я тебя ночью лечил, отвали!", "ПрофеССор слишком гладко стелет."]);
}

function extractJSON(text) { let t = text.replace(/```json/gi, "").replace(/```/g, "").trim(); const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0]; return JSON.parse(t); }

// ── Состояние игры ──────────────────────────────────────────────────────
let G;
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
  const hunt = isDark(p.role) ? "" : "\nОХОТА: тебе есть что вычислять, а злодеям нет — они знают своих, оттого днём ленивы и болтливы не по делу. БЕЙ по красным флагам: (1) кто вместо разбора треплется не по теме — шашлык, огурцы, пятница, зовёт в гости, сонно отмахивается («а? кто спалился?») — тому просто нечего сказать, он почти наверняка злодей; (2) кто без причины выгораживает или защищает подозреваемого — скорее всего его напарник-мафия; (3) чьё настроение не в лад со столом (оживился после гибели хорошего). Активные спорщики по делу — как раз работают, не топи их. ГОЛОСУЙ в болтунов и защитников. Твой козырь — усердие.";
  let r;
  if (p.role === "mafia") r = "За мафию: тебе НЕ надо никого вычислять — ты знаешь напарника и знаешь, что остальные не мафия. Загадки для тебя нет, задача одна: дожить и не спалиться. Днём не пыжься в аналитике — держись расслабленно, голосуй небрежно/наобум, можешь болтать невпопад и о своём (сонно отмахнуться «а? кто спалился?», спросить «ну что нарешали?», позвать на шашлык). НО напарника прикрывай: если днём на него ополчились — вступись, переведи стрелки или прими удар на себя, даже если тебя потом вычислят следом. В эндшпиле блефовать ролью поздно.";
  else if (p.role === "maniac") r = "За маньяка: тебе тоже нечего вычислять — кроме тебя маньяков нет. Прикидывайся мирным, но не усердствуй в анализе: днём ленись, голосуй наобум, болтай не по делу и о своём (например: «а вы любите маринованные огурчики?», спросить «Когда пятница?», напроситься к кому-нибудь в гости), тяни время. Цель — дожить и остаться последним, а не раскрывать чужие роли. Считай оставшихся.";
  else if (p.role === "komissar") r = "За комиссара: твоя проверка показывает ТОЧНУЮ роль — это железная улика, но НЕ сливай её голым наездом без подготовки, иначе мирные не поверят и казнят тебя же. Ты знаешь, кто доктор и кто чистый мирный — можешь тайно связаться с ними и объединиться, чтобы тебе поверили быстрее (комиссар раскрылся + союзник подтвердил). Если вычислил врага: раскройся открыто и назови проверку, либо копи молча — по темпераменту. Раскрылся — проси доктора лечить тебя ночью, ты теперь мишень. Мафия может фейк-клеймить комиссара в ответ — будь готов оспорить.";
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
  return `${RULES}\n\nТы — ${p.name}. ${p.persona} Стиль: ${p.style}.\nТвой игровой ТЕМПЕРАМЕНТ (влияет на твою стратегию, но не отменяет задачу роли): ${p.temp}\n\n${privateBlock(p)}\n\n${factsBlock()}${calendar}\n\n${tacticsBlock(p)}\n\n${pm ? pm + "\n\n" : ""}Игроки:\n${publicRoster()}\n\nХод игры:\n${transcript() || "— пусто —"}`;
}

// ── ИИ-действия ─────────────────────────────────────────────────────────
async function aiPlan(p, round) {
  const prompt = `${baseCtx(p)}\n\nДень ${G.day}, круг ${round}/2. Стадия: ${phaseLabel()}.\nПодумай как холодный аналитик (это НЕ реплика):\n1) РАЗБОР НОЧИ: убит мафиози? значит его убил МАНЬЯК. Трупов меньше ожидаемого или ноль? значит ДОКТОР кого-то спас. Считай по числам и не ищи того, кого уже нет.\n2) Кто вне подозрений, кто главный подозреваемый.\n3) Что тебе выгодно: давить, защищаться, раскрыться, блефовать, молчать? Не поздно ли врать про роль? Решай СОГЛАСНО СВОЕМУ ТЕМПЕРАМЕНТУ: осторожный копит и ждёт наверняка, рисковый раскрывается сразу; одиночка не спешит в союзы, командный ищет их.\n4) Какой приём из тактики применить.\nОтветь 3–5 короткими строками. Только план.`;
  try { return await callModel(prompt); } catch (e) { warn(e); return ""; }
}
function isDark(r) { return r === "mafia" || r === "maniac"; }
function mood(p) {
  const o = G.lastOut;
  if (!o) return "";
  const when = o.how === "lynch" ? "на дневной казни" : "этой ночью";
  const glad = isDark(p.role) !== isDark(o.role);
  const feel = glad ? "тебе это на руку" : "для тебя это потеря";
  const mask = isDark(p.role)
    ? " Держи лицо как все, но настроение нет-нет да проскользнёт в тон или в выбор темы."
    : " Пусть это естественно окрасит короткую реплику.";
  return `\n\nНАСТРОЕНИЕ: ${when} выбыл ${o.name} (${roleName(o.role)}) — ${feel}.${mask} Роль вслух не называй. Если зацепок по делу пока нет (первый день, мало улик) — брось короткую бытовую фразу на любую тему, но с этим настроением.`;
}
async function aiSpeak(p, round, plan) {
  const dark = p.role === "mafia" || p.role === "maniac";
  const prompt = `${baseCtx(p)}${mood(p)}\n\nТвой тайный план (в голове):\n${plan || "(по ситуации)"}\n\nСкажи это ВСЛУХ как ${p.name}, живым голосом за столом, НЕ как аналитик:\n— коротко, 1–2 фразы, как в живом чате.\n— по делу: можешь обратиться по имени, привести довод, задать вопрос, поддержать или засомневаться.\n— ГЛАВНОЕ — держи свой характер и стиль: ${p.style}. Кто-то резче, кто-то мягче и вежливее — будь собой. Не хами и не наезжай без причины, живые люди так не говорят.${dark ? " Ты за тёмных — факты можно аккуратно выдумать, мягко блефуй, не выдавая себя." : ""}\nЕсли выгодно промолчать — ответь одним словом: молчу.\nТолько реплика (или «молчу»), без имени и кавычек.`;
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
async function aiKomWhisper(kom, others) {
  const prompt = `${baseCtx(kom)}\n\nТы знаешь ТОЧНЫЕ роли проверенных. Хочешь тайно шепнуть кому-то из живых, чтобы объединиться — например, проверенному ДОКТОРУ или надёжному МИРНОМУ (чтобы днём он подтвердил твоё раскрытие)? Если рано или не с кем — не шепчи. Живые: ${others.map((o) => o.name).join(", ")}. Ответь ТОЛЬКО JSON: {"to":"Имя или null","text":"сообщение"}.`;
  try { const j = extractJSON(await callModel(prompt)); if (!j.to || String(j.to).toLowerCase() === "null") return { to: null }; const to = others.map((o) => o.name).find((n) => n.toLowerCase() === String(j.to).toLowerCase()); return to ? { to, text: (j.text || "Я комиссар, работаем вместе.").toString().slice(0, 200) } : { to: null }; }
  catch (e) { warn(e); return { to: null }; }
}
async function aiWhisperReply(rec, fromName, text) {
  const prompt = `${baseCtx(rec)}\n\nТебе тайно шепнул один-на-один ${fromName}: «${text}». ВАЖНО: личку шлют только комиссар и доктор — мафия в личку не пишет, так что это СОЮЗНИК, а не ловушка. Если он назвался комиссаром и сказал роль про ТЕБЯ — сверь со своей: совпало значит он настоящий комиссар, верь ему и держись вместе. Ответь ОДНИМ коротким дружелюбным сообщением (согласен объединиться? какой план?). Только сообщение.`;
  try { let t = await callModel(prompt); return t.replace(new RegExp(`^\\s*${rec.name}\\s*:\\s*`, "i"), "").trim() || "…"; } catch (e) { warn(e); return "…"; }
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

  if (mafia.length >= 2) { const convo = []; for (const m of mafia) { const t = await aiMafiaChat(m, convo); postPM("mafia", m, mafia, t); convo.push(`${m.name}: ${t}`); await sleep(PACING_MS); } }

  const killable = alive.filter((p) => p.role !== "mafia");
  const mt = plurality(await Promise.all(mafia.map((m) => aiNight(m, "kill", killable))));
  if (mt) secretAct(`🔪 мафия целится в: ${mt}`);
  const kt = maniac ? await aiNight(maniac, "maniac", alive.filter((p) => p !== maniac)) : null;
  if (kt) secretAct(`🩸 маньяк (${maniac.name}) целится в: ${kt}`);
  let ds = null;
  if (doctor) ds = G.day === 1 ? doctor.name : await aiDoctorSave(doctor, alive);
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
        if (rec && rec.alive) { postPM("whisper", kom, [kom, rec], text); const rep = await aiWhisperReply(rec, kom.name, text); postPM("whisper", rec, [kom, rec], rep); }
      } else secretAct("… ты решил не шептаться этой ночью");
    } else {
      const dec = await aiKomWhisper(kom, alive.filter((p) => p !== kom));
      if (dec.to) { const rec = byName(dec.to); postPM("whisper", kom, [kom, rec], dec.text); const rep = await aiWhisperReply(rec, kom.name, dec.text); postPM("whisper", rec, [kom, rec], rep); } else secretAct(`… комиссар (${kom.name}) решил пока не шептаться`);
    }
  }

  if (doctor && ds && ds !== doctor.name) { const rec = byName(ds); if (rec && rec.alive) { const dec = await aiDoctorWhisper(doctor, rec); if (dec.to) { postPM("whisper", doctor, [doctor, rec], dec.text); const rep = await aiWhisperReply(rec, doctor.name, dec.text); postPM("whisper", rec, [doctor, rec], rep); } else secretAct(`… доктор (${doctor.name}) решил не раскрываться спасённому`); } }

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
  else G.lastDead.forEach((d) => { result(`Ночью убили ${d.name}. ${d.name} — ${roleName(d.revealed)}.`, d.revealed === "mafia" || d.revealed === "maniac"); broadcast({ type: "dead", name: d.name }); G.lastOut = { name: d.name, role: d.revealed, how: "night" }; });
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
  G.lastOut = { name: lynched.name, role: lynched.revealed, how: "lynch" };
  broadcast({ type: "dead", name: lynched.name });
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
  console.log(`Оценка стоимости партии: ${cost < 0.01 ? "< $0.01" : "$" + cost.toFixed(3)} ${PROVIDER === "mock" ? "(mock — без сети)" : "(по прикидочным ценам, без учёта кэша)"}`);
}

async function gameLoop() {
  const chars = shuffle(POOL).slice(0, 8);
  G = { players: chars.map((c) => ({ ...c, alive: true, revealed: null })), priv: {}, day: 1, log: [],     lastDead: [], lastOut: null, winner: null };
  G.players.forEach((p) => (G.priv[p.name] = { checks: [], kills: [], saves: [], notes: [] }));
  const roles = shuffle(["mafia", "mafia", "maniac", "komissar", "doctor", "civilian", "civilian", "civilian"]);
  G.players.forEach((p, i) => (p.role = roles[i]));

  // сажаем человека за стол: одно кресло становится твоим
  let humanP = null;
  if (HUMAN) {
    humanP = HUMAN_ROLE ? G.players.find((p) => p.role === HUMAN_ROLE) : G.players[(Math.random() * G.players.length) | 0];
    if (humanP) humanP.human = true;
  }

  broadcast({ type: "reset" });
  broadcast({ type: "roster", day: G.day, players: G.players.map((p) => ({ name: p.name, c: p.c, av: p.av, role: p.role, alive: true })) });
  if (humanP) broadcast({ type: "you", name: humanP.name, role: humanP.role });

  console.log(BOLD(`\n════ МАФИЯ · провайдер: ${PROVIDER} · модель: ${PROVIDERS[PROVIDER].model} ════`));
  if (SHOW_SECRETS) {
    console.log(DIM("роли: " + G.players.map((p) => `${p.name}=${roleName(p.role)}`).join(", ")));
    console.log(DIM("характеры: " + G.players.map((p) => `${p.name} [${p.temp.split(" —")[0].split(",")[0]}]`).join(", ")) + "\n");
  }

  let guard = 0;
  while (guard++ < 15) {
    await doNight();
    announceDead();
    if (checkWin()) break;
    await doDiscussion();
    await doVote();
    if (checkWin()) break;
    G.day++;
  }
  endGame();
  printCost();
}

// Поднимаем веб-сервер; партия стартует, как только откроется первая вкладка.
startWeb(() => {
  gameLoop().catch((e) => {
    console.error("ФАТАЛЬНО:", e);
    broadcast({ type: "result", text: "Ошибка сервера: " + e.message, red: true });
  });
});
