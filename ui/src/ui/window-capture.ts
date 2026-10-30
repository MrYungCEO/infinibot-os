/**
 * Capture what this InfiniBot window is showing, from inside the page.
 *
 * Used by `ui_control screenshot` (local or from another federation node) and
 * by the remote-screen mirror. No permission prompt and no extra dependency:
 * the composed tree (shadow roots flattened, slots resolved) is cloned with
 * every element's computed style inlined (diffed against tag defaults), then
 * rendered through an SVG <foreignObject> onto a canvas. Canvases, images and
 * video frames are inlined as data URLs; scroll offsets are kept.
 *
 * It is a faithful approximation, not pixels from the compositor: web fonts
 * may fall back and cross-origin media without CORS is left blank.
 */

export type WindowCapture = {
  dataUrl: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  route: string;
  title: string;
  elements: number;
  truncated: boolean;
  ms: number;
};

export type WindowCaptureOptions = {
  /** Output width cap in px (default 1280). */
  maxWidth?: number;
  /** JPEG quality 0..1 (default 0.78). */
  quality?: number;
  /** Element budget before the rest renders as empty boxes (default 9000). */
  maxElements?: number;
};

const SKIP_TAGS = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE", "LINK", "META", "STYLE", "HEAD", "TITLE", "BASE"]);
const XHTML = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
/** Props that never matter for a static picture and only bloat the markup. */
const IGNORED_PROPS = /^(transition|animation|will-change|cursor|pointer-events|user-select|-webkit-user-select|caret-color|touch-action|scroll-|overscroll|content-visibility|contain-intrinsic)/;
const SVG_PROPS = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "color", "fill-opacity", "stroke-opacity", "stop-color", "stop-opacity", "font-size", "font-family", "font-weight"];

class DefaultStyles {
  private frame: HTMLIFrameElement | null = null;
  private cache = new Map<string, Map<string, string>>();

  get(tag: string): Map<string, string> {
    const hit = this.cache.get(tag);
    if (hit) return hit;
    const map = new Map<string, string>();
    const doc = this.doc();
    if (doc) {
      const el = doc.createElement(tag);
      doc.body.appendChild(el);
      const cs = doc.defaultView!.getComputedStyle(el);
      for (let i = 0; i < cs.length; i++) {
        const prop = cs[i]!;
        map.set(prop, cs.getPropertyValue(prop));
      }
      el.remove();
    }
    this.cache.set(tag, map);
    return map;
  }

  private doc(): Document | null {
    if (!this.frame) {
      const f = document.createElement("iframe");
      f.setAttribute("aria-hidden", "true");
      f.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:10px;height:10px;border:0;visibility:hidden";
      document.documentElement.appendChild(f);
      this.frame = f;
    }
    return this.frame.contentDocument;
  }

  dispose(): void {
    this.frame?.remove();
    this.frame = null;
  }
}

function styleText(cs: CSSStyleDeclaration, defaults: Map<string, string>): string {
  let out = "";
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i]!;
    if (prop.startsWith("--") || IGNORED_PROPS.test(prop)) continue;
    const value = cs.getPropertyValue(prop);
    if (defaults.get(prop) === value) continue;
    out += `${prop}:${value};`;
  }
  return out;
}

function mediaToDataUrl(el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement): string | null {
  try {
    if (el instanceof HTMLCanvasElement) return el.width && el.height ? el.toDataURL("image/png") : null;
    const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 1600 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext("2d")!.drawImage(el, 0, 0, c.width, c.height);
    return c.toDataURL(el instanceof HTMLImageElement && /\.png($|\?)/i.test(el.currentSrc) ? "image/png" : "image/jpeg", 0.85);
  } catch {
    return null; // tainted (cross-origin without CORS)
  }
}

function pseudoClone(
  doc: Document,
  el: Element,
  which: "::before" | "::after",
  defaults: DefaultStyles,
): HTMLElement | null {
  const cs = getComputedStyle(el, which);
  const content = cs.getPropertyValue("content");
  if (!content || content === "none" || content === "normal") return null;
  const span = doc.createElementNS(XHTML, "span") as HTMLElement;
  span.setAttribute("style", styleText(cs, defaults.get("span")));
  const text = /^["'](.*)["']$/.exec(content)?.[1] ?? "";
  if (text) span.textContent = text.replace(/\\([0-9a-f]{1,6}) ?/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
  return span;
}

/** Children in the composed (rendered) order: shadow root first, slots resolved. */
function composedChildren(el: Element): Node[] {
  const root = (el as HTMLElement).shadowRoot;
  const source: NodeListOf<ChildNode> | ChildNode[] = root ? root.childNodes : el.childNodes;
  const out: Node[] = [];
  for (const child of Array.from(source)) {
    if (child instanceof HTMLSlotElement) {
      const assigned = child.assignedNodes({ flatten: true });
      out.push(...(assigned.length ? assigned : Array.from(child.childNodes)));
    } else {
      out.push(child);
    }
  }
  return out;
}

class Cloner {
  count = 0;
  truncated = false;

  constructor(
    private doc: Document,
    private defaults: DefaultStyles,
    private maxElements: number,
  ) {}

  clone(node: Node): Node | null {
    if (node.nodeType === Node.TEXT_NODE) return this.doc.createTextNode(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return null;
    if ((el as HTMLElement).dataset?.ibCaptureSkip !== undefined) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return null;
    if (el.namespaceURI === SVG_NS) return this.cloneSvg(el as SVGElement);

    this.count++;
    const tag = el.tagName.toLowerCase();
    const known = /^[a-z][a-z0-9]*$/.test(tag) && !tag.includes("-");
    const out = this.doc.createElementNS(XHTML, known ? tag : "div") as HTMLElement;
    let style = styleText(cs, this.defaults.get(known ? tag : "div"));
    if (!known && cs.display === "inline" && !style.includes("display:")) style += "display:inline;";

    if (this.count > this.maxElements) {
      this.truncated = true;
      const r = el.getBoundingClientRect();
      out.setAttribute("style", `${style}width:${r.width}px;height:${r.height}px;`);
      return out;
    }

    if (el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement || el instanceof HTMLImageElement) {
      const img = this.doc.createElementNS(XHTML, "img") as HTMLImageElement;
      const src = mediaToDataUrl(el);
      if (src) img.setAttribute("src", src);
      const r = el.getBoundingClientRect();
      img.setAttribute("style", `${styleText(cs, this.defaults.get("img"))}width:${r.width}px;height:${r.height}px;`);
      return img;
    }
    if (el instanceof HTMLIFrameElement) {
      const r = el.getBoundingClientRect();
      out.setAttribute("style", `${style}width:${r.width}px;height:${r.height}px;background:rgba(127,127,127,.12);`);
      return out;
    }
    out.setAttribute("style", style);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        if (el.checked) out.setAttribute("checked", "checked");
        out.setAttribute("type", el.type);
      } else {
        const text = el instanceof HTMLInputElement && el.type === "password" ? "•".repeat(el.value.length) : el.value || el.placeholder;
        const holder = this.doc.createElementNS(XHTML, "div") as HTMLElement;
        holder.setAttribute("style", `white-space:pre;overflow:hidden;${el.value ? "" : "opacity:.55;"}`);
        holder.textContent = text;
        out.appendChild(holder);
        return out;
      }
    }
    if (el instanceof HTMLSelectElement) {
      out.textContent = el.selectedOptions[0]?.textContent ?? "";
      return out;
    }

    const before = pseudoClone(this.doc, el, "::before", this.defaults);
    if (before) out.appendChild(before);
    const scrollX = (el as HTMLElement).scrollLeft || 0;
    const scrollY = (el as HTMLElement).scrollTop || 0;
    for (const child of composedChildren(el)) {
      const c = this.clone(child);
      if (!c) continue;
      if ((scrollX || scrollY) && c instanceof Element) {
        const prev = c.getAttribute("style") ?? "";
        c.setAttribute("style", `${prev}translate:${-scrollX}px ${-scrollY}px;`);
      }
      out.appendChild(c);
    }
    const after = pseudoClone(this.doc, el, "::after", this.defaults);
    if (after) out.appendChild(after);
    return out;
  }

  /** SVG keeps its own markup; inline only the presentation props CSS may have set. */
  private cloneSvg(el: SVGElement): Node {
    this.count++;
    const copy = el.cloneNode(true) as SVGElement;
    const src = [el, ...Array.from(el.querySelectorAll("*"))];
    const dst = [copy, ...Array.from(copy.querySelectorAll("*"))];
    src.forEach((s, i) => {
      const d = dst[i];
      if (!d) return;
      const cs = getComputedStyle(s);
      let style = "";
      for (const prop of SVG_PROPS) style += `${prop}:${cs.getPropertyValue(prop)};`;
      if (i === 0) {
        const r = el.getBoundingClientRect();
        style += `display:${cs.display};width:${r.width}px;height:${r.height}px;vertical-align:${cs.verticalAlign};flex-shrink:${cs.flexShrink};margin:${cs.margin};`;
      }
      d.setAttribute("style", style);
    });
    return copy;
  }
}

export function currentRoute(): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export async function captureWindow(opts: WindowCaptureOptions = {}): Promise<WindowCapture> {
  const started = performance.now();
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const defaults = new DefaultStyles();
  try {
    const doc = document.implementation.createHTMLDocument("capture");
    const cloner = new Cloner(doc, defaults, opts.maxElements ?? 9000);
    const html = cloner.clone(document.documentElement) as HTMLElement | null;
    if (!html) throw new Error("nothing to capture");
    const sx = window.scrollX;
    const sy = window.scrollY;
    html.setAttribute(
      "style",
      `${html.getAttribute("style") ?? ""}width:${vw}px;height:${vh}px;overflow:hidden;margin:0;${sx || sy ? `translate:${-sx}px ${-sy}px;` : ""}`,
    );
    html.setAttribute("xmlns", XHTML);
    const markup = new XMLSerializer().serializeToString(html);
    const svg =
      `<svg xmlns="${SVG_NS}" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
    const img = new Image();
    img.decoding = "sync";
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("capture render failed"));
    });
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await loaded;
    const scale = Math.min(1, (opts.maxWidth ?? 1280) / vw);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext("2d")!;
    const bg = getComputedStyle(document.body).backgroundColor;
    ctx.fillStyle = bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#0b0b0d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const quality = Math.min(1, Math.max(0.3, opts.quality ?? 0.78));
    return {
      dataUrl: canvas.toDataURL("image/jpeg", quality),
      width: canvas.width,
      height: canvas.height,
      viewportWidth: vw,
      viewportHeight: vh,
      route: currentRoute(),
      title: document.title,
      elements: cloner.count,
      truncated: cloner.truncated,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    defaults.dispose();
  }
}

/** Cheap read of where this window is — for listings and the mirror header. */
export function windowState(): Record<string, unknown> {
  return {
    route: currentRoute(),
    title: document.title,
    focused: document.hasFocus(),
    visible: document.visibilityState === "visible",
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}
