import type { Prompter } from './prompter.ts';

/**
 * A prompter that counts the questions it asks (T115). Push and pull show their plan and ask
 * once more before changing anything only when they asked something while planning: a run
 * whose every answer came from flags (a script) goes ahead as before.
 */
export function countingPrompter(prompter: Prompter): {
  readonly prompter: Prompter;
  asked(): number;
} {
  let asked = 0;
  const count = <T>(question: () => Promise<T>): Promise<T> => {
    asked += 1;
    return question();
  };
  return {
    prompter: {
      select: (message, choices) => count(() => prompter.select(message, choices)),
      multiselect: (message, choices, options) =>
        count(() => prompter.multiselect(message, choices, options)),
      text: (message, options) => count(() => prompter.text(message, options)),
      password: (message, options) => count(() => prompter.password(message, options)),
      confirm: (message, initial) => count(() => prompter.confirm(message, initial)),
    },
    asked: () => asked,
  };
}
