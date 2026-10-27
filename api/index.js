import { timingSafeEqual } from "node:crypto";
import {
  MAX_ALICE_TEXT,
  fitAliceText,
  normalizeCommand,
  splitAliceAnswer,
  stripVoiceUnfriendlyFormatting,
  truncateSafe
} from "../lib/text.js";
import { buildAliceTts } from "../lib/tts.js";
import { buildSystemPrompt, detectModeCommand } from "../lib/modes.js";
import {
  MAX_HISTORY_MESSAGE_CHARS,
  detectProfileCommand,
  fitApplicationState,
  fitHistoryToStateLimit,
  fitSessionState,
  safeApplicationState,
  safeHistory,
  safeMode,
  safeUserProfile
} from "../lib/state.js";
import { buildScreenButtons } from "../lib/buttons.js";
import {
  clearCachesForTests,
  consumePendingResult,
  generatePendingId,
  getCachedSearchResult,
  isUpstashConfigured,
  registerBackgroundPendingTask,
  setCachedSearchResult
} from "../lib/cache.js";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";

// Yandex Dialogs expects the full HTTP round-trip within ~4.5s.
const TOTAL_RESPONSE_BUDGET_MS = 3850;
const SERPER_TIMEOUT_MS = 700;
const MIN_GEMINI_BUDGET_AFTER_SEARCH_MS = 2500;
const GEMINI_TIMEOUT_MS = 3600;
const BACKGROUND_GEMINI_TIMEOUT_MS = 8800; // Fits safely inside Vercel maxDuration: 10s
const GEMINI_MAX_OUTPUT_TOKENS = 650;

const EXIT_COMMAND_RE = /^(хватит|стоп|выйти|выход|закончить|закройся|завершить|пока|до свидания|все спасибо|всё спасибо)$/i;
const HELP_COMMAND_RE = /^(помощь|справка|что ты умеешь|что ты можешь|кто ты|инструкция|как пользоваться)$/i;
const RESET_COMMAND_RE = /^(забудь|забудь все|забудь всё|сбрось контекст|сбросить контекст|очисти историю|новый диалог|начни сначала|смени тему)$/i;
const CONTINUE_COMMAND_RE = /^(дальше|продолжай|продолжи|еще|ещё|читай дальше|расскажи дальше|готово|ну что)$/i;
const AFFIRMATIVE_CONTINUE_RE = /^(да|давай|ага|угу|хочу)$/i;
const ELABORATE_COMMAND_RE = /^(подробнее|расскажи подробнее|объясни подробнее)$/i;

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

const LOCAL_CITY_INTENT_RE = /погод|температур|прогноз|дождь|снег|ветер|градус|пробк|афиш|куда сходить|расписани/i;
const EXPLICIT_LOCATION_RE = /\b(в|во|на|из|для|по|около|у)\s+[а-яёa-z]{3,}/i;
const FOLLOWUP_QUERY_RE = /^(а |и |ну а |а в |а во |а на |а про |а по |а там|а у |а сколько|а когда|а завтра|а вчера|а сегодня|what about|how about|and in )/i;

function aliceResponse(text, endSession = false, history = [], extra = {}) {
  const fittedText = fitAliceText(text);
  const mode = endSession ? "assistant" : safeMode(extra.mode);
  const sessionState = endSession ? { history: [] } : fitSessionState(history, mode);

  const responsePayload = {
    text: fittedText,
    tts: typeof extra.tts === "string" && extra.tts ? extra.tts : buildAliceTts(fittedText),
    end_session: Boolean(endSession)
  };

  if (Array.isArray(extra.buttons) && extra.buttons.length > 0 && !endSession) {
    responsePayload.buttons = extra.buttons;
  }

  const envelope = {
    version: "1.0",
    response: responsePayload,
    session_state: sessionState
  };

  if (extra.userStateUpdate && typeof extra.userStateUpdate === "object") {
    envelope.user_state_update = extra.userStateUpdate;
  }

  if (extra.applicationState !== undefined) {
    envelope.application_state = fitApplicationState(extra.applicationState);
  }

  return envelope;
}

function isSearchIntent(text, mode = "assistant") {
  const str = String(text ?? "");
  if (mode !== "assistant") {
    return /найди в интернете|поищи в интернете|погугли/i.test(str);
  }
  return SEARCH_INTENT_RE.test(str);
}

function buildSearchQuery(text, history = [], userProfile = {}) {
  let current = String(text ?? "").trim();
  if (!current) return "";

  const safe = safeHistory(history);
  const lastUserTurn = [...safe].reverse().find(item => item.role === "user");
  if (lastUserTurn && (current.length < 40 || FOLLOWUP_QUERY_RE.test(current))) {
    current = `${lastUserTurn.text} ${current}`;
  }

  if (
    userProfile?.city &&
    LOCAL_CITY_INTENT_RE.test(current) &&
    !EXPLICIT_LOCATION_RE.test(current) &&
    !current.toLowerCase().includes(userProfile.city.toLowerCase())
  ) {
    current = `${current} ${userProfile.city}`;
  }

  return truncateSafe(current, 200);
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
  if (!key) return "";

  const cached = getCachedSearchResult(query);
  if (cached !== null) {
    return cached;
  }

  if (timeoutMs < 150) return "";

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

    const formatted = items.length ? items.join("\n") : "";
    if (formatted) {
      setCachedSearchResult(query, formatted);
    }
    return formatted;
  } catch (error) {
    if (isTimeoutError(error)) {
      console.warn("Serper request timed out; continuing without search.");
    } else {
      console.warn("Serper request failed; continuing without search:", error?.message || "unknown error");
    }
    return "";
  }
}

function resolveFallbackModel(primaryModel) {
  const configured = process.env.GEMINI_FALLBACK_MODEL?.trim();
  if (configured === "none" || configured === "false") return "";
  if (configured && /^[A-Za-z0-9._-]+$/.test(configured) && configured !== primaryModel) {
    return configured;
  }
  return primaryModel === DEFAULT_FALLBACK_MODEL ? "gemini-3.6-flash" : DEFAULT_FALLBACK_MODEL;
}

async function callSingleGeminiModel({
  model,
  key,
  systemText,
  contents,
  useGoogleGrounding,
  timeoutMs
}) {
  const requestBody = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
    }
  };

  if (useGoogleGrounding) {
    requestBody.tools = [{ google_search: {} }];
  }

  return fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify(requestBody)
    },
    timeoutMs
  );
}

async function askGemini({
  text,
  history,
  searchContext,
  timeoutMs,
  timezone,
  mode = "assistant",
  userProfile = {},
  useGoogleGrounding = false
}) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const primaryModel = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(primaryModel)) throw new Error("INVALID_MODEL_NAME");

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

  const systemText = buildSystemPrompt({ timezone, mode, userProfile });
  const startedAt = Date.now();
  const timeLeft = () => timeoutMs - (Date.now() - startedAt);

  let { response, data } = await callSingleGeminiModel({
    model: primaryModel,
    key,
    systemText,
    contents,
    useGoogleGrounding,
    timeoutMs: timeLeft()
  });

  // If grounding tool caused a 400 validation error on this key/model, retry cleanly without tools
  if (!response.ok && useGoogleGrounding && response.status === 400 && timeLeft() >= 700) {
    const apiMsg = String(data?.error?.message || "");
    if (!/API_KEY_INVALID|API key not valid|location is not supported|free tier is not available/i.test(apiMsg)) {
      console.warn("Retrying Gemini without google_search grounding tool after HTTP 400");
      ({ response, data } = await callSingleGeminiModel({
        model: primaryModel,
        key,
        systemText,
        contents,
        useGoogleGrounding: false,
        timeoutMs: timeLeft()
      }));
    }
  }

  // Auto-fallback to secondary model on quota (429), model missing (404), or transient 5xx overload
  if (!response.ok && (response.status === 429 || response.status === 404 || response.status >= 500) && timeLeft() >= 700) {
    const fallbackModel = resolveFallbackModel(primaryModel);
    if (fallbackModel) {
      console.warn(`Primary model ${primaryModel} returned HTTP ${response.status}; falling back to ${fallbackModel}`);
      ({ response, data } = await callSingleGeminiModel({
        model: fallbackModel,
        key,
        systemText,
        contents,
        useGoogleGrounding,
        timeoutMs: timeLeft()
      }));
    }
  }

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

function buildDiagnosticsPayload() {
  const primaryModel = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const hasSerper = Boolean(process.env.SERPER_API_KEY?.trim());
  const groundingEnabled = process.env.GEMINI_GROUNDING !== "false";

  return {
    ok: true,
    service: "alice-gemini-serper",
    message: "Webhook is ready. Yandex Dialogs should send POST requests to /api.",
    status: {
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
      primaryModel,
      fallbackModel: resolveFallbackModel(primaryModel) || null,
      searchMode: hasSerper ? "serper" : (groundingEnabled ? "gemini_grounding" : "disabled"),
      asyncCacheMode: isUpstashConfigured() ? "upstash_redis" : "memory",
      skillIdProtected: Boolean(process.env.ALICE_SKILL_ID?.trim()),
      webhookSecretProtected: Boolean(process.env.WEBHOOK_SECRET?.trim())
    }
  };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json(buildDiagnosticsPayload());
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
  const hasScreen = Boolean(body?.meta?.interfaces?.screen);

  const oldHistory = fitHistoryToStateLimit(body?.state?.session?.history);
  const currentMode = safeMode(body?.state?.session?.mode);
  const userProfile = safeUserProfile(body?.state?.user);
  const oldAppState = safeApplicationState(body?.state?.application);
  const hadAppState = Boolean(oldAppState.more || oldAppState.pendingId || oldAppState.pendingQ);

  // 1. Technical health-check ping from Yandex Dialogs
  if (rawUtterance.toLowerCase() === "ping" || rawCommand.toLowerCase() === "ping") {
    return res.status(200).json(aliceResponse("pong", true, []));
  }

  const text = isNewSession && hasCommandField ? rawCommand : (rawUtterance || rawCommand);

  // 2. Bare launch greeting
  if (!text) {
    const greetingName = userProfile.name ? `, ${userProfile.name}` : "";
    const greeting = `Привет${greetingName}! Я могу ответить на вопрос, найти актуальную информацию в интернете или включить режим переводчика, сказочника и викторины. О чём поговорим?`;
    return res.status(200).json(
      aliceResponse(greeting, false, oldHistory, {
        mode: currentMode,
        buttons: buildScreenButtons({ hasScreen, mode: currentMode, isLaunch: true, userProfile }),
        applicationState: hadAppState ? {} : undefined
      })
    );
  }

  const cleanCmd = normalizeCommand(text);

  // 3. Session exit commands
  if (EXIT_COMMAND_RE.test(cleanCmd)) {
    return res.status(200).json(
      aliceResponse("До встречи! Обращайся ещё.", true, [], {
        applicationState: hadAppState ? {} : undefined
      })
    );
  }

  // 4. Help / moderation support
  if (HELP_COMMAND_RE.test(cleanCmd)) {
    const helpText =
      "Я отвечаю на вопросы с помощью нейросети Gemini и ищу свежие новости, погоду или курсы в интернете. " +
      "Доступные команды: «запомни мой город Москва», «режимы» (переводчик, сказочник, викторина), «дальше» для продолжения длинного ответа, «забудь» для смены темы и «хватит» для выхода.";
    return res.status(200).json(
      aliceResponse(helpText, false, oldHistory, {
        mode: currentMode,
        buttons: buildScreenButtons({
          hasScreen,
          mode: currentMode,
          hasMore: Boolean(oldAppState.more),
          hasPending: Boolean(oldAppState.pendingId),
          userProfile
        })
      })
    );
  }

  // 5. Reset conversation history
  if (RESET_COMMAND_RE.test(cleanCmd)) {
    return res.status(200).json(
      aliceResponse("Хорошо, начнём с чистого листа. О чём поговорим?", false, [], {
        mode: "assistant",
        buttons: buildScreenButtons({ hasScreen, mode: "assistant", isLaunch: true, userProfile }),
        applicationState: hadAppState ? {} : undefined
      })
    );
  }

  // 6. Voice mode switching (translator, storyteller, quiz, assistant)
  const modeAction = detectModeCommand(text);
  if (modeAction) {
    const nextMode = modeAction.type === "switch" ? modeAction.mode : currentMode;
    const nextHistory = modeAction.type === "switch" ? [] : oldHistory;
    return res.status(200).json(
      aliceResponse(modeAction.reply, false, nextHistory, {
        mode: nextMode,
        buttons: buildScreenButtons({ hasScreen, mode: nextMode, userProfile }),
        applicationState: hadAppState ? {} : undefined
      })
    );
  }

  // 7. Persistent user profile preferences (city, name, verbosity style)
  const profileAction = detectProfileCommand(text, userProfile, currentMode);
  if (profileAction) {
    const updatedProfile = profileAction.userStateUpdate
      ? safeUserProfile(profileAction.userStateUpdate)
      : userProfile;
    return res.status(200).json(
      aliceResponse(profileAction.reply, false, oldHistory, {
        mode: currentMode,
        userStateUpdate: profileAction.userStateUpdate,
        buttons: buildScreenButtons({ hasScreen, mode: currentMode, userProfile: updatedProfile })
      })
    );
  }

  // 8. Continue reading ("дальше") — either async pending answer or paginated long text
  const isContinueRequest =
    CONTINUE_COMMAND_RE.test(cleanCmd) ||
    ((oldAppState.pendingId || oldAppState.more) && AFFIRMATIVE_CONTINUE_RE.test(cleanCmd));

  let effectiveText = text;

  if (isContinueRequest) {
    // 8a. Async pending background generation
    if (oldAppState.pendingId) {
      const pendingOutcome = await consumePendingResult(
        oldAppState.pendingId,
        Math.max(250, remainingMs() - 450)
      );

      if (pendingOutcome.status === "still_running") {
        return res.status(200).json(
          aliceResponse(
            "Почти готово, додумываю последние детали. Скажите «дальше» ещё через пару секунд.",
            false,
            oldHistory,
            {
              mode: currentMode,
              buttons: buildScreenButtons({ hasScreen, mode: currentMode, hasPending: true, userProfile }),
              applicationState: oldAppState
            }
          )
        );
      }

      if (pendingOutcome.status === "ready") {
        const { question, answer, errorMessage } = pendingOutcome.record;
        if (errorMessage || !answer) {
          return res.status(200).json(
            aliceResponse(errorForUser(new Error(errorMessage || "GEMINI_REQUEST_FAILED")), false, oldHistory, {
              mode: currentMode,
              buttons: buildScreenButtons({ hasScreen, mode: currentMode, userProfile }),
              applicationState: {}
            })
          );
        }

        const split = splitAliceAnswer(answer);
        const origQuestion = question || oldAppState.pendingQ || text;
        const updatedHistory = fitHistoryToStateLimit(
          [
            ...oldHistory,
            { role: "user", text: truncateSafe(origQuestion, MAX_HISTORY_MESSAGE_CHARS) },
            { role: "model", text: truncateSafe(stripVoiceUnfriendlyFormatting(answer), MAX_HISTORY_MESSAGE_CHARS) }
          ],
          currentMode
        );
        const nextAppState = split.remainder ? { more: split.remainder } : {};
        return res.status(200).json(
          aliceResponse(split.text, false, updatedHistory, {
            mode: currentMode,
            buttons: buildScreenButtons({
              hasScreen,
              mode: currentMode,
              hasMore: Boolean(split.remainder),
              userProfile
            }),
            applicationState: nextAppState
          })
        );
      }

      // If pending cache missed (e.g. cold restart without Redis), seamlessly re-run saved question
      if (oldAppState.pendingQ) {
        effectiveText = oldAppState.pendingQ;
      }
    } else if (oldAppState.more) {
      // 8b. Paginated remainder of a long answer
      const split = splitAliceAnswer(oldAppState.more);
      const nextAppState = split.remainder ? { more: split.remainder } : {};
      return res.status(200).json(
        aliceResponse(split.text, false, oldHistory, {
          mode: currentMode,
          buttons: buildScreenButtons({
            hasScreen,
            mode: currentMode,
            hasMore: Boolean(split.remainder),
            userProfile
          }),
          applicationState: nextAppState
        })
      );
    } else if (oldHistory.length > 0) {
      effectiveText = "Продолжи предыдущую мысль и расскажи об этом чуть подробнее.";
    }
  } else if (ELABORATE_COMMAND_RE.test(cleanCmd) && oldHistory.length > 0) {
    effectiveText = "Расскажи об этом подробнее, с интересными деталями.";
  }

  // 9. Main search + Gemini pipeline (with soft deadline + background waitUntil support)
  try {
    let searchContext = "";
    const needsFreshness = isSearchIntent(effectiveText, currentMode);
    const hasSerperKey = Boolean(process.env.SERPER_API_KEY?.trim());

    if (needsFreshness && hasSerperKey) {
      const searchBudgetMs = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(0, remainingMs() - MIN_GEMINI_BUDGET_AFTER_SEARCH_MS)
      );
      const searchQuery = buildSearchQuery(effectiveText, oldHistory, userProfile);
      searchContext = await searchWeb(searchQuery, searchBudgetMs);
    }

    const useGoogleGrounding =
      needsFreshness && !hasSerperKey && process.env.GEMINI_GROUNDING !== "false";

    const asyncPendingEnabled = process.env.ASYNC_PENDING !== "false";
    const configuredSoftDeadline = Number(process.env.SOFT_DEADLINE_MS) || 0;
    const softDeadlineMs = configuredSoftDeadline > 0
      ? configuredSoftDeadline
      : Math.max(250, Math.min(GEMINI_TIMEOUT_MS, remainingMs()));

    const fullGeminiTimeoutMs = asyncPendingEnabled
      ? Math.max(softDeadlineMs, BACKGROUND_GEMINI_TIMEOUT_MS)
      : softDeadlineMs;

    const geminiPromise = askGemini({
      text: effectiveText,
      history: oldHistory,
      searchContext,
      timeoutMs: fullGeminiTimeoutMs,
      timezone: body?.meta?.timezone,
      mode: currentMode,
      userProfile,
      useGoogleGrounding
    });

    let raceWinner;
    let softTimer;
    if (asyncPendingEnabled) {
      const softTimeoutPromise = new Promise(resolve => {
        softTimer = setTimeout(() => resolve({ timedOutSoft: true }), softDeadlineMs);
      });
      try {
        raceWinner = await Promise.race([
          geminiPromise.then(answer => ({ timedOutSoft: false, answer })),
          softTimeoutPromise
        ]);
      } finally {
        clearTimeout(softTimer);
      }
    } else {
      const answer = await geminiPromise;
      raceWinner = { timedOutSoft: false, answer };
    }

    if (raceWinner.timedOutSoft) {
      const pendingId = generatePendingId();
      registerBackgroundPendingTask(pendingId, effectiveText, geminiPromise);

      return res.status(200).json(
        aliceResponse(
          "Вопрос непростой, мне нужно ещё пару секунд. Скажите «дальше», чтобы услышать готовый ответ.",
          false,
          oldHistory,
          {
            mode: currentMode,
            buttons: buildScreenButtons({ hasScreen, mode: currentMode, hasPending: true, userProfile }),
            applicationState: {
              pendingId,
              pendingQ: truncateSafe(effectiveText, 120)
            }
          }
        )
      );
    }

    const answer = raceWinner.answer;
    const split = splitAliceAnswer(answer);
    const history = fitHistoryToStateLimit(
      [
        ...oldHistory,
        { role: "user", text: truncateSafe(effectiveText, MAX_HISTORY_MESSAGE_CHARS) },
        { role: "model", text: truncateSafe(stripVoiceUnfriendlyFormatting(answer), MAX_HISTORY_MESSAGE_CHARS) }
      ],
      currentMode
    );

    const nextAppState = split.remainder
      ? { more: split.remainder }
      : (hadAppState ? {} : undefined);

    return res.status(200).json(
      aliceResponse(split.text, false, history, {
        mode: currentMode,
        buttons: buildScreenButtons({
          hasScreen,
          mode: currentMode,
          hasMore: Boolean(split.remainder),
          userProfile
        }),
        applicationState: nextAppState
      })
    );
  } catch (error) {
    const normalizedError = isTimeoutError(error) ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Alice webhook returned a fallback response:", normalizedError?.message || "unknown error");
    return res.status(200).json(
      aliceResponse(errorForUser(normalizedError), false, oldHistory, {
        mode: currentMode,
        buttons: buildScreenButtons({ hasScreen, mode: currentMode, userProfile }),
        applicationState: hadAppState ? {} : undefined
      })
    );
  }
}

export {
  MAX_ALICE_TEXT,
  aliceResponse,
  buildAliceTts,
  buildScreenButtons,
  buildSearchQuery,
  clearCachesForTests,
  detectModeCommand,
  detectProfileCommand,
  fitAliceText,
  fitHistoryToStateLimit,
  fitSessionState,
  isSearchIntent,
  isTimeoutError,
  safeHistory,
  splitAliceAnswer
};
