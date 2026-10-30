import { css, html, LitElement, nothing, unsafeCSS } from "lit";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  draggableOverlayStyles,
  makeDraggableOverlay,
  type DraggableOverlayHandle,
} from "../../../ui/src/ui/lib/draggable-overlay.js";
import { icon, type Dimensions, withGatewayToken } from "./shared.js";

export class PartScanViewer extends LitElement {
  static properties = {
    modelUrl: { attribute: "model-url" },
    dimensions: { attribute: false },
    floating: { type: Boolean, reflect: true },
    title: { type: String },
    autoRotate: { state: true },
    showDimensions: { state: true },
    loading: { state: true },
    error: { state: true },
  };

  declare modelUrl: string;
  declare dimensions: Dimensions | null;
  declare floating: boolean;
  declare title: string;
  declare autoRotate: boolean;
  declare showDimensions: boolean;
  declare loading: boolean;
  declare error: string;

  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private renderer?: THREE.WebGLRenderer;
  private controls?: OrbitControls;
  private model?: THREE.Object3D;
  private bounds?: THREE.Box3;
  private boundsHelper?: THREE.Box3Helper;
  private frame = 0;
  private resize?: ResizeObserver;
  private drag?: DraggableOverlayHandle;
  private loadedUrl = "";

  constructor() {
    super();
    this.modelUrl = "";
    this.dimensions = null;
    this.floating = false;
    this.title = "3D model";
    this.autoRotate = true;
    this.showDimensions = true;
    this.loading = true;
    this.error = "";
  }

  protected firstUpdated(): void {
    this.initScene();
    if (this.modelUrl) void this.loadModel();
    if (this.floating) {
      const shell = this.renderRoot.querySelector<HTMLElement>(".viewer-shell");
      const handle = this.renderRoot.querySelector<HTMLElement>(".viewer-head");
      if (shell) this.drag = makeDraggableOverlay(shell, "part-scan-viewer", { handle, persistSize: true });
    }
  }

  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("modelUrl") && this.renderer && this.modelUrl !== this.loadedUrl) void this.loadModel();
    if (this.boundsHelper) this.boundsHelper.visible = this.showDimensions;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    this.drag?.destroy();
    this.controls?.dispose();
    this.renderer?.dispose();
  }

  private initScene(): void {
    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>("canvas");
    const stage = this.renderRoot.querySelector<HTMLElement>(".stage");
    if (!canvas || !stage) return;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1017);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.0001, 1000);
    this.camera.position.set(0.08, 0.06, 0.08);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotateSpeed = 1.4;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x23314f, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.8);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x79a7ff, 1.2);
    fill.position.set(-4, 2, -3);
    this.scene.add(fill);
    const grid = new THREE.GridHelper(1, 20, 0x7b879d, 0x303846);
    grid.name = "measurement-grid";
    this.scene.add(grid);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0x10141d, roughness: 0.95, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.0002;
    floor.name = "floor";
    this.scene.add(floor);
    const resize = () => {
      if (!this.renderer || !this.camera) return;
      const width = Math.max(1, stage.clientWidth);
      const height = Math.max(1, stage.clientHeight);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
    };
    this.resize = new ResizeObserver(resize);
    this.resize.observe(stage);
    resize();
    const animate = () => {
      if (!this.renderer || !this.camera || !this.scene) return;
      this.controls!.autoRotate = this.autoRotate;
      this.controls!.update();
      this.updateLabels();
      this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(animate);
    };
    animate();
  }

  private async loadModel(): Promise<void> {
    if (!this.scene || !this.modelUrl) return;
    this.loading = true;
    this.error = "";
    const url = withGatewayToken(this.modelUrl);
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      if (this.model) this.scene.remove(this.model);
      if (this.boundsHelper) this.scene.remove(this.boundsHelper);
      this.model = gltf.scene;
      this.scene.add(this.model);
      this.bounds = new THREE.Box3().setFromObject(this.model);
      this.boundsHelper = new THREE.Box3Helper(this.bounds, new THREE.Color(0xf5c451));
      this.boundsHelper.visible = this.showDimensions;
      this.scene.add(this.boundsHelper);
      this.loadedUrl = this.modelUrl;
      this.fitView();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private fitView(): void {
    if (!this.bounds || !this.camera || !this.controls) return;
    const size = this.bounds.getSize(new THREE.Vector3());
    const center = this.bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.01);
    this.camera.position.copy(center).add(new THREE.Vector3(radius * 1.55, radius * 1.15, radius * 1.55));
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    const grid = this.scene?.getObjectByName("measurement-grid") as THREE.GridHelper | undefined;
    const floor = this.scene?.getObjectByName("floor") as THREE.Mesh | undefined;
    if (grid) {
      grid.scale.setScalar(Math.max(radius * 2.5, 0.05));
      grid.position.y = this.bounds.min.y;
    }
    if (floor) {
      floor.scale.setScalar(Math.max(radius * 3, 0.05));
      floor.position.y = this.bounds.min.y - radius * 0.006;
    }
  }

  private updateLabels(): void {
    const labels = [...this.renderRoot.querySelectorAll<HTMLElement>(".dim-label")];
    if (!this.showDimensions || !this.bounds || !this.camera || labels.length !== 3) return;
    const { min, max } = this.bounds;
    const anchors = [
      new THREE.Vector3((min.x + max.x) / 2, min.y, max.z),
      new THREE.Vector3(max.x, min.y, (min.z + max.z) / 2),
      new THREE.Vector3(max.x, (min.y + max.y) / 2, max.z),
    ];
    anchors.forEach((point, index) => {
      const projected = point.project(this.camera!);
      labels[index].style.left = `${(projected.x * 0.5 + 0.5) * 100}%`;
      labels[index].style.top = `${(-projected.y * 0.5 + 0.5) * 100}%`;
    });
  }

  private downloadModel(): void {
    const link = document.createElement("a");
    link.href = withGatewayToken(this.modelUrl);
    link.download = `${this.title.replace(/[^a-z0-9_-]+/gi, "-")}.glb`;
    link.click();
  }

  private downloadStl(): void {
    if (!this.model) return;
    const lines = ["solid part-scan"];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
    this.model.updateMatrixWorld(true);
    this.model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry;
      const positions = geometry.getAttribute("position");
      for (let i = 0; i + 2 < positions.count; i += 3) {
        a.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld).multiplyScalar(1000);
        b.fromBufferAttribute(positions, i + 1).applyMatrix4(object.matrixWorld).multiplyScalar(1000);
        c.fromBufferAttribute(positions, i + 2).applyMatrix4(object.matrixWorld).multiplyScalar(1000);
        normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
        lines.push(`facet normal ${normal.x} ${normal.y} ${normal.z}`, " outer loop");
        for (const point of [a, b, c]) lines.push(`  vertex ${point.x} ${point.y} ${point.z}`);
        lines.push(" endloop", "endfacet");
      }
      if (geometry !== object.geometry) geometry.dispose();
    });
    lines.push("endsolid part-scan");
    const href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "model/stl" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = `${this.title.replace(/[^a-z0-9_-]+/gi, "-")}.stl`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 2_000);
  }

  render() {
    const dims = this.dimensions?.orientedBboxMm;
    const values = dims ? [`${dims.length.toFixed(1)} mm`, `${dims.width.toFixed(1)} mm`, `${dims.height.toFixed(1)} mm`] : [];
    return html`<section class="viewer-shell ${this.floating ? "floating" : ""}" aria-label=${this.title}>
      <header class="viewer-head">
        <span class="viewer-title">${icon("cube", 16)} ${this.title}</span>
        <span class="spacer"></span>
        <button @click=${() => (this.autoRotate = !this.autoRotate)} aria-pressed=${this.autoRotate}>${this.autoRotate ? "Pause" : "Rotate"}</button>
        <button @click=${() => (this.showDimensions = !this.showDimensions)} aria-pressed=${this.showDimensions}>Dimensions</button>
        <button @click=${() => this.fitView()}>Reset</button>
      </header>
      <div class="stage">
        <canvas></canvas>
        ${this.showDimensions ? values.map((value) => html`<span class="dim-label">${value}</span>`) : nothing}
        ${this.loading ? html`<div class="loading">Loading model…</div>` : nothing}
        ${this.error ? html`<div class="viewer-error">${this.error}</div>` : nothing}
        <div class="axis" aria-hidden="true"><i class="x"></i><i class="y"></i><i class="z"></i></div>
      </div>
      <footer>
        <span>${this.dimensions?.scaleSource ?? "Metric scale unavailable"}</span>
        <span class="spacer"></span>
        <button @click=${() => this.downloadModel()}>${icon("download", 14)} GLB</button>
        <button @click=${() => this.downloadStl()}>${icon("download", 14)} STL</button>
      </footer>
    </section>`;
  }

  static styles = [
    unsafeCSS(draggableOverlayStyles),
    css`
      :host { display:block; min-width:0; }
      :host([floating]) { position:fixed; inset:0; pointer-events:none; z-index:50; }
      * { box-sizing:border-box; }
      button { border:1px solid var(--border); background:color-mix(in srgb,var(--surface-2,#222) 88%,transparent); color:var(--text); border-radius:7px; padding:5px 8px; cursor:pointer; font:inherit; font-size:11px; }
      button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
      .viewer-shell { overflow:hidden; border:1px solid var(--border); border-radius:16px; background:#0d1017; box-shadow:var(--shadow-md); min-height:480px; display:flex; flex-direction:column; }
      .viewer-shell.floating { position:fixed; right:24px; bottom:24px; width:min(720px,calc(100vw - 32px)); height:min(620px,calc(100vh - 48px)); pointer-events:auto; resize:both; min-width:360px; min-height:320px; }
      .viewer-head, footer { min-height:44px; display:flex; align-items:center; gap:7px; padding:7px 10px; background:color-mix(in srgb,#161b26 92%,transparent); color:#d9e1ed; border-bottom:1px solid #2b3340; }
      footer { border-top:1px solid #2b3340; border-bottom:0; font-size:10px; color:#8995a8; min-height:40px; }
      .viewer-title { display:inline-flex; align-items:center; gap:7px; font-weight:700; font-size:12px; }
      .spacer { flex:1; }
      .stage { position:relative; flex:1; min-height:360px; overflow:hidden; }
      canvas { width:100%; height:100%; display:block; }
      .loading, .viewer-error { position:absolute; inset:50% auto auto 50%; transform:translate(-50%,-50%); padding:9px 12px; border-radius:8px; background:#111827dd; color:#cbd5e1; font-size:12px; }
      .viewer-error { color:#fca5a5; max-width:80%; text-align:center; }
      .dim-label { position:absolute; transform:translate(-50%,-50%); padding:3px 6px; border:1px solid #f5c45199; border-radius:5px; background:#15120acc; color:#ffe7a3; font:600 10px ui-monospace,monospace; pointer-events:none; white-space:nowrap; }
      .axis { position:absolute; left:18px; bottom:18px; width:42px; height:42px; opacity:.8; }
      .axis i { position:absolute; left:8px; bottom:8px; width:25px; height:2px; transform-origin:left; }
      .axis .x { background:#f87171; transform:rotate(0deg); }.axis .y{background:#4ade80;transform:rotate(-90deg)}.axis .z{background:#60a5fa;transform:rotate(-35deg)}
      @media (max-width:600px) { .viewer-shell{min-height:400px}.viewer-head{flex-wrap:wrap}.viewer-title{width:100%}.stage{min-height:300px}footer>span:first-child{display:none} }
    `,
  ];
}

if (!customElements.get("part-scan-viewer")) customElements.define("part-scan-viewer", PartScanViewer);
