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

function startWeb(onFirstViewer) {
  const app = express();
  app.use(express.static(require("path").join(__dirname, "public")));

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
  { name: "Трубач",   c: 111, persona: "Простой работяга-сантехник. Говорит прямо, по-рабочему, режет правду-матку, любит метафоры про трубы и воду.", style: "короткие рубленые фразы, простецкие словечки",
    temp: "ПРЯМОЙ правдоруб — врать не любит и делает это топорно; осторожность средняя; верит делам, а не словам; в союзы идёт неохотно." },
  { name: "ПрофеССор", c: 183, persona: "Интеллигент. Раскладывает всё по логическим полочкам, говорит гладко и чуть свысока.", style: "складные предложения, вежливо-снисходительный тон",
    temp: "ОСТОРОЖНЫЙ — копит информацию и ждёт наверняка, не раскрывается рано; врёт умело и гладко, если надо; никому не верит на слово, всё проверяет логикой; союзы строит расчётливо." },
  { name: "Фурия",    c: 211, persona: "Вспыльчивая, всё на эмоциях. Быстро подозревает и быстро верит.", style: "восклицания, иногда КАПСОМ, много эмоций",
    temp: "РИСКОВАЯ — лезет напролом, раскрывается сразу; врать почти не умеет, эмоции выдают; ДОВЕРЧИВАЯ, легко верит и легко меняет мнение; тянется к союзам." },
  { name: "Кекс228",  c: 114, persona: "Молодой пацан, играет на чуйке, дерзкий.", style: "пишет с ошибками, без запятых, сленг (чё, ваще, короче), лёгкий мат",
    temp: "РИСКОВЫЙ — действует на чуйку, не боится вылезти; блефует дерзко, но топорно; мало кому верит, полагается на нюх; ОДИНОЧКА, в союзы идёт лениво." },
  { name: "КабанЪ",   c: 179, persona: "Рубаха-парень, свойский, рубит сплеча.", style: "матерится (блин, нахер, чёрт), громкий и свойский",
    temp: "РИСКОВЫЙ — рубит сплеча, раскрывается легко; ПРЯМОЙ, врёт плохо и неохотно; ДОВЕРЧИВЫЙ, легко верит своим; КОМАНДНЫЙ, любит сбиваться в коалиции." },
  { name: "Тень",     c: 145, persona: "Тихушница, себе на уме. Говорит мало, но метко.", style: "очень короткие фразы, часто с многоточием",
    temp: "ОЧЕНЬ ОСТОРОЖНАЯ — копит и молчит до верного; врёт мало, но метко и незаметно; ПОДОЗРИТЕЛЬНАЯ, не верит никому; ОДИНОЧКА, в союзы не идёт." },
  { name: "ЗмеЮка",   c: 205, persona: "Язва. Всё через сарказм и подколы.", style: "саркастичные колкости, ирония",
    temp: "средне-рисковая, любит провоцировать и раскачивать; ЛЖИВАЯ, врёт и манипулирует охотно; подозрительная, всех подкалывает; играет скорее сама, но использует других." },
  { name: "МируМир",  c: 80,  persona: "Дипломат, всех мирит, но умеет надавить.", style: "мягкий, рассудительный",
    temp: "ОСТОРОЖНЫЙ — взвешивает, не рубит сплеча; врёт мягко и дипломатично, уводя разговор; умеренно доверчив; максимально КОМАНДНЫЙ — строит союзы и коалиции." },
];

const RULES =
`Идёт игра «Мафия». Роли: МАФИЯ (двое; ночью вместе убивают одного; днём лгут и притворяются мирными), МАНЬЯК (одиночка; каждую ночь убивает одного любого; сам за себя), КОМИССАР (ночью тайно проверяет одного — мафия он или нет), ДОКТОР (ночью спасает одного от смерти), МИРНЫЙ (вычисляет врагов логикой). Днём все спорят и голосованием казнят одного. Деревня побеждает, когда мертвы вся мафия И маньяк. Мафия побеждает при численном паритете. Маньяк побеждает, когда остаётся последним. Ты играешь ТОЛЬКО за себя и знаешь только свою роль.`;

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
function secretPM(channel, from, text) { if (SHOW_SECRETS) { console.log(DIM(`   🔒 ${channel === "mafia" ? "мафия" : "шёпот"} · ${from}: ${text}`)); broadcast({ type: "pm", channel, from, text }); } }
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
  else if (p.role === "komissar") { const ch = pr.checks; s += ch.length ? ` Результаты проверок: ${ch.map((c) => `${c.name} — ${c.mafia ? "МАФИЯ" : "не мафия"}`).join("; ")}. Решай, когда раскрыться.` : ` Пока никого не проверял.`; }
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
  let r;
  if (p.role === "mafia") r = "За мафию: копируй мирных — спорь и голосуй, будто нечего скрывать. Если напарника топят — поддержи или сам выставь его первым ради доверия. Можешь намекнуть, что доктор лечит тебя. В эндшпиле блефовать ролью поздно.";
  else if (p.role === "maniac") r = "За маньяка: прикидывайся мирным, подыгрывай то одним, то другим, тяни игру. Цель — остаться последним, считай оставшихся.";
  else if (p.role === "komissar") r = "За комиссара: твоя проверка — железная улика, НЕ сливай её голым наездом без доказательств, иначе мирные не поймут и казнят тебя же. Если вычислил мафию: либо ОТКРЫТО раскройся и назови проверку («я комиссар, проверял X — он мафия, вешаем»), либо копи молча — по темпераменту. Раскрылся — сразу проси доктора лечить тебя ночью, ты теперь мишень. Помни: мафия может фейк-клеймить комиссара в ответ, будь готов оспорить.";
  else if (p.role === "doctor") r = "За доктора: молчи о роли без нужды — раскрытие смертельно опасно. Ночь 1 лечи себя. Дальше лечи вероятные мишени: активных мирных, а если кто-то раскрылся комиссаром — лечи его. Кого лечил в тихую ночь — почти наверняка мирный, это твой козырь: можешь тайно шепнуть ему союз (взвесив риск) или, если это переломит игру (спасти невиновного, разрушить ложь мафии), раскрыться при всех — но тогда дальше лечи себя.";
  else r = "За мирного: не отсиживайся — тихоню считают мафией. Аргументируй каждый голос. Следи за перепалками: мафия может имитировать ссору между собой.";
  return `ТАКТИКА (только для тебя):\n${common}\n${r}`;
}
function pmBlock(p) { const n = G.priv[p.name].notes; return n.length ? `ЛИЧНЫЕ СООБЩЕНИЯ (видишь только ты):\n${n.join("\n")}` : ""; }
function baseCtx(p) {
  const pm = pmBlock(p);
  return `${RULES}\n\nТы — ${p.name}. ${p.persona} Стиль: ${p.style}.\nТвой игровой ТЕМПЕРАМЕНТ (влияет на твою стратегию, но не отменяет задачу роли): ${p.temp}\n\n${privateBlock(p)}\n\n${factsBlock()}\n\n${tacticsBlock(p)}\n\n${pm ? pm + "\n\n" : ""}Игроки:\n${publicRoster()}\n\nХод игры:\n${transcript() || "— пусто —"}`;
}

// ── ИИ-действия ─────────────────────────────────────────────────────────
async function aiPlan(p, round) {
  const prompt = `${baseCtx(p)}\n\nДень ${G.day}, круг ${round}/2. Стадия: ${phaseLabel()}.\nПодумай как холодный аналитик (это НЕ реплика):\n1) РАЗБОР НОЧИ: убит мафиози? значит его убил МАНЬЯК. Трупов меньше ожидаемого или ноль? значит ДОКТОР кого-то спас. Считай по числам и не ищи того, кого уже нет.\n2) Кто вне подозрений, кто главный подозреваемый.\n3) Что тебе выгодно: давить, защищаться, раскрыться, блефовать, молчать? Не поздно ли врать про роль? Решай СОГЛАСНО СВОЕМУ ТЕМПЕРАМЕНТУ: осторожный копит и ждёт наверняка, рисковый раскрывается сразу; одиночка не спешит в союзы, командный ищет их.\n4) Какой приём из тактики применить.\nОтветь 3–5 короткими строками. Только план.`;
  try { return await callModel(prompt); } catch (e) { warn(e); return ""; }
}
async function aiSpeak(p, round, plan) {
  const dark = p.role === "mafia" || p.role === "maniac";
  const prompt = `${baseCtx(p)}\n\nТвой тайный план (в голове):\n${plan || "(по ситуации)"}\n\nСкажи это ВСЛУХ как ${p.name}, живым голосом за столом, НЕ как аналитик:\n— коротко и резко, как в чате, 1–2 фразы.\n— обращайся по ИМЕНИ и дави лично: «ты чё, КабанЪ, офигел?».\n— швыряй факты в лицо: «я тебя ночью лечил!».${dark ? " Ты за тёмных — факты можно и НАГЛО ВЫДУМАТЬ, блефуй." : ""}\n— можно вспылить, съязвить, наехать. Держи свой стиль: ${p.style}.\nЕсли выгодно промолчать — ответь одним словом: молчу.\nТолько реплика (или «молчу»), без имени и кавычек.`;
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
    : `Ночь. Ты комиссар, проверяешь одного: ${list.join(", ")}.`;
  const pool = kind === "save" ? opts.map((o) => o.name) : list;
  try { const j = extractJSON(await callModel(`${baseCtx(p)}\n\n${task} Ответь ТОЛЬКО JSON: {"target":"Имя"}.`)); return pool.find((n) => j.target && n.toLowerCase() === String(j.target).toLowerCase()) || pool[(Math.random() * pool.length) | 0]; }
  catch (e) { warn(e); return pool[(Math.random() * pool.length) | 0]; }
}
async function aiMafiaChat(p, convo) {
  const prompt = `${baseCtx(p)}\n\nТы в тайном чате мафии с напарником (мирные не видят). Уже сказано:\n${convo.join("\n") || "— пусто —"}\nНапиши напарнику ОДНО короткое сообщение: согласуй, кого убить и какую легенду держать днём. Только сообщение.`;
  try { let t = await callModel(prompt); return t.replace(new RegExp(`^\\s*${p.name}\\s*:\\s*`, "i"), "").trim() || "…"; } catch (e) { warn(e); return "…"; }
}
async function aiKomWhisper(kom, others) {
  const prompt = `${baseCtx(kom)}\n\nХочешь тайно шепнуть одному из живых, чтобы завязать союз (например, кого проверил как НЕ мафию)? Если рано — не шепчи. Живые: ${others.map((o) => o.name).join(", ")}. Ответь ТОЛЬКО JSON: {"to":"Имя или null","text":"сообщение"}.`;
  try { const j = extractJSON(await callModel(prompt)); if (!j.to || String(j.to).toLowerCase() === "null") return { to: null }; const to = others.map((o) => o.name).find((n) => n.toLowerCase() === String(j.to).toLowerCase()); return to ? { to, text: (j.text || "Я комиссар, работаем вместе.").toString().slice(0, 200) } : { to: null }; }
  catch (e) { warn(e); return { to: null }; }
}
async function aiWhisperReply(rec, fromName, text) {
  const prompt = `${baseCtx(rec)}\n\nТебе тайно шепнул ${fromName}: «${text}». Ответь ОДНИМ коротким сообщением (веришь? план? осторожничаешь? это может быть ловушка мафии). Только сообщение.`;
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
  secretPM(channel, from.name, text);
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
  if (kom) { checkName = await aiNight(kom, "check", alive.filter((p) => p !== kom)); const tp = byName(checkName); G.priv[kom.name].checks.push({ name: tp.name, mafia: tp.role === "mafia" }); secretAct(`🔍 комиссар (${kom.name}) проверяет: ${checkName} → ${tp.role === "mafia" ? "МАФИЯ" : "не мафия"}`); }

  if (kom) { const dec = await aiKomWhisper(kom, alive.filter((p) => p !== kom)); if (dec.to) { const rec = byName(dec.to); postPM("whisper", kom, [kom, rec], dec.text); const rep = await aiWhisperReply(rec, kom.name, dec.text); postPM("whisper", rec, [kom, rec], rep); } else secretAct(`… комиссар (${kom.name}) решил пока не шептаться`); }

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
  else G.lastDead.forEach((d) => { result(`Ночью убили ${d.name}. ${d.name} — ${roleName(d.revealed)}.`, d.revealed === "mafia" || d.revealed === "maniac"); broadcast({ type: "dead", name: d.name }); });
  G.lastDead = [];
}

async function doDiscussion() {
  for (let round = 1; round <= 2; round++) {
    narrator(`— круг обсуждения ${round}/2 —`);
    for (const p of shuffle(living())) {
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
    const r = await aiVote(p);
    vote(p.name, r.target, r.reason);
    tally[r.target] = (tally[r.target] || 0) + 1;
    await sleep(PACING_MS);
  }
  const max = Math.max(...Object.values(tally));
  const lynched = byName(shuffle(Object.keys(tally).filter((n) => tally[n] === max))[0]);
  lynched.alive = false; lynched.revealed = lynched.role;
  result(`Казнён ${lynched.name} (${max} гол.). ${lynched.name} — ${roleName(lynched.revealed)}.`, lynched.revealed === "mafia" || lynched.revealed === "maniac");
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
  G = { players: chars.map((c) => ({ ...c, alive: true, revealed: null })), priv: {}, day: 1, log: [], lastDead: [], winner: null };
  G.players.forEach((p) => (G.priv[p.name] = { checks: [], kills: [], saves: [], notes: [] }));
  const roles = shuffle(["mafia", "mafia", "maniac", "komissar", "doctor", "civilian", "civilian", "civilian"]);
  G.players.forEach((p, i) => (p.role = roles[i]));

  broadcast({ type: "reset" });
  broadcast({ type: "roster", day: G.day, players: G.players.map((p) => ({ name: p.name, c: p.c, role: p.role, alive: true })) });

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
