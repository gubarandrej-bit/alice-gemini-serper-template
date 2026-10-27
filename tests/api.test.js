import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handler, {
  ALICE_SOUNDS,
  aliceResponse,
  buildAliceTts,
  buildScreenButtons,
  buildSearchQuery,
  clearCachesForTests,
  clearRateLimitForTests,
  fitAliceText,
  fitHistoryToStateLimit,
  isSearchIntent,
  isTimeoutError,
  safeHistory,
  splitAliceAnswer
} from "../api/index.js";

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(value) {
      this.payload = value;
      return value;
    }
  };
}

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "SERPER_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FALLBACK_MODEL",
  "GEMINI_GROUNDING",
  "ALICE_SKILL_ID",
  "WEBHOOK_SECRET",
  "RATE_LIMIT_PER_MINUTE",
  "ASYNC_PENDING",
  "SOFT_DEADLINE_MS",
  "GEMINI_HEDGE_DELAY_MS",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN"
];

async function withMockEnvAndFetch(envOverrides, mockFetch, fn) {
  clearCachesForTests();
  clearRateLimitForTests();
  const originalFetch = globalThis.fetch;
  const savedEnv = {};

  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(envOverrides, key)) {
      if (envOverrides[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envOverrides[key];
      }
    } else {
      delete process.env[key];
    }
  }

  if (mockFetch) {
    globalThis.fetch = mockFetch;
  }

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    clearCachesForTests();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  }
}

test("Alice response uses required envelope with text, phonetic tts, and compact session_state", () => {
  const result = aliceResponse("Привет! Температура +15°C.", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет! Температура +15°C.");
  assert.match(result.response.tts, /плюс 15 градусов/);
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state, { history: [{ role: "user", text: "тест" }] });
});

test("session_state strictly stays within Yandex Alice 1 KB (1024 bytes) UTF-8 limit even with non-default mode", () => {
  const cyrillicChunk = "Очень длинная русская реплика — с тире и кавычками «проверка»… ".repeat(6);
  const hugeHistory = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "model",
    text: `${i}: ${cyrillicChunk} 😀`
  }));

  const response = aliceResponse("Ответ", false, hugeHistory, { mode: "storyteller" });
  const byteLength = Buffer.byteLength(JSON.stringify(response.session_state), "utf8");

  assert.ok(byteLength <= 1024, `Expected <= 1024 bytes, got ${byteLength}`);
  assert.equal(response.session_state.mode, "storyteller");
  assert.ok(response.session_state.history.length > 0);
  assert.equal(response.session_state.history[0].role, "user");
});

test("history filters malformed messages, enforces user-first alternation, and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: String(i)
  }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });

  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");

  const messy = [
    { role: "model", text: "orphan" },
    { role: "user", text: "first" },
    { role: "user", text: "second" },
    { role: "model", text: "reply" }
  ];
  assert.deepEqual(fitHistoryToStateLimit(messy), [
    { role: "user", text: "second" },
    { role: "model", text: "reply" }
  ]);
});

test("buildAliceTts expands degrees, currencies, percentages, and tech acronyms within 1024 chars", () => {
  const tts = buildAliceTts("Курс $95, ставка 16%, на улице -7 °C. ИИ от ChatGPT и Gemini через Wi-Fi.");
  assert.match(tts, /95 долларов/);
  assert.match(tts, /16 процентов/);
  assert.match(tts, /минус 7 градусов/);
  assert.match(tts, /искусственный интеллект/);
  assert.match(tts, /чат джи пи ти/);
  assert.match(tts, /Джемини/);
  assert.match(tts, /вай-фай/);
  assert.ok(tts.length <= 1024);
});

test("fitAliceText strips Markdown/URLs and splitAliceAnswer paginates >1024 char text for 'дальше'", () => {
  const formatted = "Вот **главный** ответ со [ссылкой](https://example.com/test) и адресом https://foo.bar/baz.";
  assert.equal(fitAliceText(formatted), "Вот главный ответ со ссылкой и адресом.");

  const veryLong = ("Первое подробное предложение рассказа о космосе и далёких галактиках. ").repeat(25);
  const split = splitAliceAnswer(veryLong);
  assert.ok(split.text.length <= 1024);
  assert.match(split.text, /Продолжить\?$/);
  assert.ok(split.remainder.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify({ more: split.remainder }), "utf8") <= 1024);
});

test("paginated long answer can be read across turns using 'дальше'", async () => {
  const longAnswer = ("Интересный исторический факт об экспедиции и научных открытиях. ").repeat(24);
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "test-key" },
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: longAnswer }] } }] };
      }
    }),
    async () => {
      // Turn 1: produces paginated chunk + application_state.more
      const firstRes = createMockRes();
      await handler({ method: "POST", body: { request: { command: "расскажи длинную историю" } } }, firstRes);
      assert.match(firstRes.payload.response.text, /Продолжить\?$/);
      assert.ok(firstRes.payload.application_state?.more);
      assert.ok(Buffer.byteLength(JSON.stringify(firstRes.payload.application_state), "utf8") <= 1024);

      // Turn 2: user says "дальше" -> reads remainder locally without calling Gemini
      let secondFetchCalled = false;
      globalThis.fetch = async () => {
        secondFetchCalled = true;
        throw new Error("Should not call fetch when reading saved remainder");
      };

      const secondRes = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            request: { command: "дальше" },
            state: {
              session: firstRes.payload.session_state,
              application: firstRes.payload.application_state
            }
          }
        },
        secondRes
      );
      assert.equal(secondFetchCalled, false);
      assert.match(secondRes.payload.response.text, /исторический факт/);
      assert.deepEqual(secondRes.payload.application_state, {});
    }
  );
});

test("persistent user_state_update remembers city, name, and style, and injects default city into weather search", async () => {
  // Save city
  const cityRes = createMockRes();
  await handler(
    { method: "POST", body: { request: { command: "запомни мой город новосибирск" } } },
    cityRes
  );
  assert.equal(cityRes.payload.user_state_update?.city, "Новосибирск");
  assert.match(cityRes.payload.response.text, /Новосибирск/);

  // Save name
  const nameRes = createMockRes();
  await handler(
    {
      method: "POST",
      body: {
        request: { command: "меня зовут андрей" },
        state: { user: cityRes.payload.user_state_update }
      }
    },
    nameRes
  );
  assert.equal(nameRes.payload.user_state_update?.city, "Новосибирск");
  assert.equal(nameRes.payload.user_state_update?.name, "Андрей");

  // Weather query automatically appends saved city when no location was specified, but respects explicit cities
  const query = buildSearchQuery("Какая сегодня погода?", [], nameRes.payload.user_state_update);
  assert.match(query, /Новосибирск/);

  const explicitCityQuery = buildSearchQuery("Какая погода сегодня в Сочи?", [], nameRes.payload.user_state_update);
  assert.doesNotMatch(explicitCityQuery, /Новосибирск/);

  // Inspect profile command
  const infoRes = createMockRes();
  await handler(
    {
      method: "POST",
      body: {
        request: { command: "что ты обо мне помнишь" },
        state: { user: nameRes.payload.user_state_update }
      }
    },
    infoRes
  );
  assert.match(infoRes.payload.response.text, /Андрей/);
  assert.match(infoRes.payload.response.text, /Новосибирск/);
});

test("voice modes switch cleanly between translator, storyteller, quiz, and assistant", async () => {
  const modeRes = createMockRes();
  await handler({ method: "POST", body: { request: { command: "режим переводчика" } } }, modeRes);
  assert.equal(modeRes.payload.session_state.mode, "translator");
  assert.match(modeRes.payload.response.text, /режим переводчика/i);

  // In translator mode, words like "сегодня" do not trigger web search unnecessarily
  assert.equal(isSearchIntent("Сегодня отличная погода", "translator"), false);
  assert.equal(isSearchIntent("Сегодня отличная погода", "assistant"), true);

  const backRes = createMockRes();
  await handler(
    {
      method: "POST",
      body: {
        request: { command: "обычный режим" },
        state: { session: modeRes.payload.session_state }
      }
    },
    backRes
  );
  assert.equal(backRes.payload.session_state.mode, undefined);
});

test("screen devices receive contextual buttons while speaker-only devices do not", async () => {
  const withScreen = createMockRes();
  await handler(
    {
      method: "POST",
      body: {
        meta: { interfaces: { screen: {} } },
        session: { new: true },
        request: { command: "" },
        state: { user: { city: "Казань" } }
      }
    },
    withScreen
  );
  assert.ok(Array.isArray(withScreen.payload.response.buttons));
  assert.ok(withScreen.payload.response.buttons.some(b => b.title.includes("Казань")));

  const noScreen = createMockRes();
  await handler(
    {
      method: "POST",
      body: {
        meta: { interfaces: {} },
        session: { new: true },
        request: { command: "" }
      }
    },
    noScreen
  );
  assert.equal(noScreen.payload.response.buttons, undefined);
  assert.equal(buildScreenButtons({ hasScreen: false }), undefined);
});

test("GET diagnostics endpoint and public/index.html status page are valid and leak no secrets", async () => {
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "super-secret-key" },
    null,
    async () => {
      const getRes = createMockRes();
      await handler({ method: "GET" }, getRes);
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.payload.ok, true);
      assert.equal(getRes.payload.service, "alice-gemini-serper");
      assert.equal(getRes.payload.status.geminiConfigured, true);
      assert.equal(getRes.payload.status.searchMode, "gemini_grounding");
      assert.doesNotMatch(JSON.stringify(getRes.payload), /super-secret-key/);
    }
  );

  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /Webhook URL для Яндекс Диалогов/);
});

test("voice launch on real Yandex Station greets instantly without calling Gemini, while inline launch question strips activation prefix", async () => {
  let fetchCalls = 0;
  let capturedPrompt = "";
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "test-key" },
    async (_url, options) => {
      fetchCalls += 1;
      capturedPrompt = JSON.parse(options.body).contents[0].parts[0].text;
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "Восемь планет." }] } }] };
        }
      };
    },
    async () => {
      // Bare launch
      const bareRes = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            session: { new: true },
            request: { command: "", original_utterance: "алиса запусти навык мой помощник" }
          }
        },
        bareRes
      );
      assert.equal(fetchCalls, 0);
      assert.match(bareRes.payload.response.text, /Привет/);

      // Inline question launch
      const inlineRes = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            session: { new: true },
            request: {
              command: "сколько планет в солнечной системе",
              original_utterance: "алиса спроси у навыка мой помощник сколько планет в солнечной системе"
            }
          }
        },
        inlineRes
      );
      assert.equal(fetchCalls, 1);
      assert.equal(capturedPrompt, "сколько планет в солнечной системе");
      assert.equal(inlineRes.payload.response.text, "Восемь планет.");
    }
  );
});

test("Yandex technical ping probe and built-in help/reset/exit commands work locally", async () => {
  let fetchCalled = false;
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "test-key", SERPER_API_KEY: "serper-key" },
    async () => {
      fetchCalled = true;
      throw new Error("Should not call external API");
    },
    async () => {
      const pingRes = createMockRes();
      await handler(
        { method: "POST", body: { request: { command: "", original_utterance: "ping" }, session: { new: true } } },
        pingRes
      );
      assert.equal(pingRes.payload.response.text, "pong");
      assert.equal(pingRes.payload.response.end_session, true);

      const exitRes = createMockRes();
      await handler({ method: "POST", body: { request: { command: "хватит" } } }, exitRes);
      assert.equal(exitRes.payload.response.end_session, true);
      assert.equal(fetchCalled, false);
    }
  );
});

test("Serper search results are cached in-memory and Gemini strips thought parts", async () => {
  let serperCalls = 0;
  let geminiCalls = 0;

  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "gemini-test", SERPER_API_KEY: "serper-test" },
    async (url) => {
      if (String(url).includes("serper.dev")) {
        serperCalls += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return { answerBox: { answer: "+14 °C, облачно" } };
          }
        };
      }
      geminiCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    { thought: true, text: "Hidden internal thought." },
                    { text: "Сейчас **+14°C** и облачно." }
                  ]
                }
              }
            ]
          };
        }
      };
    },
    async () => {
      const reqBody = { request: { command: "какая погода сегодня в москве" } };
      const res1 = createMockRes();
      await handler({ method: "POST", body: reqBody }, res1);
      const res2 = createMockRes();
      await handler({ method: "POST", body: reqBody }, res2);

      assert.equal(serperCalls, 1, "Second identical search should hit in-memory TTL cache");
      assert.equal(geminiCalls, 2);
      assert.equal(res1.payload.response.text, "Сейчас +14°C и облачно.");
      assert.match(res1.payload.response.tts, /плюс 14 градусов/);
      assert.doesNotMatch(res1.payload.response.text, /Hidden internal thought/);
    }
  );
});

test("Gemini auto-fallbacks to secondary model on HTTP 429 and enables google_search grounding when SERPER_API_KEY is absent", async () => {
  const calledUrls = [];
  const calledBodies = [];

  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "gemini-test", GEMINI_MODEL: "gemini-3.5-flash-lite", GEMINI_FALLBACK_MODEL: "gemini-3.1-flash-lite" },
    async (url, options) => {
      calledUrls.push(String(url));
      calledBodies.push(JSON.parse(options.body));

      // Primary model hits 429 rate limit
      if (String(url).includes("gemini-3.5-flash-lite") && calledUrls.length === 1) {
        return {
          ok: false,
          status: 429,
          async json() {
            return { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } };
          }
        };
      }
      // Retry without grounding or fallback model succeeds
      if (String(url).includes("gemini-3.5-flash-lite")) {
        return {
          ok: false,
          status: 429,
          async json() {
            return { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "Ответ от резервной модели." }] } }] };
        }
      };
    },
    async () => {
      const res = createMockRes();
      await handler({ method: "POST", body: { request: { command: "какие свежие новости сегодня" } } }, res);

      assert.deepEqual(calledBodies[0].tools, [{ google_search: {} }], "Should attach google_search grounding when SERPER_API_KEY is omitted");
      assert.ok(calledUrls.some(u => u.includes("gemini-3.1-flash-lite")), "Should fall back to secondary model on 429");
      assert.equal(res.payload.response.text, "Ответ от резервной модели.");
    }
  );
});

test("background waitUntil completion (>4.5s simulation) defers gracefully and delivers full answer on 'дальше'", async () => {
  let waitedPromises = [];
  const vercelCtxSymbol = Symbol.for("@vercel/request-context");
  const prevCtx = globalThis[vercelCtxSymbol];
  globalThis[vercelCtxSymbol] = {
    get: () => ({
      waitUntil(p) {
        waitedPromises.push(p);
      }
    })
  };

  try {
    await withMockEnvAndFetch(
      { GEMINI_API_KEY: "gemini-test", SOFT_DEADLINE_MS: "50" },
      async () => {
        await new Promise(resolve => setTimeout(resolve, 130));
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              candidates: [{ content: { parts: [{ text: "Глубокий ответ после размышления модели." }] } }]
            };
          }
        };
      },
      async () => {
        // Turn 1: exceeds soft deadline (50ms) while Gemini finishes at 130ms in background
        const slowRes = createMockRes();
        await handler(
          {
            method: "POST",
            body: {
              meta: { interfaces: { screen: {} } },
              request: { command: "реши сложную олимпиадную задачу" }
            }
          },
          slowRes
        );

        assert.match(slowRes.payload.response.text, /Скажите «дальше»/);
        assert.ok(slowRes.payload.application_state?.pendingId);
        assert.equal(waitedPromises.length, 1, "Should register background task with Vercel waitUntil");

        // Wait for background task to finish
        await Promise.all(waitedPromises);

        // Turn 2: user says "дальше" and gets the finished answer immediately
        const followupRes = createMockRes();
        await handler(
          {
            method: "POST",
            body: {
              request: { command: "дальше" },
              state: {
                session: slowRes.payload.session_state,
                application: slowRes.payload.application_state
              }
            }
          },
          followupRes
        );

        assert.equal(followupRes.payload.response.text, "Глубокий ответ после размышления модели.");
        assert.deepEqual(followupRes.payload.application_state, {});
        assert.equal(followupRes.payload.session_state.history.length, 2);
      }
    );
  } finally {
    if (prevCtx === undefined) {
      delete globalThis[vercelCtxSymbol];
    } else {
      globalThis[vercelCtxSymbol] = prevCtx;
    }
  }
});

test("AbortController DOMException error still maps to friendly timeout message and optional security blocks unauthorized callers", async () => {
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "test-key", ASYNC_PENDING: "false" },
    async () => {
      const abortErr = new DOMException("This operation was aborted", "AbortError");
      assert.equal(isTimeoutError(abortErr), true);
      throw abortErr;
    },
    async () => {
      const res = createMockRes();
      await handler({ method: "POST", body: { request: { command: "тест таймаута" } } }, res);
      assert.match(res.payload.response.text, /Не успела подготовить ответ/);
    }
  );

  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "gemini-test", ALICE_SKILL_ID: "skill-123", WEBHOOK_SECRET: "topsecret" },
    null,
    async () => {
      const deniedRes = createMockRes();
      await handler(
        { method: "POST", url: "/api?secret=wrong", body: { session: { skill_id: "skill-123" }, request: { command: "" } } },
        deniedRes
      );
      assert.equal(deniedRes.statusCode, 403);
    }
  );
});

test("grounding citation brackets are stripped and official Alice sound effects play in storyteller/quiz modes", async () => {
  assert.equal(
    fitAliceText("Сегодня солнечно [1] и до +20°C [2, 3]."),
    "Сегодня солнечно и до +20°C."
  );

  // Storyteller mode switch adds harp sound in TTS
  const storySwitch = createMockRes();
  await handler({ method: "POST", body: { request: { command: "детский режим" } } }, storySwitch);
  assert.equal(storySwitch.payload.session_state.mode, "storyteller");
  assert.ok(storySwitch.payload.response.tts.startsWith(ALICE_SOUNDS.harp));

  // English coach and brainstorm modes
  const coachSwitch = createMockRes();
  await handler({ method: "POST", body: { request: { command: "практика английского" } } }, coachSwitch);
  assert.equal(coachSwitch.payload.session_state.mode, "coach");

  const brainstormSwitch = createMockRes();
  await handler({ method: "POST", body: { request: { command: "режим идей" } } }, brainstormSwitch);
  assert.equal(brainstormSwitch.payload.session_state.mode, "brainstorm");

  // Correct answer in quiz mode plays fanfare sound in TTS
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "gemini-test" },
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: "Правильно! Юпитер — крупнейшая планета. Следующий вопрос: какая планета ближе всех к Солнцу?" }] } }] };
      }
    }),
    async () => {
      const quizRes = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            request: { command: "юпитер" },
            state: { session: { mode: "quiz", history: [{ role: "user", text: "космос" }, { role: "model", text: "Какая планета самая большая?" }] } }
          }
        },
        quizRes
      );
      assert.ok(quizRes.payload.response.tts.startsWith(ALICE_SOUNDS.gameWin));
    }
  );
});

test("instant local commands ('повтори', 'который час', 'какое сегодня число') respond without external API calls", async () => {
  let fetchCalled = false;
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "gemini-test" },
    async () => {
      fetchCalled = true;
      throw new Error("External API must not be called for local commands");
    },
    async () => {
      const repeatRes = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            request: { command: "повтори" },
            state: {
              session: {
                history: [
                  { role: "user", text: "кто открыл пенициллин" },
                  { role: "model", text: "Пенициллин открыл Александр Флеминг." }
                ]
              }
            }
          }
        },
        repeatRes
      );
      assert.match(repeatRes.payload.response.text, /Александр Флеминг/);

      const timeRes = createMockRes();
      await handler(
        { method: "POST", body: { meta: { timezone: "Asia/Novosibirsk" }, request: { command: "который час" } } },
        timeRes
      );
      assert.match(timeRes.payload.response.text, /Сейчас \d{2}:\d{2}/);

      const dateRes = createMockRes();
      await handler(
        { method: "POST", body: { meta: { timezone: "Asia/Novosibirsk" }, request: { command: "какое сегодня число" } } },
        dateRes
      );
      assert.match(dateRes.payload.response.text, /Сегодня/);
      assert.equal(fetchCalled, false);
    }
  );
});

test("per-user sliding-window rate limiter protects Gemini quota while keeping local commands responsive", async () => {
  let geminiCalls = 0;
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "gemini-test", RATE_LIMIT_PER_MINUTE: "2" },
    async () => {
      geminiCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "Короткий ответ." }] } }] };
        }
      };
    },
    async () => {
      const makeReq = text => ({
        method: "POST",
        body: { session: { user: { user_id: "user-42" } }, request: { command: text } }
      });

      const r1 = createMockRes();
      await handler(makeReq("первый вопрос"), r1);
      const r2 = createMockRes();
      await handler(makeReq("второй вопрос"), r2);
      const r3 = createMockRes();
      await handler(makeReq("третий вопрос подряд"), r3);

      assert.equal(geminiCalls, 2);
      assert.match(r3.payload.response.text, /Слишком много запросов/);

      // Local exit command still works even when rate-limited
      const exitRes = createMockRes();
      await handler(makeReq("хватит"), exitRes);
      assert.equal(exitRes.payload.response.end_session, true);
    }
  );
});

test("staggered hedged race wins with fast backup model when primary model stalls and aborts slow slot", async () => {
  let primaryAborted = false;

  await withMockEnvAndFetch(
    {
      GEMINI_API_KEY: "gemini-test",
      GEMINI_MODEL: "gemini-3.5-flash-lite",
      GEMINI_FALLBACK_MODEL: "gemini-3.1-flash-lite",
      GEMINI_HEDGE_DELAY_MS: "50"
    },
    async (url, options) => {
      if (String(url).includes("gemini-3.5-flash-lite")) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 400);
          options.signal?.addEventListener("abort", () => {
            primaryAborted = true;
            clearTimeout(t);
            const abortErr = new Error("AbortError");
            abortErr.name = "AbortError";
            reject(abortErr);
          });
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { candidates: [{ content: { parts: [{ text: "Медленный ответ." }] } }] };
          }
        };
      }

      await new Promise(resolve => setTimeout(resolve, 20));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            usageMetadata: { thoughtsTokenCount: 0, candidatesTokenCount: 12 },
            candidates: [{ content: { parts: [{ text: "Быстрый ответ от дублёра!" }] } }]
          };
        }
      };
    },
    async () => {
      const start = Date.now();
      const res = createMockRes();
      await handler({ method: "POST", body: { request: { command: "назови столицу франции" } } }, res);
      const elapsed = Date.now() - start;

      assert.equal(res.payload.response.text, "Быстрый ответ от дублёра!");
      assert.ok(elapsed < 250, `Hedged backup should win well before 400ms stall, took ${elapsed}ms`);
      assert.equal(primaryAborted, true, "Stalled primary request should be aborted once hedged winner finishes");

      const diagRes = createMockRes();
      await handler({ method: "GET" }, diagRes);
      assert.equal(diagRes.payload.status.lastCallMetrics.deferredToBackground, false);
      assert.ok(
        diagRes.payload.status.lastCallMetrics.geminiAttempts.some(
          a => a.model === "gemini-3.1-flash-lite" && a.winner === true
        )
      );
    }
  );
});

test("model cooldown circuit breaker skips 429 model on subsequent requests and enforces MINIMAL thinkingLevel", async () => {
  const calledModels = [];
  const thinkingConfigs = [];

  await withMockEnvAndFetch(
    {
      GEMINI_API_KEY: "gemini-test",
      GEMINI_MODEL: "gemini-3.5-flash-lite",
      GEMINI_FALLBACK_MODEL: "gemini-3.1-flash-lite"
    },
    async (url, options) => {
      const body = JSON.parse(options.body);
      thinkingConfigs.push(body?.generationConfig?.thinkingConfig);
      if (String(url).includes("gemini-3.5-flash-lite")) {
        calledModels.push("gemini-3.5-flash-lite");
        return {
          ok: false,
          status: 429,
          async json() {
            return { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } };
          }
        };
      }
      calledModels.push("gemini-3.1-flash-lite");
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "Мгновенный ответ без 429." }] } }] };
        }
      };
    },
    async () => {
      // Request 1: hits 429 on 3.5-flash-lite, puts it on cooldown, succeeds on 3.1-flash-lite
      const r1 = createMockRes();
      await handler({ method: "POST", body: { request: { command: "сколько планет в солнечной системе" } } }, r1);
      assert.equal(r1.payload.response.text, "Мгновенный ответ без 429.");
      assert.deepEqual(calledModels, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);

      // Request 2: immediately skips cooled-down 3.5-flash-lite and goes straight to 3.1-flash-lite!
      const r2 = createMockRes();
      await handler({ method: "POST", body: { request: { command: "какая самая большая планета" } } }, r2);
      assert.equal(r2.payload.response.text, "Мгновенный ответ без 429.");
      assert.deepEqual(calledModels, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite"]);
      assert.deepEqual(thinkingConfigs[0], { thinkingLevel: "MINIMAL" });
    }
  );
});

