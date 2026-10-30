/**
 * Markdown ↔ Block[] conversion — pure, dependency-free, shared between the
 * browser block-editor and the gateway (so agent tools can write markdown
 * into project content storage and have it render the same way the DB-row
 * markdown body does).
 *
 * Block format mirrors the editor's runtime shape so what the gateway
 * stores is identical to what the editor consumes — no per-route
 * translation layer needed.
 */
function uid() {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
/** Identify lines that begin a new block, used by the paragraph collector. */
function isBlockStart(line) {
  return /^(?:#{1,3}\s|[-*]\s|\d+\.\s|>\s|---+$|\*\*\*+$|```|!\[)/.test(line);
}
/**
 * Parse a markdown string into a flat block list. Supports:
 *   - Headings (#, ##, ###)
 *   - Bullets / numbered lists
 *   - Todos (- [ ] / - [x])
 *   - Blockquotes (>) — promoted to "callout" when the first character is
 *     an extended pictographic (emoji)
 *   - Standalone image lines (![alt](src))
 *   - Code fences (``` lang)
 *   - Dividers (--- or ***)
 *   - Paragraphs (multiple consecutive non-block lines collapsed with a
 *     single space)
 */
export function markdownToBlocks(md) {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    // Divider
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push({ id: uid(), type: "divider", text: "" });
      i++;
      continue;
    }
    // Heading
    let m = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (m) {
      const lvl = m[1].length;
      const type = lvl === 1 ? "h1" : lvl === 2 ? "h2" : "h3";
      blocks.push({ id: uid(), type, text: m[2] });
      i++;
      continue;
    }
    // Todo
    m = /^[-*]\s+\[(\s|x|X)\]\s+(.*)$/.exec(trimmed);
    if (m) {
      blocks.push({
        id: uid(),
        type: "todo",
        text: m[2],
        checked: m[1].toLowerCase() === "x",
      });
      i++;
      continue;
    }
    // Bullet
    m = /^[-*]\s+(.*)$/.exec(trimmed);
    if (m) {
      blocks.push({ id: uid(), type: "bullet", text: m[1] });
      i++;
      continue;
    }
    // Numbered
    m = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (m) {
      blocks.push({ id: uid(), type: "numbered", text: m[1] });
      i++;
      continue;
    }
    // Quote / callout — emoji at the start of the body promotes to callout
    m = /^>\s?(.*)$/.exec(trimmed);
    if (m) {
      const inner = m[1] ?? "";
      const callout = /^\p{Extended_Pictographic}/u.test(inner);
      blocks.push({
        id: uid(),
        type: callout ? "callout" : "quote",
        text: inner,
      });
      i++;
      continue;
    }
    // Image (standalone line). Markdown image with no other content on the
    // line becomes its own image block. Captures alt + src; ignores any
    // trailing optional title for simplicity.
    m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(trimmed);
    if (m) {
      blocks.push({ id: uid(), type: "image", text: m[1], src: m[2] });
      i++;
      continue;
    }
    // Code fence
    if (trimmed.startsWith("```")) {
      const lang = trimmed.replace(/^```/, "").trim();
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push({
        id: uid(),
        type: "code",
        text: codeLines.join("\n"),
        language: lang || undefined,
      });
      continue;
    }
    // Paragraph — collect consecutive non-empty, non-block-start lines
    const paraLines = [raw];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ id: uid(), type: "paragraph", text: paraLines.join(" ") });
  }
  return blocks;
}
/**
 * Serialize blocks back to markdown. Round-trips with markdownToBlocks for
 * every block type defined above (modulo paragraph re-flow — the parser
 * collapses multi-line paragraphs into one line, which is the standard
 * markdown reading rule).
 */
export function blocksToMarkdown(blocks) {
  const out = [];
  let numCounter = 0;
  let lastWasNumbered = false;
  for (const b of blocks) {
    if (b.type !== "numbered") {
      lastWasNumbered = false;
      numCounter = 0;
    }
    switch (b.type) {
      case "h1":
        out.push(`# ${b.text}`);
        break;
      case "h2":
        out.push(`## ${b.text}`);
        break;
      case "h3":
        out.push(`### ${b.text}`);
        break;
      case "bullet":
        out.push(`- ${b.text}`);
        break;
      case "numbered": {
        if (!lastWasNumbered) numCounter = 0;
        numCounter += 1;
        out.push(`${numCounter}. ${b.text}`);
        lastWasNumbered = true;
        break;
      }
      case "todo":
        out.push(`- [${b.checked ? "x" : " "}] ${b.text}`);
        break;
      case "quote":
        out.push(`> ${b.text}`);
        break;
      case "callout":
        out.push(`> ${b.text}`);
        break;
      case "code":
        out.push(`\`\`\`${b.language ?? ""}\n${b.text}\n\`\`\``);
        break;
      case "divider":
        out.push(`---`);
        break;
      case "image": {
        const alt = (b.text || "image").replace(/[[\]]/g, "");
        out.push(`![${alt}](${b.src ?? ""})`);
        break;
      }
      case "paragraph":
      default:
        out.push(b.text);
    }
  }
  return out.join("\n\n");
}
