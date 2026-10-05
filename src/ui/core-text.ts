import { matchCoreText } from "./core-match.js";
import { t } from "./i18n/index.js";

export { matchCoreText };

/** A message from the main process in the chosen language; unknown messages stay as they are. */
export function coreText(message: string): string {
  if (t.language === "en" || !message) return message;
  const found = matchCoreText(message, coreText);
  return found ? t(found.key, found.vars) : message;
}
