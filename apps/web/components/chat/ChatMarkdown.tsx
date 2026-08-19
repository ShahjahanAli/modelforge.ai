"use client";

import { parseChatMarkdown, splitInline } from "./markdownFormat";

function Inline({ text }: { text: string }) {
  return (
    <>
      {splitInline(text).map((part, index) => {
        if (part.kind === "strong") {
          return (
            <strong key={index} className="font-semibold text-content-primary">
              {part.value}
            </strong>
          );
        }
        if (part.kind === "code") {
          return (
            <code
              key={index}
              className="rounded-md border border-line bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-brand-700"
            >
              {part.value}
            </code>
          );
        }
        return <span key={index}>{part.value}</span>;
      })}
    </>
  );
}

export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseChatMarkdown(text);
  if (blocks.length === 0) return null;

  return (
    <div className="space-y-2.5 text-[13.5px] leading-7 text-content-primary sm:text-sm">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
          return (
            <Tag
              key={index}
              className={`font-semibold tracking-tight text-content-primary ${
                index === 0 ? "" : "pt-1.5"
              } ${block.level === 1 ? "text-base" : "text-[13px] sm:text-sm"}`}
            >
              <Inline text={block.text} />
            </Tag>
          );
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={index}
              className={`space-y-1 pl-4 text-content-secondary ${
                block.ordered ? "list-decimal" : "list-disc"
              }`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="pl-1">
                  <Inline text={item} />
                </li>
              ))}
            </List>
          );
        }
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-xl border border-line bg-surface-2 px-3 py-2.5 font-mono text-[12px] leading-5 text-content-secondary"
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        return (
          <p key={index} className="text-content-secondary">
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}
