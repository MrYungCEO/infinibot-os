#!/usr/bin/env node
/**
 * Smoke for the UI Control surface helpers — currently focused on
 * `pickScrollTarget`, the picker behind `page.scroll_*`.
 *
 * Why this exists: voice flows like "scroll down" go through page.scroll_*
 * which used to call window.scrollBy unconditionally. Views like notes /
 * kanban / databases flex inside a non-scrolling shell with a tall inner
 * pane (`overflow: auto`), so window scrolling was a no-op. The picker
 * fixes that by falling through to the largest visible inner scroll
 * container when the body itself doesn't overflow.
 *
 * The function is pure DOM, so we mock just the minimum surface it
 * touches — no jsdom dependency.
 *
 * Run: node --import tsx scripts/ui-control-smoke.mts
 */

// ── Minimal DOM mock ─────────────────────────────────────────────────
//
// pickScrollTarget needs: window.{innerWidth,innerHeight,getComputedStyle},
// document.{documentElement.scrollHeight, body.{scrollHeight,querySelectorAll}}
// and per-element: getBoundingClientRect, getComputedStyle.overflowY,
// scrollHeight, clientHeight.

type MockRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

interface MockEl {
    scrollHeight: number;
    clientHeight: number;
    rect: MockRect;
    overflowY: string;
    tagName: string;
    className?: string;
}

function makeEl(props: Partial<MockEl> & Pick<MockEl, "scrollHeight" | "clientHeight" | "rect" | "overflowY">): MockEl & {
    getBoundingClientRect: () => MockRect;
} {
    return {
        tagName: "DIV",
        ...props,
        getBoundingClientRect: () => props.rect,
    };
}

function installMockDom(opts: {
    innerWidth: number;
    innerHeight: number;
    bodyScrollHeight: number;
    children: ReturnType<typeof makeEl>[];
}) {
    const { innerWidth, innerHeight, bodyScrollHeight, children } = opts;
    (globalThis as any).window = {
        innerWidth,
        innerHeight,
        getComputedStyle: (el: any) => ({ overflowY: el?.overflowY ?? "visible" }),
    };
    (globalThis as any).document = {
        documentElement: { scrollHeight: bodyScrollHeight },
        body: {
            scrollHeight: bodyScrollHeight,
            querySelectorAll: () => children,
        },
    };
}

function expect(label: string, cond: boolean, detail?: unknown) {
    if (cond) {
        console.log(`  ✓ ${label}`);
    } else {
        console.log(`  ✗ ${label}`, detail ?? "");
        throw new Error(`assertion failed: ${label}`);
    }
}

async function main() {
    // Import AFTER mocking — the helper guards `typeof window`/`typeof document`
    // but inner property access is what really matters.
    const { pickScrollTarget } = await import("../ui/src/ui/control-bus-helpers.ts");

    console.log("=== 1. window overflows → returns window ===");
    installMockDom({
        innerWidth: 1200,
        innerHeight: 800,
        bodyScrollHeight: 3000,
        children: [],
    });
    {
        const t = pickScrollTarget();
        expect("kind === window when document scrollHeight > viewport", t.kind === "window", t);
    }

    console.log("\n=== 2. body fits viewport, inner pane overflows → returns inner ===");
    // Simulates notes view: body = 800px (fits), inner .notes-preview is 800px
    // tall on screen but has scrollHeight 4000.
    const innerPreview = makeEl({
        tagName: "DIV",
        className: "notes-preview",
        scrollHeight: 4000,
        clientHeight: 700,
        overflowY: "auto",
        rect: { left: 280, top: 60, right: 1180, bottom: 760, width: 900, height: 700 },
    });
    installMockDom({
        innerWidth: 1200,
        innerHeight: 800,
        bodyScrollHeight: 800,
        children: [innerPreview],
    });
    {
        const t = pickScrollTarget();
        expect("kind === element when only an inner pane overflows", t.kind === "element", t);
        if (t.kind === "element") {
            expect("picks the .notes-preview pane", (t.element as any).className === "notes-preview", t.element);
        }
    }

    console.log("\n=== 3. multiple overflow candidates → picks largest area covering center ===");
    // Sidebar overflows but doesn't cover the viewport center; main pane does.
    const sidebar = makeEl({
        tagName: "ASIDE",
        className: "sidebar",
        scrollHeight: 2000,
        clientHeight: 700,
        overflowY: "auto",
        rect: { left: 0, top: 60, right: 240, bottom: 760, width: 240, height: 700 },
    });
    const mainPane = makeEl({
        tagName: "DIV",
        className: "main",
        scrollHeight: 5000,
        clientHeight: 700,
        overflowY: "scroll",
        rect: { left: 240, top: 60, right: 1200, bottom: 760, width: 960, height: 700 },
    });
    installMockDom({
        innerWidth: 1200,
        innerHeight: 800,
        bodyScrollHeight: 800,
        children: [sidebar, mainPane],
    });
    {
        const t = pickScrollTarget();
        expect("ignores sidebar that doesn't intersect viewport center", t.kind === "element", t);
        if (t.kind === "element") {
            expect("picks the main pane over the sidebar", (t.element as any).className === "main", t.element);
        }
    }

    console.log("\n=== 4. only-tiny-candidates rejected → falls back to window ===");
    // A 30x30 scroll container is too small to be the user's intent.
    const tiny = makeEl({
        tagName: "DIV",
        className: "mini-dropdown",
        scrollHeight: 500,
        clientHeight: 30,
        overflowY: "auto",
        rect: { left: 600, top: 400, right: 630, bottom: 430, width: 30, height: 30 },
    });
    installMockDom({
        innerWidth: 1200,
        innerHeight: 800,
        bodyScrollHeight: 800,
        children: [tiny],
    });
    {
        const t = pickScrollTarget();
        expect("kind === window when only sub-40px candidates exist", t.kind === "window", t);
    }

    console.log("\n=== 5. data-mb-editor attribute is recognized in findActiveEditor ===");
    // We can't easily import findActiveEditor without dragging Lit in, so
    // verify by inspection: the bus source must reference the attribute
    // selector in both the focused-walk path and the visible-scan path.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const busSrc = fs.readFileSync(
        path.join(process.cwd(), "ui/src/ui/control-bus-app-views.ts"),
        "utf-8",
    );
    expect(
        "bus source references data-mb-editor attribute",
        busSrc.includes('hasAttribute("data-mb-editor")') &&
            busSrc.includes('querySelectorAll("textarea[data-mb-editor]")'),
        "control-bus-app-views.ts is missing one of the data-mb-editor paths",
    );

    const notesView = fs.readFileSync(
        path.join(process.cwd(), "ui/src/ui/views/notes.ts"),
        "utf-8",
    );
    expect(
        "notes view stamps data-mb-editor on its raw textarea",
        notesView.includes('data-mb-editor="markdown"'),
        "ui/src/ui/views/notes.ts is missing data-mb-editor attribute on the textarea",
    );

    console.log("\nOK — UI control helpers + data-mb-editor wiring verified");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
