// How a person answers a plan that waits for Go, typed or said: "go", "go, go, go", "I said go",
// "just do it now", "never mind". Shared by the Viby box (orchestrator-reflex.ts) and a call
// (src/core/call.ts), so a waiting plan hears the same words both ways.

export type PlanAnswer = "go" | "cancel";

/** Lower case, without punctuation, so "Go ahead." and "go ahead" are the same thing said. */
export function plainWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// In each language the window speaks. Whole things said, never words inside a longer sentence:
// "go to the api workspace" is for Viby.
export const GO_WORDS: readonly string[] = [
  ...["go", "go ahead", "go on", "yes", "yes go", "yes please", "yeah", "yep", "do it", "run it", "ok", "okay", "ok go", "okay go", "confirm", "sure", "go for it"],
  ...["los", "leg los", "ja", "mach", "mach das", "mach es", "ausführen", "bestätigen"],
  ...["adelante", "sí", "si", "hazlo", "vale", "dale", "confirmar", "de acuerdo"],
  ...["vas-y", "oui", "fais-le", "d'accord", "allez", "confirmer"],
  ...["vai", "sim", "pode ir", "faz isso", "manda"],
  ...["はい", "実行", "実行して", "お願い", "お願いします", "やって", "オーケー"],
  ...["好", "好的", "开始", "执行", "确认", "可以", "是"],
];

export const CANCEL_WORDS: readonly string[] = [
  ...["cancel", "cancel that", "no", "nope", "never mind", "nevermind", "forget it", "don't", "stop", "scrap that"],
  ...["abbrechen", "nein", "vergiss es", "stopp", "doch nicht"],
  ...["cancelar", "cancela", "olvídalo", "déjalo"],
  ...["annuler", "annule", "non", "laisse tomber", "oublie"],
  ...["não", "esquece", "deixa"],
  ...["キャンセル", "いいえ", "やめて", "中止", "やめる"],
  ...["取消", "不", "不要", "算了", "停"],
];

const ANSWER_OF = new Map<string, PlanAnswer>([...GO_WORDS.map((word) => [plainWords(word), "go"] as const), ...CANCEL_WORDS.map((word) => [plainWords(word), "cancel"] as const)]);

/** Longer than this, it's a request for Viby, not an answer to the card ("go and also fix the tests"). */
const MOST_WORDS = 8;

// Said around the answer, not part of it: "I said go", "come on, go", "just do it now", "go already".
const LEAD =
  /^(?:(?:i said|i just said|i told you|like i said|come on|just|please|now|so|well|alright|all right|ok|okay|yes|yeah|yep|right|then|hey|viby|vibey|vibe|maestro|ich sagte|jetzt|bitte|ja|dije|ya|por favor|sí|jai dit|allez|sil te plaît|eu disse|agora|por favor)\s+)+/;
const TAIL =
  /(?:\s+(?:now|right now|please|already|then|for me|thanks|thank you|i said|viby|vibey|vibe|maestro|jetzt|bitte|ya|por favor|maintenant|sil te plaît|agora))+$/;

/** "go go go go" is "go", and "go ahead go ahead" is "go ahead": the same thing said again. */
function once(text: string): string {
  const words = text.split(" ");
  for (let size = 1; size <= words.length / 2; size += 1) {
    if (words.length % size) continue;
    if (words.every((word, at) => word === words[at % size])) return words.slice(0, size).join(" ");
  }
  return text;
}

/**
 * The forms of what was said that could be a whole answer, plainest first: as said, then with
 * repeats folded and the words around it dropped. Callers look each one up in their own word list.
 */
export function answerForms(said: string): string[] {
  const plain = plainWords(said);
  if (!plain || plain.split(" ").length > MOST_WORDS) return [];
  const forms = [plain];
  let text = plain;
  // A few rounds: "come on just go go go now please" needs the lead, the tail and the repeats off.
  for (let round = 0; round < 4; round += 1) {
    const next = once(text.replace(TAIL, "").replace(LEAD, "").trim());
    if (!next || next === text) break;
    text = next;
    forms.push(text);
  }
  const folded = once(plain);
  if (!forms.includes(folded)) forms.push(folded);
  return forms;
}

/** Go or cancel, when what was said is only an answer to a waiting plan; null for anything else. */
export function planAnswer(said: string): PlanAnswer | null {
  for (const form of answerForms(said)) {
    const answer = ANSWER_OF.get(form);
    if (answer) return answer;
  }
  return null;
}
