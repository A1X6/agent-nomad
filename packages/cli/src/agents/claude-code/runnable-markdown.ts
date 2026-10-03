/**
 * What in a skill, command or subagent file Claude Code runs by itself (T44), per its skills
 * and hooks docs: a `` !`command` `` placeholder at the start of a line or after whitespace,
 * a ` ```! ` block, and `hooks` in the frontmatter. These run without Claude choosing to (the
 * placeholders before Claude even sees the skill). Commands written as instructions (plain
 * text or code blocks without the `!` forms) never run by themselves and are not reported.
 */
export function runnableInMarkdown(text: string): string[] {
  const found: string[] = [];
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (frontmatter?.[1] !== undefined && /^hooks\s*:/m.test(frontmatter[1])) {
    found.push('hooks in its frontmatter');
  }
  // The open code block and its fence: as in CommonMark, only a fence of the same character,
  // at least as long and with nothing after it, closes it (SEC-02). `outer`: the plain block
  // a command block was opened inside, open again once the command block closes.
  type Open = { readonly kind: 'plain' | 'command'; readonly fence: string; readonly outer?: Open };
  let open: Open | null = null;
  const block: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // At any indentation: a fence inside a list item is indented with the item, and the
    // review must fail toward showing a block, never toward hiding one.
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const marks = fence?.[1] ?? '';
    const after = (fence?.[2] ?? '').trim();
    if (open === null && fence) {
      open = { kind: after === '!' ? 'command' : 'plain', fence: marks };
      continue;
    }
    // The docs do not say whether Claude Code skips a ` ```! ` block inside another block, so
    // it opens a command block there too, as placeholders inside a block count (below): an
    // indented fence that CommonMark reads as code must not hide the block after it.
    if (open?.kind === 'plain' && fence && after === '!') {
      open = { kind: 'command', fence: marks, outer: open };
      continue;
    }
    if (
      open !== null &&
      after === '' &&
      marks.startsWith(open.fence[0] ?? '') &&
      marks.length >= open.fence.length
    ) {
      if (open.kind === 'command') found.push(`! block: ${block.join('; ')}`);
      block.length = 0;
      open = open.outer ?? null;
      continue;
    }
    if (open?.kind === 'command') {
      if (line.trim() !== '') block.push(line.trim());
      continue;
    }
    // The docs exempt no part of the file, so a placeholder inside an ordinary code block
    // counts too.
    for (const match of line.matchAll(/(?:^|\s)!`([^`\n]+)`/g)) {
      found.push(`!\`${match[1] ?? ''}\``);
    }
  }
  if (open?.kind === 'command' && block.length > 0) found.push(`! block: ${block.join('; ')}`);
  return found;
}
