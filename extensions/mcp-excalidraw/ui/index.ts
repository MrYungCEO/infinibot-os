import { LitElement } from "lit";
import type { GatewayBrowserClient } from "../../../ui/src/ui/gateway";
import {
  applyTemplate, createWhiteboard, createWhiteboardState, deleteWhiteboard, exportToFile,
  importFromClipboard, importFromFile, loadTemplates, loadWhiteboard, loadWhiteboardList,
  renameWhiteboard, saveAsTemplate, saveWhiteboard, toggleTemplatePanel,
} from "./controller";
import { renderWhiteboard, unmountExcalidraw } from "./whiteboard";

class WhiteboardPluginView extends LitElement {
  static properties = { client: { attribute: false } };
  client: GatewayBrowserClient | null = null;
  private readonly whiteboardState = createWhiteboardState();
  private loaded = false;

  protected createRenderRoot(): HTMLElement | DocumentFragment { return this; }
  protected updated(): void {
    if (!this.loaded && this.client) {
      this.loaded = true;
      void Promise.all([loadWhiteboardList(this.app), loadTemplates(this.app)]);
    }
  }
  disconnectedCallback(): void { unmountExcalidraw(); super.disconnectedCallback(); }
  private get app() { return { client: this.client, whiteboardState: this.whiteboardState, requestUpdate: () => this.requestUpdate() }; }

  protected render() {
    const state = this.whiteboardState;
    return renderWhiteboard({
      state,
      app: this.app,
      onLoadList: () => loadWhiteboardList(this.app),
      onLoadBoard: (id) => { state.excalidrawLoaded = false; void loadWhiteboard(this.app, id); },
      onSaveBoard: (id, data, silent) => saveWhiteboard(this.app, id, data, silent),
      onCreateBoard: (name) => createWhiteboard(this.app, name),
      onDeleteBoard: (id) => deleteWhiteboard(this.app, id).then(() => undefined),
      onRenameBoard: (id, name) => renameWhiteboard(this.app, id, name).then(() => undefined),
      onBack: () => { unmountExcalidraw(); state.currentBoardId = null; state.currentBoardData = null; state.excalidrawLoaded = false; this.requestUpdate(); },
      onToggleTemplates: () => toggleTemplatePanel(this.app),
      onApplyTemplate: (id, name) => applyTemplate(this.app, id, name),
      onImportFile: (file) => importFromFile(this.app, file),
      onImportClipboard: () => importFromClipboard(this.app),
      onExport: () => exportToFile(this.app),
      onSaveAsTemplate: (name) => saveAsTemplate(this.app, name),
      requestUpdate: () => this.requestUpdate(),
    });
  }
}

if (!customElements.get("whiteboard-plugin-view")) customElements.define("whiteboard-plugin-view", WhiteboardPluginView);
