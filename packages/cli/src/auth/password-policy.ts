/**
 * Password rules for new accounts (T23). A stolen server database still allows offline
 * guessing (slowed by Argon2id), so guessable passwords are refused. No "must contain a
 * symbol" rules: NIST SP 800-63B advises length plus a check against common passwords.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
/**
 * zxcvbn score 0–4. 4 = at least 10^10 guesses ("strong protection from an offline slow-hash
 * attack", our threat). Score 3 starts at 10^8, which GPUs get through in hours even
 * against Argon2id at 64 MiB; e.g. "Summer2026!!!" scores 3.
 */
export const MIN_PASSWORD_SCORE = 4;
/** zxcvbn gets slow on very long input; anything this long is past guessing anyway. */
const MAX_CHECKED_LENGTH = 100;

/** Returns why the password is refused, or `undefined` when it is fine. */
export type PasswordChecker = (
  password: string,
  userInputs: readonly string[],
) => string | undefined;

/** The strength estimate the policy needs (zxcvbn-ts in production). */
export interface StrengthEstimate {
  readonly score: number;
  readonly warning: string | null;
  readonly suggestions: readonly string[];
}
export type StrengthEstimator = (password: string, userInputs: string[]) => StrengthEstimate;

const graphemes = new Intl.Segmenter();

/** Applies the rules on top of any estimator. */
export function createPasswordChecker(estimate: StrengthEstimator): PasswordChecker {
  return (password, userInputs) => {
    // What a person sees as one character (an accented letter or emoji counts once).
    const length = [...graphemes.segment(password)].length;
    if (length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${String(MIN_PASSWORD_LENGTH)} characters (a few unrelated words work well).`;
    }
    if (length > MAX_PASSWORD_LENGTH) {
      return `Use at most ${String(MAX_PASSWORD_LENGTH)} characters.`;
    }
    const result = estimate(password.slice(0, MAX_CHECKED_LENGTH), [...userInputs, 'agentnomad']);
    if (result.score >= MIN_PASSWORD_SCORE) return undefined;
    const why = result.warning ?? 'This password is too easy to guess.';
    const tip = result.suggestions[0] ?? 'Add another word or two that are not related.';
    return `${why} ${tip}`;
  };
}

/**
 * zxcvbn-ts with its common-password, English word and name lists. Loaded only when needed
 * (about 8 MB of word lists), so other commands start fast.
 */
export async function loadZxcvbnChecker(): Promise<PasswordChecker> {
  const [{ ZxcvbnFactory }, common, english] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
    import('@zxcvbn-ts/language-en'),
  ]);
  const zxcvbn = new ZxcvbnFactory({
    translations: english.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...english.dictionary },
  });
  return createPasswordChecker((password, userInputs) => {
    const { score, feedback } = zxcvbn.check(password, userInputs);
    return { score, warning: feedback.warning, suggestions: feedback.suggestions };
  });
}
