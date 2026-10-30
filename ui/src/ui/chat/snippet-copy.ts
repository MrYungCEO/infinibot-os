/** Copy affordances shared by every agent-message markdown surface. */

const COPIED_FOR_MS = 1500;

/**
 * Add an accessible Copy button to fenced blocks and inline code without
 * weakening the canonical markdown sanitizer. Call this only with already
 * sanitized HTML.
 */
export function withSnippetCopyButtons(sanitizedHtml: string): string {
  if (!sanitizedHtml) return sanitizedHtml;

  const blocks: string[] = [];
  const protectedHtml = sanitizedHtml.replace(/<pre(?:\s[^>]*)?>[\s\S]*?<\/pre>/gi, (block) => {
    const index =
      blocks.push(
        `<div class="md-copyable md-copyable--block">` +
          `<button type="button" class="md-copy-button" aria-label="Copy code block" title="Copy code block">Copy</button>` +
          `${block}</div>`,
      ) - 1;
    return `<!--ib-snippet-${index}-->`;
  });

  const withInline = protectedHtml.replace(
    /<code(\s[^>]*)?>([\s\S]*?)<\/code>/gi,
    (_match, attrs = "", body: string) =>
      `<span class="md-copyable md-copyable--inline"><code${attrs}>${body}</code>` +
      `<button type="button" class="md-copy-button md-copy-button--inline" aria-label="Copy inline snippet" title="Copy inline snippet">Copy</button></span>`,
  );

  return withInline.replace(
    /<!--ib-snippet-(\d+)-->/g,
    (_match, index: string) => blocks[Number(index)] ?? "",
  );
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

/** Event-delegated handler for HTML produced by withSnippetCopyButtons(). */
export function handleSnippetCopy(event: Event): void {
  const path = event.composedPath();
  const button = path.find(
    (node): node is HTMLButtonElement =>
      node instanceof HTMLButtonElement && node.classList.contains("md-copy-button"),
  );
  if (!button || button.dataset.copying === "1") return;
  const wrapper = button.closest(".md-copyable");
  const snippet = wrapper?.querySelector("pre, code")?.textContent ?? "";
  if (!snippet) return;

  button.dataset.copying = "1";
  button.setAttribute("aria-busy", "true");
  void writeClipboard(snippet).then(() => {
    if (!button.isConnected) return;
    button.textContent = "Copied";
    button.dataset.copied = "1";
    button.removeAttribute("aria-busy");
    delete button.dataset.copying;
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = "Copy";
      delete button.dataset.copied;
    }, COPIED_FOR_MS);
  });
}

/** Markdown rendered as human-readable text for whole-response copying. */
export function markdownToPlainText(markdown: string, sanitizedHtml: string): string {
  if (!markdown.trim()) return "";
  const container = document.createElement("div");
  container.innerHTML = sanitizedHtml;
  for (const el of container.querySelectorAll("br")) el.replaceWith("\n");
  for (const el of container.querySelectorAll(
    "p, div, h1, h2, h3, h4, h5, h6, li, pre, blockquote, tr",
  )) {
    el.append(document.createTextNode("\n"));
  }
  return (container.textContent ?? markdown)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
