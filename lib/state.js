import { VALID_MODES, getModeLabel } from "./modes.js";
import { normalizeCommand, truncateSafe, truncateUtf8Bytes } from "./text.js";

export const MAX_HISTORY_MESSAGES = 8;
export const MAX_HISTORY_MESSAGE_CHARS = 180;
export const MAX_SESSION_STATE_BYTES = 960; // Hard protocol limit: 1024 bytes
export const MAX_USER_STATE_BYTES = 900;
export const MAX_APPLICATION_STATE_BYTES = 960;

export function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  const valid = [];
  for (const item of history) {
    if (!item || (item.role !== "user" && item.role !== "model") || typeof item.text !== "string") {
      continue;
    }
    const cleaned = item.text.trim();
    if (!cleaned) continue;
    const truncated = truncateSafe(cleaned, MAX_HISTORY_MESSAGE_CHARS);

    if (valid.length > 0 && valid[valid.length - 1].role === item.role) {
      valid[valid.length - 1] = { role: item.role, text: truncated };
    } else {
      valid.push({ role: item.role, text: truncated });
    }
  }

  const sliced = valid.slice(-MAX_HISTORY_MESSAGES);
  while (sliced.length > 0 && sliced[0].role !== "user") {
    sliced.shift();
  }
  return sliced;
}

export function safeMode(mode) {
  return VALID_MODES.includes(mode) ? mode : "assistant";
}

export function fitSessionState(history, mode = "assistant") {
  const normalizedMode = safeMode(mode);
  const normalizedHistory = safeHistory(history);

  const buildObj = hist =>
    normalizedMode === "assistant"
      ? { history: hist }
      : { history: hist, mode: normalizedMode };

  while (normalizedHistory.length > 0) {
    const candidate = buildObj(normalizedHistory);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_SESSION_STATE_BYTES) {
      break;
    }
    normalizedHistory.shift();
    while (normalizedHistory.length > 0 && normalizedHistory[0].role !== "user") {
      normalizedHistory.shift();
    }
  }

  return buildObj(normalizedHistory);
}

export function fitHistoryToStateLimit(history, mode = "assistant") {
  return fitSessionState(history, mode).history;
}

export function safeUserProfile(rawUser) {
  if (!rawUser || typeof rawUser !== "object") return {};
  const profile = {};

  if (typeof rawUser.city === "string" && rawUser.city.trim()) {
    profile.city = truncateSafe(rawUser.city.trim(), 50);
  }
  if (typeof rawUser.name === "string" && rawUser.name.trim()) {
    profile.name = truncateSafe(rawUser.name.trim(), 35);
  }
  if (rawUser.style === "short" || rawUser.style === "normal" || rawUser.style === "detailed") {
    profile.style = rawUser.style;
  }

  if (Buffer.byteLength(JSON.stringify(profile), "utf8") > MAX_USER_STATE_BYTES) {
    return { city: profile.city };
  }
  return profile;
}

export function safeApplicationState(rawApp) {
  if (!rawApp || typeof rawApp !== "object") return {};
  const state = {};
  if (typeof rawApp.more === "string" && rawApp.more.trim()) {
    state.more = truncateUtf8Bytes(rawApp.more.trim(), 820);
  }
  if (typeof rawApp.pendingId === "string" && /^[A-Za-z0-9_-]{4,40}$/.test(rawApp.pendingId)) {
    state.pendingId = rawApp.pendingId;
  }
  if (typeof rawApp.pendingQ === "string" && rawApp.pendingQ.trim()) {
    state.pendingQ = truncateUtf8Bytes(rawApp.pendingQ.trim(), 220);
  }
  return fitApplicationState(state);
}

export function fitApplicationState(state) {
  if (!state || typeof state !== "object") return {};
  const result = {};
  if (state.pendingId) result.pendingId = String(state.pendingId);
  if (state.pendingQ) result.pendingQ = truncateUtf8Bytes(String(state.pendingQ), 200);
  if (state.more) {
    let maxMoreBytes = 820;
    result.more = truncateUtf8Bytes(String(state.more), maxMoreBytes);
    while (maxMoreBytes > 100 && Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_APPLICATION_STATE_BYTES) {
      maxMoreBytes -= 80;
      result.more = truncateUtf8Bytes(String(state.more), maxMoreBytes);
    }
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_APPLICATION_STATE_BYTES) {
    delete result.pendingQ;
  }
  return result;
}

function capitalizeTitle(str) {
  return String(str)
    .trim()
    .split(/(\s+|-)/)
    .map(part => {
      if (!part || /^(\s+|-)$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
}

/**
 * Parses voice commands that manage persistent user preferences (city, name, style).
 */
export function detectProfileCommand(rawText, currentProfile = {}, currentMode = "assistant") {
  const clean = String(rawText ?? "").replace(/[.,!?…«»"']/g, "").replace(/\s+/g, " ").trim();
  const cmd = normalizeCommand(rawText);

  // Inspect saved profile
  if (/^(что ты обо мне помнишь|что ты знаешь обо мне|мои настройки|мой профиль|какой у меня город)$/.test(cmd)) {
    const details = [];
    if (currentProfile.name) details.push(`вас зовут ${currentProfile.name}`);
    if (currentProfile.city) details.push(`ваш город — ${currentProfile.city}`);
    const styleLabels = { short: "краткий", detailed: "подробный", normal: "обычный" };
    if (currentProfile.style) details.push(`стиль ответов — ${styleLabels[currentProfile.style]}`);
    details.push(`активен режим: ${getModeLabel(currentMode)}`);

    if (!currentProfile.name && !currentProfile.city && !currentProfile.style) {
      return {
        reply: `Пока персональных настроек нет, активен ${getModeLabel(currentMode)}. Вы можете сказать «запомни мой город Москва» или «меня зовут Андрей».`
      };
    }
    return {
      reply: `Я помню, что ${details.join(", ")}. Чтобы стереть настройки, скажите «забудь обо мне».`
    };
  }

  // Clear profile
  if (/^(забудь обо мне|сбрось настройки|сбрось мои настройки|удали мои данные|очисти профиль)$/.test(cmd)) {
    return {
      userStateUpdate: { city: null, name: null, style: null },
      reply: "Готово, я удалила ваши сохранённые имя, город и настройки стиля."
    };
  }

  // Set default city
  const cityMatch = clean.match(
    /^(?:алиса\s+)?(?:запомни\s+(?:что\s+)?)?(?:мой\s+город|город\s+по\s+умолчанию|поставь\s+город|установи\s+город|смени\s+город\s+на)\s+([А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z\s-]{1,40})$/i
  );
  if (cityMatch) {
    const city = capitalizeTitle(cityMatch[1]);
    return {
      userStateUpdate: { ...currentProfile, city },
      reply: `Запомнила ваш город — ${city}. Теперь буду учитывать его в вопросах о погоде и событиях.`
    };
  }

  // Set user name
  const nameMatch = clean.match(
    /^(?:алиса\s+)?(?:запомни\s+(?:что\s+)?)?(?:меня\s+зовут|моё\s+имя|мое\s+имя|называй\s+меня)\s+([А-Яа-яЁёA-Za-z]{2,25})$/i
  );
  if (nameMatch) {
    const name = capitalizeTitle(nameMatch[1]);
    return {
      userStateUpdate: { ...currentProfile, name },
      reply: `Приятно познакомиться, ${name}! Я запомнила ваше имя.`
    };
  }

  // Set response verbosity style
  if (/^(отвечай кратко|отвечай покороче|короткие ответы|краткий стиль|говори короче)$/.test(cmd)) {
    return {
      userStateUpdate: { ...currentProfile, style: "short" },
      reply: "Договорились, теперь буду отвечать максимально коротко и по делу."
    };
  }

  if (/^(отвечай подробно|отвечай развернуто|отвечай развёрнуто|подробные ответы|подробный стиль)$/.test(cmd)) {
    return {
      userStateUpdate: { ...currentProfile, style: "detailed" },
      reply: "Хорошо, теперь буду давать более подробные и обстоятельные ответы."
    };
  }

  if (/^(отвечай обычно|обычные ответы|обычный стиль ответов)$/.test(cmd)) {
    return {
      userStateUpdate: { ...currentProfile, style: "normal" },
      reply: "Вернула стандартную длину ответов — от одного до трёх предложений."
    };
  }

  return null;
}
