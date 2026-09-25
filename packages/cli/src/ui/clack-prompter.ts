import * as clack from '@clack/prompts';

import { PromptCancelledError, type Choice, type Prompter, type Reporter } from './prompter.ts';

/** A clack answer, or PromptCancelledError when the user pressed Ctrl+C or Esc. */
export function unwrapAnswer<T>(answer: T): Exclude<T, symbol> {
  if (clack.isCancel(answer)) throw new PromptCancelledError();
  return answer as Exclude<T, symbol>;
}

const toOptions = <T extends string>(choices: readonly Choice<T>[]) =>
  choices.map((choice) => ({
    value: choice.value,
    label: choice.label,
    ...(choice.hint !== undefined && { hint: choice.hint }),
  }));

/** The Prompter on @clack/prompts (T04 decision). Commands only see the Prompter interface. */
export function createClackPrompter(): Prompter {
  return {
    async select(message, choices) {
      // clack types options loosely for generic values; the answer is one of `choices`.
      return unwrapAnswer(await clack.select({ message, options: toOptions(choices) as never }));
    },

    async multiselect(message, choices, options = {}) {
      return unwrapAnswer(
        await clack.multiselect({
          message,
          options: toOptions(choices) as never,
          required: options.required ?? true,
          ...(options.initial && { initialValues: [...options.initial] }),
        }),
      );
    },

    async text(message, options = {}) {
      const { validate } = options;
      return unwrapAnswer(
        await clack.text({
          message,
          ...(options.placeholder !== undefined && { placeholder: options.placeholder }),
          ...(validate && { validate: (value: string | undefined) => validate(value ?? '') }),
        }),
      );
    },

    async password(message, options = {}) {
      const { validate } = options;
      return unwrapAnswer(
        await clack.password({
          message,
          clearOnError: true,
          ...(validate && { validate: (value: string | undefined) => validate(value ?? '') }),
        }),
      );
    },

    async confirm(message, initial = false) {
      return unwrapAnswer(await clack.confirm({ message, initialValue: initial }));
    },
  };
}

/** Messages and spinners on @clack/prompts. */
export function createClackReporter(): Reporter {
  return {
    info: (message) => {
      clack.log.info(message);
    },
    success: (message) => {
      clack.log.success(message);
    },
    warn: (message) => {
      clack.log.warn(message);
    },
    error: (message) => {
      clack.log.error(message);
    },
    spinner: () => {
      const spinner = clack.spinner();
      return {
        start: (message) => {
          spinner.start(message);
        },
        stop: (message) => {
          spinner.stop(message);
        },
      };
    },
  };
}
