/**
 * Repair markdown that lost line breaks during transcript streaming or chunk merges.
 * Cursor transcripts sometimes collapse table rows onto one line, which breaks GFM parsing.
 */
export function normalizeMarkdown(content: string): string {
  if (!content.includes("|")) return content;

  let result = content;

  // Heading glued to a table: "## Title| col |" -> "## Title\n\n| col |"
  result = result.replace(/(^|\n)(#{1,6}\s[^\n|]+)\|/g, "$1$2\n\n|");

  // Collapsed table row boundaries (repeat until stable for multi-row tables)
  let prev = "";
  let guard = 0;
  while (prev !== result && guard++ < 24) {
    prev = result;
    result = result.replace(/\|\|(?=[-:])/g, "|\n|");
    result = result.replace(/\|\|(?=\s*\*?\*?[A-Za-z0-9`"'(])/g, "|\n|");
    result = result.replace(/\|\s+\|(?=\s*\*?\*?[A-Za-z0-9`"'(])/g, "|\n|");
  }

  // Paragraph or list line ending before a table row
  result = result.replace(/(^|\n)([^\n|]+)\n(\|[^|\n]+\|[^|\n]*\|)/g, (match, lead, line, row) => {
    if (line.trimStart().startsWith("|") || line.trimStart().startsWith("#")) return match;
    return `${lead}${line}\n\n${row}`;
  });

  return result;
}

/** Join transcript text chunks without breaking markdown structure. */
export function joinMessageContent(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  if (prev.endsWith("\n") || next.startsWith("\n")) return prev + next;

  if (/^\s*\|/.test(next) && !/\|\s*$/.test(prev)) {
    return `${prev}\n\n${next}`;
  }

  if (/\|\s*$/.test(prev) && /^\s*\|/.test(next)) {
    return `${prev}\n${next}`;
  }

  return prev + next;
}
