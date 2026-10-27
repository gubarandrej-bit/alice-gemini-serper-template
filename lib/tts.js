import { MAX_ALICE_TEXT, stripVoiceUnfriendlyFormatting, truncateSafe } from "./text.js";

export const ALICE_SOUNDS = {
  harp: '<speaker audio="alice-music-harp-1.opus">',
  gameBoot: '<speaker audio="alice-sounds-game-boot-1.opus">',
  gameWin: '<speaker audio="alice-sounds-game-win-1.opus">',
  ping: '<speaker audio="alice-sounds-game-ping-1.opus">'
};

const PRONUNCIATION_MAP = [
  [/\bChatGPT\b/gi, "чат джи пи ти"],
  [/\bGPT\b/gi, "джи пи ти"],
  [/\bGemini\b/gi, "Джемини"],
  [/\bWi-?Fi\b/gi, "вай-фай"],
  [/\bAPI\b/g, "эй пи ай"],
  [/\bVPN\b/g, "ви пи эн"],
  [/\bURL\b/g, "ю эр эл"],
  [/\bUSB\b/g, "ю эс би"],
  [/\bSMS\b/g, "эс эм эс"],
  [/\bIT\b/g, "ай-ти"],
  [/(^|\s)ИИ(?=\s|[.,!?;:]|$)/g, "$1искусственный интеллект"]
];

/**
 * Builds phonetic Yandex Alice TTS markup (<= 1024 chars) from display text:
 * - Optional official Alice sound library tag prefix (<speaker audio="...">)
 * - Expands degrees (+15°C -> плюс 15 градусов), currencies ($100, €50, 500 ₽), percentages
 * - Replaces common English/tech acronyms with Russian phonetics
 * - Adds gentle prosodic pauses between sentences
 */
export function buildAliceTts(displayText, soundTag = "") {
  let tts = stripVoiceUnfriendlyFormatting(displayText);
  if (!tts) return "Не удалось подготовить ответ.";

  const prefix = soundTag ? `${soundTag} ` : "";
  const maxBodyLen = MAX_ALICE_TEXT - prefix.length;

  // Temperatures: +15°C, -5 °C, 20°C, +15°
  tts = tts.replace(/([+−-])\s*(\d+(?:[.,]\d+)?)\s*°\s*[CcСс]?\b/g, (_m, sign, num) => {
    const wordSign = sign === "+" ? "плюс" : "минус";
    return `${wordSign} ${num.replace(".", ",")} градусов`;
  });
  tts = tts.replace(/(\d+(?:[.,]\d+)?)\s*°\s*[CcСс]\b/g, (_m, num) => `${num.replace(".", ",")} градусов`);
  tts = tts.replace(/(\d+(?:[.,]\d+)?)\s*°(?!\w)/g, (_m, num) => `${num.replace(".", ",")} градусов`);

  // Currencies: $100, 100$, €50, 50€, 1000 ₽
  tts = tts.replace(/\$\s*(\d+(?:[.,]\d+)?)/g, "$1 долларов");
  tts = tts.replace(/(\d+(?:[.,]\d+)?)\s*\$/g, "$1 долларов");
  tts = tts.replace(/€\s*(\d+(?:[.,]\d+)?)/g, "$1 евро");
  tts = tts.replace(/(\d+(?:[.,]\d+)?)\s*€/g, "$1 евро");
  tts = tts.replace(/(\d+(?:[.,]\d+)?)\s*₽/g, "$1 рублей");

  // Percentages: 15%
  tts = tts.replace(/(\d+(?:[.,]\d+)?)\s*%/g, "$1 процентов");

  // Pronunciations for common abbreviations
  for (const [pattern, replacement] of PRONUNCIATION_MAP) {
    tts = tts.replace(pattern, replacement);
  }

  const withPauses = tts
    .replace(/\s+[—–]\s+/g, " sil <[140]> ")
    .replace(/([.!?])\s+(?=[А-ЯЁA-Z0-9])/g, "$1 sil <[180]> ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (withPauses.length <= maxBodyLen) {
    return `${prefix}${withPauses}`;
  }

  if (tts.length <= maxBodyLen) {
    return `${prefix}${tts}`;
  }

  const candidate = truncateSafe(tts, maxBodyLen - 1);
  const lastSpace = candidate.lastIndexOf(" ");
  return `${prefix}${(lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim()}`;
}
