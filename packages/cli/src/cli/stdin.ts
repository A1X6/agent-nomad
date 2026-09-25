import type { Readable } from 'node:stream';

/** More than any password (the policy caps it at 256 characters), less than a pasted file. */
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * `--password-stdin` (T36): the first line of standard input, without its line ending.
 * Refuses a terminal, where it would wait silently: the password must be piped in.
 */
export async function readFirstLine(
  input: Readable & { readonly isTTY?: boolean },
): Promise<string> {
  if (input.isTTY) {
    throw new Error(
      '--password-stdin reads the password from a pipe, e.g. `echo "$PASSWORD" | agentnomad login --username me --password-stdin`. Leave it out to type the password instead.',
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += bytes.byteLength;
    if (size > MAX_STDIN_BYTES) throw new Error('--password-stdin: standard input is too long.');
    chunks.push(bytes);
    // The first line is enough; stop reading once it is complete.
    if (bytes.includes(0x0a)) break;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const end = text.indexOf('\n');
  return (end === -1 ? text : text.slice(0, end)).replace(/\r$/, '');
}
