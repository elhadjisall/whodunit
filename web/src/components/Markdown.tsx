import type { ReactNode } from "react";

/* Just enough Markdown for a case report: headings, paragraphs, lists, quotes, code, bold/italic. */

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out.push(<code key={k++} className="rounded-[2px] bg-black/10 px-1 font-mono text-[0.9em]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    if (l.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={k++} className="my-2 overflow-auto rounded-sm bg-black/10 p-2 font-mono text-[10px] leading-snug">
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)/.exec(l);
    if (h) {
      const lvl = h[1].length;
      const cls = lvl <= 2 ? "font-news text-[17px] font-black leading-tight mt-3 mb-1" : "font-news text-[13px] font-bold uppercase tracking-wider mt-3 mb-1 border-b border-black/30 pb-[2px]";
      blocks.push(
        <div key={k++} className={cls}>
          {inline(h[2])}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push(
        <ul key={k++} className="my-1.5 list-disc space-y-1 pl-4">
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      blocks.push(
        <ol key={k++} className="my-1.5 list-decimal space-y-1 pl-4">
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (l.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={k++} className="my-2 border-l-4 border-crime bg-crime/5 px-2 py-1 italic">
          {inline(buf.join(" "))}
        </blockquote>,
      );
      continue;
    }
    if (l.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = rows.filter((r) => !/^\|\s*-/.test(r)).map((r) => r.split("|").slice(1, -1).map((c) => c.trim()));
      blocks.push(
        <table key={k++} className="my-2 w-full border-collapse text-[10px]">
          <tbody>
            {cells.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? "font-bold" : ""}>
                {row.map((c, ci) => (
                  <td key={ci} className="border border-black/20 px-1 py-[1px]">
                    {inline(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|>|```|\|)/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(
      <p key={k++} className="my-1.5 text-justify leading-snug">
        {inline(buf.join(" "))}
      </p>,
    );
  }
  return <div className={className}>{blocks}</div>;
}
