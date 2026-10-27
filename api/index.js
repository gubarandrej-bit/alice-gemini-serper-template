import { timingSafeEqual } from "node:crypto";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 180;
const MAX_SESSION_STATE_BYTES = 960; // Yandex Alice hard limit for session_state JSON is 1024 bytes
const MAX_ALICE_TEXT = 1024;

// Yandex Dialogs expects the full HTTP round-trip within ~4.5s.
// Keep ~600ms margin for network transit between Yandex and Vercel.
const TOTAL_RESPONSE_BUDGET_MS = 3900;
const SERPER_TIMEOUT_MS = 700;
const MIN_GEMINI_BUDGET_AFTER_SEARCH_MS = 2500;
const GEMINI_TIMEOUT_MS = 3600;
const GEMINI_MAX_OUTPUT_TOKENS = 500;

const BASE_SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно воспринимать на слух.",
  "Обычно используй 1–3 коротких предложения.",
  "Не используй Markdown, звёздочки, таблицы, списки с символами, ссылки или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них и не выдумывай отсутствующие факты.",
  "Если точных данных нет, честно скажи об этом."
].join(" ");

const EXIT_COMMAND_RE = /^(хватит|стоп|выйти|выход|закончить|закройся|завершить|пока|до свидания|все спасибо|всё спасибо)$/i;
const HELP_COMMAND_RE = /^(помощь|справка|что ты умеешь|что ты можешь|кто ты|инструкция|как пользоваться)$/i;
const RESET_COMMAND_RE = /^(забудь|забудь все|забудь всё|сбрось контекст|сбросить контекст|очисти историю|новый диалог|начни сначала|смени тему)$/i;

const SEARCH_INTENT_RE = new RegExp(
  [
    "\\b(latest|today|tomorrow|current|news|weather|forecast|price|exchange rate|bitcoin|usd|eur|recent|search|look up|score|schedule|who won|release date)\\b",
    "сегодня|сейчас|завтра|вчера|на этой неделе|в этом году|202[4-9]|203\\d",
    "последн|новост|событи|случил|произошл",
    "погод|температур|прогноз|дождь|снег|ветер|градус",
    "курс|валют|доллар|евро|рубл|биткоин|юан|акци|ключев\\S* ставк",
    "сколько стоит|цена|цены|стоимост",
    "найди|поищи|погугли|актуальн|свежие данные",
    "кто выиграл|кто победил|счёт|счет|матч|турнир|чемпион",
    "расписани|пробк|когда выйдет|дата выхода|релиз|кто сейчас"
  ].join("|"),
  "i"
);

const FOLLOWUP_QUERY_RE = /^(а |и |ну а |а в |а во |а на |а про |а по |а там|а у |а сколько|а когда|а завтра|а вчера|а сегодня|what about|how about|and in )/i;

function truncateSafe(value, maxChars) {
  const str = String(value ?? "");
  if (str.length <= maxChars) return str;
  let end = maxChars;
  // Avoid splitting a UTF-16 surrogate pair in half
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return str.slice(0, Math.max(0, end));
}

function stripVoiceUnfriendlyFormatting(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/https?:\/\/[^\s)]+?([.,!?;:]?)(?=\s|$)/gi, "$1")
    .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
    .replace(/(^|\n)\s*[-*•]\s+/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function fitAliceText(value) {
  const text = stripVoiceUnfriendlyFormatting(value);

  if (!text) return "Не удалось подготовить ответ.";
  if (text.length <= MAX_ALICE_TEXT) return text;

  const candidate = truncateSafe(text, MAX_ALICE_TEXT - 1);
  let sentenceEnd = -1;
  for (let i = candidate.length - 1; i >= 0; i--) {
    const ch = candidate[i];
    if ((ch === "." || ch === "!" || ch === "?" || ch === "…") && (i === candidate.length - 1 || candidate[i + 1] === " ")) {
      sentenceEnd = i;
      break;
    }
  }
  if (sentenceEnd >= 300) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  const valid = [];
  for (const item of history) {
    if (!item || (item.role !== "user" && item.role !== "model") || typeof item.text !== "string") {
      continue;
    }
    const cleaned = item.text.trim();
    if (!cleaned) continue;
    const truncated = truncateSafe(cleaned, MAX_HISTORY_MESSAGE_CHARS);

    // Keep strict user/model alternation expected by Gemini multi-turn contents
    if (valid.length > 0 && valid[valid.length - 1].role === item.role) {
      valid[valid.length - 1] = { role: item.role, text: truncated };
    } else {
      valid.push({ role: item.role, text: truncated });
    }
  }

  let sliced = valid.slice(-MAX_HISTORY_MESSAGES);
  // Gemini requires conversation history to start with a "user" turn
  while (sliced.length > 0 && sliced[0].role !== "user") {
    sliced.shift();
  }
  return sliced;
}

function fitHistoryToStateLimit(history) {
  const normalized = safeHistory(history);
  while (normalized.length > 0) {
    const bytes = Buffer.byteLength(JSON.stringify({ history: normalized }), "utf8");
    if (bytes <= MAX_SESSION_STATE_BYTES) break;
    normalized.shift();
    while (normalized.length > 0 && normalized[0].role !== "user") {
      normalized.shift();
    }
  }
  return normalized;
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: Boolean(endSession)
    },
    session_state: {
      history: endSession ? [] : fitHistoryToStateLimit(history)
    }
  };
}

function isSearchIntent(text) {
  return SEARCH_INTENT_RE.test(String(text ?? ""));
}

function buildSearchQuery(text, history = []) {
  const current = String(text ?? "").trim();
  if (!current) return "";

  const safe = safeHistory(history);
  const lastUserTurn = [...safe].reverse().find(item => item.role === "user");
  if (lastUserTurn && (current.length < 40 || FOLLOWUP_QUERY_RE.test(current))) {
    return truncateSafe(`${lastUserTurn.text} ${current}`, 200);
  }
  return truncateSafe(current, 200);
}

function buildSystemPrompt(timezone) {
  const tz = typeof timezone === "string" && timezone.trim() ? timezone.trim() : "Europe/Moscow";
  let dateLabel = "";
  try {
    dateLabel = new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    }).format(new Date());
  } catch {
    dateLabel = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    }).format(new Date());
  }
  return `${BASE_SYSTEM_PROMPT} Сегодняшняя дата: ${dateLabel}.`;
}

function isTimeoutError(error) {
  return Boolean(
    error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        error.code === "ABORT_ERR" ||
        error.message === "AbortError" ||
        error.message === "TIME_BUDGET_EXHAUSTED")
  );
}

async function fetchJson(url, options, timeoutMs) {
  const budget = Math.floor(Number(timeoutMs) || 0);
  if (budget < 100) {
    throw new Error("TIME_BUDGET_EXHAUSTED");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data = {};
    try {
      data = await response.json();
    } catch (parseError) {
      if (controller.signal.aborted || isTimeoutError(parseError)) {
        throw new Error("TIME_BUDGET_EXHAUSTED");
      }
      data = {};
    }
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted || isTimeoutError(error)) {
      throw new Error("TIME_BUDGET_EXHAUSTED");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY?.trim();
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = [];
    const answerBox = data?.answerBox?.answer || data?.answerBox?.snippet;
    if (answerBox) {
      items.push(`Краткий ответ поисковика: ${truncateSafe(answerBox, 350)}`);
    }

    const kgDescription = data?.knowledgeGraph?.description;
    if (kgDescription) {
      const kgTitle = data?.knowledgeGraph?.title ? `${data.knowledgeGraph.title}: ` : "";
      items.push(`Справка: ${truncateSafe(`${kgTitle}${kgDescription}`, 300)}`);
    }

    const organic = Array.isArray(data?.organic) ? data.organic.slice(0, 3) : [];
    for (let i = 0; i < organic.length; i++) {
      const item = organic[i] || {};
      const title = truncateSafe(item.title || "", 160);
      const snippet = truncateSafe(item.snippet || "", 320);
      const date = item.date ? ` (${truncateSafe(item.date, 40)})` : "";
      const line = `${i + 1}. ${title}${date}: ${snippet}`.trim();
      if (title || snippet) items.push(line);
    }

    return items.length ? items.join("\n") : "";
  } catch (error) {
    if (isTimeoutError(error)) {
      console.warn("Serper request timed out; continuing without search.");
    } else {
      console.warn("Serper request failed; continuing without search:", error?.message || "unknown error");
    }
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs, timezone) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй эти сведения только там, где они относятся к вопросу.`
    : text;

  if (contents.length > 0 && contents[contents.length - 1].role === "user") {
    contents[contents.length - 1] = { role: "user", parts: [{ text: prompt }] };
  } else {
    contents.push({ role: "user", parts: [{ text: prompt }] });
  }

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(timezone) }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    const apiMessage = String(data?.error?.message || "");
    const apiStatus = String(data?.error?.status || "");
    console.error("Gemini request failed with HTTP", status, apiStatus);
    if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(apiMessage)) {
      throw new Error("GEMINI_KEY_REJECTED");
    }
    if (status === 400 && (apiStatus === "FAILED_PRECONDITION" || /location is not supported|free tier is not available/i.test(apiMessage))) {
      throw new Error("GEMINI_REGION_RESTRICTED");
    }
    if (status === 404) throw new Error("INVALID_MODEL_NAME");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .filter(part => part && !part.thought && typeof part.text === "string")
    .map(part => part.text)
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") {
      throw new Error("GEMINI_BLOCKED");
    }
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  if (isTimeoutError(error)) {
    return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
  }

  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_REGION_RESTRICTED":
      return "Gemini недоступен из текущего региона сервера. Проверьте регион функций Vercel (рекомендуется США, iad1).";
    case "INVALID_MODEL_NAME":
      return "Указана недоступная модель Gemini. Проверьте переменную GEMINI_MODEL в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте сформулировать его иначе.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

function safeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractWebhookSecretFromReq(req) {
  const headerSecret = req?.headers?.["x-webhook-secret"];
  if (typeof headerSecret === "string" && headerSecret) return headerSecret;
  if (typeof req?.query?.secret === "string" && req.query.secret) return req.query.secret;
  if (typeof req?.url === "string") {
    try {
      const parsed = new URL(req.url, "http://localhost");
      return parsed.searchParams.get("secret") || "";
    } catch {
      return "";
    }
  }
  return "";
}

function isAuthorizedRequest(req, body) {
  const expectedSecret = process.env.WEBHOOK_SECRET?.trim();
  if (expectedSecret) {
    const providedSecret = extractWebhookSecretFromReq(req);
    if (!providedSecret || !safeEqualStrings(providedSecret, expectedSecret)) {
      return false;
    }
  }

  const expectedSkillId = process.env.ALICE_SKILL_ID?.trim();
  if (expectedSkillId) {
    const incomingSkillId = typeof body?.session?.skill_id === "string" ? body.session.skill_id.trim() : "";
    if (!incomingSkillId || !safeEqualStrings(incomingSkillId, expectedSkillId)) {
      return false;
    }
  }

  return true;
}

function parseRequestBody(rawBody) {
  if (!rawBody) return {};
  if (typeof rawBody === "object") return rawBody;
  if (typeof rawBody === "string") {
    try {
      const parsed = JSON.parse(rawBody);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeCommand(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[.,!?…«»"'()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = parseRequestBody(req.body);

  if (!isAuthorizedRequest(req, body)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const hasCommandField = typeof body?.request?.command === "string";
  const rawCommand = hasCommandField ? body.request.command.trim() : "";
  const rawUtterance = typeof body?.request?.original_utterance === "string" ? body.request.original_utterance.trim() : "";
  const isNewSession = body?.session?.new === true;
  const oldHistory = fitHistoryToStateLimit(body?.state?.session?.history);

  // Yandex Dialogs health-check ping: never bill Gemini/Serper for technical probes
  if (rawUtterance.toLowerCase() === "ping" || rawCommand.toLowerCase() === "ping") {
    return res.status(200).json(aliceResponse("pong", true, []));
  }

  // On session launch ("Алиса, запусти навык X"), Yandex sends session.new=true, command="",
  // while original_utterance still contains the activation phrase. Use command on new sessions
  // so launch greets instantly (and warms up Vercel) instead of sending the activation phrase to Gemini.
  const text = isNewSession && hasCommandField
    ? rawCommand
    : (rawUtterance || rawCommand);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию в интернете. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  const cleanCmd = normalizeCommand(text);

  if (EXIT_COMMAND_RE.test(cleanCmd)) {
    return res.status(200).json(aliceResponse("До встречи! Обращайся ещё.", true, []));
  }

  if (HELP_COMMAND_RE.test(cleanCmd)) {
    return res.status(200).json(aliceResponse(
      "Я отвечаю на вопросы с помощью нейросети Gemini и ищу свежие новости, погоду или курсы в интернете. Просто задай вопрос. Скажи «забудь», чтобы начать заново, или «хватит», чтобы выйти.",
      false,
      oldHistory
    ));
  }

  if (RESET_COMMAND_RE.test(cleanCmd)) {
    return res.status(200).json(aliceResponse(
      "Хорошо, начнём с чистого листа. О чём поговорим?",
      false,
      []
    ));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY?.trim()) {
      const searchBudgetMs = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(0, remainingMs() - MIN_GEMINI_BUDGET_AFTER_SEARCH_MS)
      );
      if (searchBudgetMs >= 150) {
        const searchQuery = buildSearchQuery(text, oldHistory);
        searchContext = await searchWeb(searchQuery, searchBudgetMs);
      }
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs())),
      body?.meta?.timezone
    );

    const history = fitHistoryToStateLimit([
      ...oldHistory,
      { role: "user", text: truncateSafe(text, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: truncateSafe(stripVoiceUnfriendlyFormatting(answer), MAX_HISTORY_MESSAGE_CHARS) }
    ]);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const normalizedError = isTimeoutError(error) ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Alice webhook returned a fallback response:", normalizedError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(normalizedError), false, oldHistory));
  }
}

export {
  aliceResponse,
  buildSearchQuery,
  fitAliceText,
  fitHistoryToStateLimit,
  isSearchIntent,
  isTimeoutError,
  safeHistory
};
