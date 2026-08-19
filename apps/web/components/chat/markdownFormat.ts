/**
 * Local GGUF models often emit markdown without line breaks
 * (`sentence: ### Heading - **item**`). Normalize that into blocks the
 * renderer can typeset.
 */
export function normalizeChatMarkdown(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])[ \t]+(#{1,3}[ \t]+)/g, "$1\n\n$2")
    .replace(/([:：।.!?\u0964])[ \t]+(?=[-*][ \t])/g, "$1\n")
    .replace(/([^\n])[ \t]+(-[ \t]+\*\*)/g, "$1\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ChatBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string; text: string }
  | { type: "paragraph"; text: string };

const HEADING = /^(#{1,3})[ \t]+(.+)$/;
const UNORDERED = /^[-*][ \t]+(.+)$/;
const ORDERED = /^(\d+)[.)][ \t]+(.+)$/;
const FENCE = /^```([\w.-]*)\s*$/;

export function parseChatMarkdown(input: string): ChatBlock[] {
  const lines = normalizeChatMarkdown(input).split("\n");
  const blocks: ChatBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: { language: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text) blocks.push({ type: "paragraph", text });
  };

  const flushList = () => {
    if (list && list.items.length > 0) blocks.push({ type: "list", ...list });
    list = null;
  };

  for (const line of lines) {
    if (fence) {
      if (FENCE.test(line)) {
        blocks.push({
          type: "code",
          language: fence.language,
          text: fence.lines.join("\n"),
        });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const fenceOpen = trimmed.match(FENCE);
    if (fenceOpen) {
      flushParagraph();
      flushList();
      fence = { language: fenceOpen[1] ?? "", lines: [] };
      continue;
    }

    const heading = trimmed.match(HEADING);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2]!.trim() });
      continue;
    }

    const unordered = trimmed.match(UNORDERED);
    if (unordered) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(unordered[1]!.trim());
      continue;
    }

    const ordered = trimmed.match(ORDERED);
    if (ordered) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[2]!.trim());
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  if (fence) {
    blocks.push({ type: "code", language: fence.language, text: fence.lines.join("\n") });
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function splitInline(text: string): Array<{ kind: "text" | "strong" | "code"; value: string }> {
  const parts: Array<{ kind: "text" | "strong" | "code"; value: string }> = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      parts.push({ kind: "text", value: text.slice(cursor, match.index) });
    }
    if (match[1] !== undefined) parts.push({ kind: "strong", value: match[1] });
    else parts.push({ kind: "code", value: match[2]! });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", value: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: "text", value: text }];
}
