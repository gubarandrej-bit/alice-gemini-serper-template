export const MAX_ALICE_TEXT = 1024;
export const CONTINUE_PROMPT_SUFFIX = " Продолжить?";
export const MAX_APPLICATION_MORE_BYTES = 820; // Leaves headroom inside 1024-byte application_state JSON

export function truncateSafe(value, maxChars) {
  const str = String(value ?? "");
  if (str.length <= maxChars) return str;
  let end = maxChars;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return str.slice(0, Math.max(0, end));
}

export function truncateUtf8Bytes(value, maxBytes) {
  const str = String(value ?? "");
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;

  let low = 0;
  let high = str.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = truncateSafe(str, mid);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = candidate.length;
    } else {
      high = mid - 1;
    }
  }
  const sliced = truncateSafe(str, low);
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace > Math.floor(sliced.length * 0.6)) {
    return sliced.slice(0, lastSpace).trim() + "…";
  }
  return sliced.trim();
}

export function stripVoiceUnfriendlyFormatting(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
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

function findNaturalBreakIndex(candidate, minSentencePos = 240) {
  for (let i = candidate.length - 1; i >= minSentencePos; i--) {
    const ch = candidate[i];
    if ((ch === "." || ch === "!" || ch === "?" || ch === "…") && (i === candidate.length - 1 || candidate[i + 1] === " ")) {
      return i + 1;
    }
  }
  const lastSpace = candidate.lastIndexOf(" ");
  if (lastSpace > 180) return lastSpace;
  return candidate.length;
}

export function fitAliceText(value) {
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

/**
 * Splits a long answer into the immediate voice chunk (<= 1024 chars including "Продолжить?")
 * and a UTF-8 byte-bounded remainder stored in application_state.more.
 */
export function splitAliceAnswer(rawValue) {
  const cleaned = stripVoiceUnfriendlyFormatting(rawValue);
  if (!cleaned) {
    return { text: "Не удалось подготовить ответ.", remainder: "" };
  }
  if (cleaned.length <= MAX_ALICE_TEXT) {
    return { text: cleaned, remainder: "" };
  }

  const maxFirstChunk = MAX_ALICE_TEXT - CONTINUE_PROMPT_SUFFIX.length - 1;
  const candidate = truncateSafe(cleaned, maxFirstChunk);
  const splitAt = findNaturalBreakIndex(candidate, 240);
  let firstChunk = candidate.slice(0, splitAt).trim();
  if (!/[.!?…]$/.test(firstChunk)) {
    firstChunk += "…";
  }

  const rawRest = cleaned.slice(splitAt).trim();
  if (!rawRest) {
    return { text: fitAliceText(firstChunk), remainder: "" };
  }

  const remainder = truncateUtf8Bytes(rawRest, MAX_APPLICATION_MORE_BYTES);
  return {
    text: `${firstChunk}${CONTINUE_PROMPT_SUFFIX}`,
    remainder
  };
}

export function normalizeCommand(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[.,!?…«»"'()[\]{}—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
