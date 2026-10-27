import { truncateSafe } from "./text.js";

const MAX_BUTTON_TITLE = 64;

function btn(title) {
  return {
    title: truncateSafe(title, MAX_BUTTON_TITLE),
    hide: true
  };
}

/**
 * Generates contextual suggestion chips for devices with a screen (phones, smart displays, browsers).
 * Returns undefined when the client has no screen or when the session is ending.
 */
export function buildScreenButtons({
  hasScreen = false,
  endSession = false,
  hasMore = false,
  hasPending = false,
  mode = "assistant",
  isLaunch = false,
  userProfile = {}
} = {}) {
  if (!hasScreen || endSession) return undefined;

  const buttons = [];

  if (hasPending || hasMore) {
    buttons.push(btn("Дальше"));
  }

  if (mode === "quiz") {
    buttons.push(btn("Любая тема"), btn("Подсказка"), btn("Обычный режим"), btn("Хватит"));
    return buttons.slice(0, 5);
  }

  if (mode === "storyteller") {
    buttons.push(btn("Придумай сказку"), btn("Дальше"), btn("Обычный режим"), btn("Хватит"));
    return buttons.filter((b, idx, arr) => arr.findIndex(x => x.title === b.title) === idx).slice(0, 5);
  }

  if (mode === "translator") {
    buttons.push(btn("Обычный режим"), btn("Помощь"), btn("Хватит"));
    return buttons.slice(0, 5);
  }

  if (mode === "coach") {
    buttons.push(btn("Let's talk about travel"), btn("Как это переводится?"), btn("Обычный режим"), btn("Хватит"));
    return buttons.slice(0, 5);
  }

  if (mode === "brainstorm") {
    buttons.push(btn("Что приготовить на ужин?"), btn("Идеи подарка"), btn("Обычный режим"), btn("Хватит"));
    return buttons.slice(0, 5);
  }

  // Default assistant mode
  if (isLaunch) {
    const weatherLabel = userProfile?.city ? `Погода в г. ${userProfile.city}` : "Какая погода сегодня?";
    buttons.push(
      btn(weatherLabel),
      btn("Свежие новости"),
      btn("Режимы"),
      btn("Помощь")
    );
    return buttons.slice(0, 5);
  }

  if (!hasPending && !hasMore) {
    buttons.push(btn("Подробнее"), btn("Сменить тему"), btn("Режимы"), btn("Хватит"));
  } else {
    buttons.push(btn("Сменить тему"), btn("Хватит"));
  }

  return buttons.slice(0, 5);
}
