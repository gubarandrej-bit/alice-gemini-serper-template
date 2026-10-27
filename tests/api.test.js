import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  aliceResponse,
  buildSearchQuery,
  fitAliceText,
  fitHistoryToStateLimit,
  isSearchIntent,
  isTimeoutError,
  safeHistory
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

async function withMockEnvAndFetch(envOverrides, mockFetch, fn) {
  const originalFetch = globalThis.fetch;
  const savedEnv = {};
  const keys = ["GEMINI_API_KEY", "SERPER_API_KEY", "GEMINI_MODEL", "ALICE_SKILL_ID", "WEBHOOK_SECRET"];

  for (const key of keys) {
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
    for (const key of keys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  }
}

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("session_state strictly stays within Yandex Alice 1 KB (1024 bytes) UTF-8 limit", () => {
  const cyrillicChunk = "Очень длинная русская реплика с подробным объяснением для проверки байтового лимита состояния сессии в Яндекс Диалогах. ".repeat(6);
  const hugeHistory = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "model",
    text: `${i}: ${cyrillicChunk} 😀`
  }));

  const response = aliceResponse("Ответ", false, hugeHistory);
  const stateJson = JSON.stringify(response.session_state);
  const byteLength = Buffer.byteLength(stateJson, "utf8");

  assert.ok(byteLength <= 1024, `Expected <= 1024 bytes, got ${byteLength}`);
  assert.ok(response.session_state.history.length > 0, "Should still retain recent turns");
  assert.equal(response.session_state.history[0].role, "user", "History must start with a user turn");
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

  // Leading orphan model turn and duplicate consecutive user turns are cleaned up
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

test("fitAliceText strips Markdown/URLs and cuts long responses at a sentence boundary", () => {
  const formatted = "Вот **главный** ответ со [ссылкой](https://example.com/test) и адресом https://foo.bar/baz.";
  assert.equal(fitAliceText(formatted), "Вот главный ответ со ссылкой и адресом.");

  const longValue = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(longValue.length <= 1024);
  assert.ok(longValue.endsWith("."));
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("А какая температура завтра?"), true);
  assert.equal(isSearchIntent("Сколько стоит доллар?"), true);
  assert.equal(isSearchIntent("Кто выиграл Лигу чемпионов в 2026 году?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку про кота"), false);
});

test("buildSearchQuery enriches short follow-up questions with previous user turn", () => {
  const history = [
    { role: "user", text: "Какая погода сегодня в Новосибирске" },
    { role: "model", text: "Сегодня в Новосибирске плюс пять." }
  ];
  const query = buildSearchQuery("А завтра?", history);
  assert.match(query, /Новосибирске/);
  assert.match(query, /А завтра\?/);
});

test("GET health check returns an ok response and unsupported methods return 405", async () => {
  const getRes = createMockRes();
  await handler({ method: "GET" }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.payload.ok, true);
  assert.equal(getRes.payload.service, "alice-gemini-serper");

  const putRes = createMockRes();
  await handler({ method: "PUT" }, putRes);
  assert.equal(putRes.statusCode, 405);
  assert.equal(putRes.headers.Allow, "GET, POST");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const res = createMockRes();
  await handler(
    { method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.version, "1.0");
  assert.match(res.payload.response.text, /Привет/);
  assert.equal(res.payload.response.end_session, false);
});

test("voice launch on real Yandex Station (session.new=true, command='', original_utterance='алиса запусти навык...') greets instantly without calling Gemini", async () => {
  let fetchCalled = false;
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "test-key" },
    async () => {
      fetchCalled = true;
      throw new Error("Gemini should not be called on bare skill activation");
    },
    async () => {
      const res = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            session: { new: true },
            request: {
              command: "",
              original_utterance: "алиса запусти навык умный помощник",
              type: "SimpleUtterance"
            },
            state: { session: { history: [] } }
          }
        },
        res
      );
      assert.equal(res.statusCode, 200);
      assert.match(res.payload.response.text, /Привет/);
      assert.equal(fetchCalled, false);
    }
  );
});

test("voice launch WITH inline question sends stripped command (without activation prefix) to Gemini", async () => {
  let capturedPrompt = "";
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "test-key" },
    async (_url, options) => {
      const reqBody = JSON.parse(options.body);
      capturedPrompt = reqBody.contents[0].parts[0].text;
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "Восемь планет." }] } }] };
        }
      };
    },
    async () => {
      const res = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            session: { new: true },
            request: {
              command: "сколько планет в солнечной системе",
              original_utterance: "алиса спроси у навыка умный помощник сколько планет в солнечной системе"
            }
          }
        },
        res
      );
      assert.equal(capturedPrompt, "сколько планет в солнечной системе");
      assert.equal(res.payload.response.text, "Восемь планет.");
    }
  );
});

test("Gemini HTTP 400 API_KEY_INVALID and FAILED_PRECONDITION return clear diagnostic messages", async () => {
  // Invalid key reported via HTTP 400
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "bad-key" },
    async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } };
      }
    }),
    async () => {
      const res = createMockRes();
      await handler({ method: "POST", body: { request: { command: "привет мир" } } }, res);
      assert.match(res.payload.response.text, /API-ключ/);
    }
  );

  // Region / free tier restriction reported via HTTP 400 FAILED_PRECONDITION
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "valid-key" },
    async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: { status: "FAILED_PRECONDITION", message: "User location is not supported for the API use." } };
      }
    }),
    async () => {
      const res = createMockRes();
      await handler({ method: "POST", body: { request: { command: "привет мир" } } }, res);
      assert.match(res.payload.response.text, /регион/i);
    }
  );
});

test("Yandex technical ping probe returns pong immediately without calling external APIs", async () => {
  let fetchCalled = false;
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "test-key", SERPER_API_KEY: "serper-key" },
    async () => {
      fetchCalled = true;
      throw new Error("External API should not be called on ping");
    },
    async () => {
      const res = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            request: { command: "", original_utterance: "ping", type: "SimpleUtterance" },
            session: { new: true }
          }
        },
        res
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.response.text, "pong");
      assert.equal(res.payload.response.end_session, true);
      assert.equal(fetchCalled, false);
    }
  );
});

test("built-in voice commands handle help, context reset, and session exit locally", async () => {
  const existingHistory = [
    { role: "user", text: "Привет" },
    { role: "model", text: "Здравствуйте!" }
  ];

  // Help
  const helpRes = createMockRes();
  await handler(
    { method: "POST", body: { request: { command: "что ты умеешь" }, state: { session: { history: existingHistory } } } },
    helpRes
  );
  assert.equal(helpRes.payload.response.end_session, false);
  assert.match(helpRes.payload.response.text, /Gemini/i);
  assert.equal(helpRes.payload.session_state.history.length, 2);

  // Reset history
  const resetRes = createMockRes();
  await handler(
    { method: "POST", body: { request: { command: "забудь" }, state: { session: { history: existingHistory } } } },
    resetRes
  );
  assert.equal(resetRes.payload.response.end_session, false);
  assert.deepEqual(resetRes.payload.session_state.history, []);

  // Exit skill
  const exitRes = createMockRes();
  await handler(
    { method: "POST", body: { request: { command: "хватит" }, state: { session: { history: existingHistory } } } },
    exitRes
  );
  assert.equal(exitRes.payload.response.end_session, true);
  assert.deepEqual(exitRes.payload.session_state.history, []);
});

test("AbortController DOMException timeout maps to the friendly timeout message", async () => {
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "test-key" },
    async (_url, options) => {
      // Simulate a real Node.js AbortController DOMException (name='AbortError', message='This operation was aborted')
      const abortErr = new DOMException("This operation was aborted", "AbortError");
      assert.equal(isTimeoutError(abortErr), true);
      if (options?.signal) {
        throw abortErr;
      }
      throw abortErr;
    },
    async () => {
      const res = createMockRes();
      await handler(
        { method: "POST", body: { request: { command: "Объясни теорию струн" } } },
        res
      );
      assert.equal(res.statusCode, 200);
      assert.match(res.payload.response.text, /Не успела подготовить ответ/);
    }
  );
});

test("full Serper + Gemini flow strips internal thought parts and updates compact history", async () => {
  const calls = [];
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "gemini-test", SERPER_API_KEY: "serper-test" },
    async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (String(url).includes("serper.dev")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              answerBox: { answer: "+12 °C, ясно" },
              organic: [{ title: "Погода в Москве", snippet: "Днём +12 градусов, без осадков.", date: "Сегодня" }]
            };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    { thought: true, text: "Internal reasoning that must NOT be spoken aloud." },
                    { text: "Сегодня в Москве **плюс двенадцать** градусов и ясно." }
                  ]
                }
              }
            ]
          };
        }
      };
    },
    async () => {
      const res = createMockRes();
      await handler(
        {
          method: "POST",
          body: {
            meta: { timezone: "Europe/Moscow" },
            request: { command: "какая погода сегодня в москве" },
            state: { session: { history: [] } }
          }
        },
        res
      );

      assert.equal(calls.length, 2);
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.response.text, "Сегодня в Москве плюс двенадцать градусов и ясно.");
      assert.doesNotMatch(res.payload.response.text, /Internal reasoning/);
      assert.equal(res.payload.session_state.history.length, 2);
      assert.ok(Buffer.byteLength(JSON.stringify(res.payload.session_state), "utf8") <= 1024);
    }
  );
});

test("optional ALICE_SKILL_ID and WEBHOOK_SECRET block unauthorized callers", async () => {
  await withMockEnvAndFetch(
    { GEMINI_API_KEY: "gemini-test", ALICE_SKILL_ID: "skill-123", WEBHOOK_SECRET: "topsecret" },
    null,
    async () => {
      // Wrong skill_id / missing secret -> 403
      const deniedRes = createMockRes();
      await handler(
        {
          method: "POST",
          url: "/api?secret=wrong",
          body: { session: { skill_id: "skill-123" }, request: { command: "" } }
        },
        deniedRes
      );
      assert.equal(deniedRes.statusCode, 403);

      // Matching skill_id and secret -> 200
      const okRes = createMockRes();
      await handler(
        {
          method: "POST",
          url: "/api?secret=topsecret",
          body: { session: { skill_id: "skill-123" }, request: { command: "" } }
        },
        okRes
      );
      assert.equal(okRes.statusCode, 200);
      assert.match(okRes.payload.response.text, /Привет/);
    }
  );
});
