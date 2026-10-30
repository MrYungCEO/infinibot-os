import { css, html, LitElement, nothing, svg, type TemplateResult } from "lit";

import { errorText, icon, pageStyles, withGatewayToken, type Config, type Dimensions, type Job, type PartScanClient, type Scan, type ScanImage } from "./shared.js";
import "./viewer.js";

const SAMPLE_DIMS: Dimensions = {
  bboxMm: { length: 40, width: 20, height: 10 },
  orientedBboxMm: { length: 40, width: 20, height: 10 },
  surfaceAreaMm2: 2800,
  volumeMm3: 8000,
  watertight: true,
  scaleSource: "Bundled 40 × 20 × 10 mm verification fixture",
  reprojectionErrorPx: 0,
  scaleErrorMm: 0,
};

type Detail = { scan: Scan; images: ScanImage[]; config: Config };

export class PartScanPage extends LitElement {
  static properties = {
    client: { attribute: false },
    state: { attribute: false },
    scans: { state: true },
    config: { state: true },
    selected: { state: true },
    detail: { state: true },
    captureId: { state: true },
    devices: { state: true },
    deviceId: { state: true },
    cameraState: { state: true },
    error: { state: true },
    busy: { state: true },
    heightPass: { state: true },
    sector: { state: true },
    autoSeconds: { state: true },
    autoRemaining: { state: true },
    thumbs: { state: true },
    sharpness: { state: true },
  };

  declare client: PartScanClient | null;
  declare state: unknown;
  declare scans: Scan[];
  declare config: Config | null;
  declare selected: string;
  declare detail: Detail | null;
  declare captureId: string;
  declare devices: MediaDeviceInfo[];
  declare deviceId: string;
  declare cameraState: "idle" | "starting" | "live" | "unavailable";
  declare error: string;
  declare busy: boolean;
  declare heightPass: number;
  declare sector: number;
  declare autoSeconds: number;
  declare autoRemaining: number;
  declare thumbs: string[];
  declare sharpness: number;

  private loadedFor: PartScanClient | null = null;
  private stream: MediaStream | null = null;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe?: () => void;

  constructor() {
    super();
    this.client = null;
    this.state = null;
    this.scans = [];
    this.config = null;
    this.selected = "";
    this.detail = null;
    this.captureId = "";
    this.devices = [];
    this.deviceId = "";
    this.cameraState = "idle";
    this.error = "";
    this.busy = false;
    this.heightPass = 0;
    this.sector = 0;
    this.autoSeconds = 0;
    this.autoRemaining = 0;
    this.thumbs = [];
    this.sharpness = 0;
  }

  protected updated(): void {
    if (this.client && this.loadedFor !== this.client) {
      this.loadedFor = this.client;
      void this.load();
      this.unsubscribe = this.client.subscribe?.((event) => {
        if (event.event !== "partscan.job.progress") return;
        const payload = event.payload as { scanId?: string; job?: Job } | undefined;
        if (!payload?.scanId || !payload.job) return;
        this.scans = this.scans.map((scan) => scan.id === payload.scanId ? { ...scan, job: payload.job! } : scan);
        if (this.detail?.scan.id === payload.scanId) {
          this.detail = { ...this.detail, scan: { ...this.detail.scan, job: payload.job } };
          if (payload.job.status === "done") void this.openScan(payload.scanId);
        }
      });
    }
    const video = this.renderRoot.querySelector<HTMLVideoElement>("video");
    if (video && this.stream && video.srcObject !== this.stream) {
      video.srcObject = this.stream;
      void video.play().catch(() => undefined);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopCamera();
    this.unsubscribe?.();
  }

  private async load(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.request<{ scans: Scan[]; config: Config }>("partscan.list", {});
      this.scans = result.scans ?? [];
      this.config = result.config;
      const query = new URLSearchParams(location.search);
      const requested = query.get("scan");
      if (requested && this.scans.some((scan) => scan.id === requested)) await this.openScan(requested);
      else if (query.get("viewer") === "sample") this.selected = "sample";
    } catch (error) {
      this.error = errorText(error);
    }
    try {
      this.devices = (await navigator.mediaDevices?.enumerateDevices?.())?.filter((device) => device.kind === "videoinput") ?? [];
    } catch {
      this.devices = [];
    }
  }

  private async createScan(): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const name = `Part ${new Date().toLocaleString()}`;
      const scan = await this.client.request<Scan>("partscan.create", { name });
      this.scans = [scan, ...this.scans];
      this.captureId = scan.id;
      this.detail = { scan, images: [], config: this.config! };
      this.selected = scan.id;
      this.thumbs = [];
      this.sector = 0;
      this.heightPass = 0;
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private async openScan(id: string): Promise<void> {
    if (!this.client) return;
    this.selected = id;
    this.captureId = "";
    this.error = "";
    try {
      this.detail = await this.client.request<Detail>("partscan.get", { id });
    } catch (error) {
      this.error = errorText(error);
    }
  }

  private async deleteScan(id: string, event: Event): Promise<void> {
    event.stopPropagation();
    if (!this.client || !confirm("Delete this scan and all captured images?")) return;
    try {
      await this.client.request("partscan.delete", { id });
      this.scans = this.scans.filter((scan) => scan.id !== id);
      if (this.selected === id) {
        this.selected = "";
        this.detail = null;
      }
    } catch (error) {
      this.error = errorText(error);
    }
  }

  private async startCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.cameraState = "unavailable";
      this.error = "This browser does not expose camera capture. Use HTTPS or localhost and connect a camera.";
      return;
    }
    this.stopCamera();
    this.cameraState = "starting";
    this.error = "";
    try {
      const video: MediaTrackConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        facingMode: { ideal: "environment" },
      };
      if (this.deviceId) video.deviceId = { exact: this.deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const track = this.stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities() as MediaTrackCapabilities & Record<string, unknown>;
      const advanced: Record<string, unknown> = {};
      if ("focusMode" in capabilities) advanced.focusMode = "continuous";
      if ("exposureMode" in capabilities) advanced.exposureMode = "continuous";
      if ("whiteBalanceMode" in capabilities) advanced.whiteBalanceMode = "continuous";
      if (Object.keys(advanced).length) await track.applyConstraints({ advanced: [advanced] as MediaTrackConstraintSet[] }).catch(() => undefined);
      this.cameraState = "live";
      this.devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
      this.deviceId = track.getSettings().deviceId ?? this.deviceId;
      this.requestUpdate();
    } catch (error) {
      this.stream = null;
      this.cameraState = "unavailable";
      this.error = `Camera unavailable: ${errorText(error)}. You can still review existing scans and the sample model.`;
    }
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.cameraState === "live" || this.cameraState === "starting") this.cameraState = "idle";
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.autoRemaining = 0;
  }

  private frameSharpness(canvas: HTMLCanvasElement): number {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return 0;
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0, sumSquared = 0, count = 0;
    const gray = (index: number) => data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    for (let y = 1; y < height - 1; y += 2) {
      for (let x = 1; x < width - 1; x += 2) {
        const i = (y * width + x) * 4;
        const laplacian = 4 * gray(i) - gray(i - 4) - gray(i + 4) - gray(i - width * 4) - gray(i + width * 4);
        sum += laplacian;
        sumSquared += laplacian * laplacian;
        count++;
      }
    }
    const mean = sum / Math.max(1, count);
    return sumSquared / Math.max(1, count) - mean * mean;
  }

  private async capture(): Promise<void> {
    if (!this.client || !this.captureId || this.cameraState !== "live" || this.busy) return;
    const video = this.renderRoot.querySelector<HTMLVideoElement>("video");
    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>("canvas.capture-canvas");
    if (!video || !canvas || !video.videoWidth) return;
    this.busy = true;
    this.error = "";
    try {
      const scale = Math.min(1, 960 / video.videoWidth);
      canvas.width = Math.max(320, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(180, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      const sharpness = this.frameSharpness(canvas);
      this.sharpness = sharpness;
      if (sharpness < 80) throw new Error(`Frame rejected as blurry (${sharpness.toFixed(0)}; need at least 80). Hold still or add light.`);
      const base64 = canvas.toDataURL("image/jpeg", 0.94);
      const sequence = this.detail?.images.length ?? 0;
      const result = await this.client.request<{ image: ScanImage; scan: Scan }>("partscan.uploadImage", {
        id: this.captureId,
        base64,
        sequence,
        turntableAngle: this.sector * 10,
        heightPass: this.heightPass,
        sharpness,
      }, { timeoutMs: 30_000 });
      this.thumbs = [...this.thumbs, base64];
      this.detail = { ...this.detail!, scan: result.scan, images: [...(this.detail?.images ?? []), result.image] };
      this.scans = this.scans.map((scan) => scan.id === result.scan.id ? result.scan : scan);
      this.sector = (this.sector + 1) % 36;
      if (this.sector === 0 && this.heightPass < 2) this.heightPass++;
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private setAuto(seconds: number): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.autoSeconds = seconds;
    this.autoRemaining = seconds;
    if (!seconds) return;
    this.autoTimer = setInterval(() => {
      this.autoRemaining--;
      if (this.autoRemaining <= 0) {
        this.autoRemaining = seconds;
        void this.capture();
      }
    }, 1_000);
  }

  private async processScan(): Promise<void> {
    if (!this.client || !this.detail || this.busy) return;
    this.busy = true;
    this.stopCamera();
    try {
      const result = await this.client.request<{ scan: Scan }>("partscan.start", { id: this.detail.scan.id });
      this.detail = { ...this.detail, scan: result.scan };
      this.scans = this.scans.map((scan) => scan.id === result.scan.id ? result.scan : scan);
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
    }
  }

  private arc(index: number, pass: number): string {
    const radius = 34 + pass * 11;
    const start = (index * 10 - 88.5) * Math.PI / 180;
    const end = ((index + 1) * 10 - 91.5) * Math.PI / 180;
    const point = (angle: number) => [64 + radius * Math.cos(angle), 64 + radius * Math.sin(angle)];
    const a = point(start), b = point(end);
    return `M ${a[0].toFixed(2)} ${a[1].toFixed(2)} A ${radius} ${radius} 0 0 1 ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
  }

  private coverageRing(): TemplateResult {
    const images = this.detail?.images ?? [];
    const filled = new Set(images.map((image) => `${image.heightPass ?? 0}:${Math.round((image.turntableAngle ?? 0) / 10) % 36}`));
    return html`<svg class="coverage" viewBox="0 0 128 128" role="img" aria-label="Capture coverage: 36 sectors at three heights">
      ${[0, 1, 2].flatMap((pass) => Array.from({ length: 36 }, (_, sector) => svg`<path d=${this.arc(sector, pass)} class=${filled.has(`${pass}:${sector}`) ? "filled" : pass === this.heightPass && sector === this.sector ? "next" : ""}></path>`))}
      <text x="64" y="60">${images.length}</text><text x="64" y="73" class="sub">of 108</text>
    </svg>`;
  }

  private renderCapture(): TemplateResult {
    const images = this.detail?.images ?? [];
    return html`<section class="capture-grid">
      <div class="camera-card card">
        <div class="camera-stage ${this.cameraState}">
          ${this.cameraState === "live"
            ? html`<video muted playsinline></video>`
            : html`<div class="camera-empty">${icon("camera", 30)}<strong>${this.cameraState === "unavailable" ? "No camera available" : "Camera is off"}</strong><span>Connect a camera, then grant access. Existing scans and the sample viewer remain available without one.</span></div>`}
          <canvas class="capture-canvas" hidden></canvas>
          ${this.cameraState === "live" ? html`<span class="sharpness">Sharpness ${this.sharpness ? this.sharpness.toFixed(0) : "—"}</span>` : nothing}
        </div>
        <div class="camera-controls">
          <select .value=${this.deviceId} @change=${(event: Event) => { this.deviceId = (event.target as HTMLSelectElement).value; if (this.cameraState === "live") void this.startCamera(); }} aria-label="Camera device">
            <option value="">Default camera</option>
            ${this.devices.map((device, index) => html`<option value=${device.deviceId}>${device.label || `Camera ${index + 1}`}</option>`)}
          </select>
          ${this.cameraState === "live"
            ? html`<button class="btn" @click=${() => this.stopCamera()}>Stop camera</button>`
            : html`<button class="btn" @click=${() => this.startCamera()} ?disabled=${this.cameraState === "starting"}>${this.cameraState === "starting" ? "Starting…" : "Start camera"}</button>`}
          <select .value=${String(this.autoSeconds)} @change=${(event: Event) => this.setAuto(Number((event.target as HTMLSelectElement).value))} aria-label="Auto capture interval">
            <option value="0">Manual capture</option><option value="2">Auto every 2s</option><option value="3">Auto every 3s</option><option value="5">Auto every 5s</option>
          </select>
          <button class="btn primary shutter" @click=${() => this.capture()} ?disabled=${this.cameraState !== "live" || this.busy}>${icon("camera", 16)} ${this.autoSeconds ? `Capture · ${this.autoRemaining}s` : "Capture"}</button>
        </div>
      </div>
      <aside class="capture-side">
        <div class="card coverage-card">
          ${this.coverageRing()}
          <div><h3>Coverage</h3><p class="muted small">36 × 10° sectors · 3 height passes</p><div class="pass-row">${[0,1,2].map((pass) => html`<button class=${pass === this.heightPass ? "active" : ""} @click=${() => (this.heightPass = pass)}>Pass ${pass + 1}</button>`)}</div></div>
        </div>
        <div class="card board-card">
          <h3>Metric ChArUco mat</h3>
          <p class="muted small">${this.config?.boardCols} × ${this.config?.boardRows} · ${this.config?.markerSquareMm} mm squares · print at 100%.</p>
          <div class="row"><a class="btn ghost" href=${withGatewayToken("/plugins/part-scan/board.svg")} download>SVG</a><a class="btn ghost" href=${withGatewayToken("/plugins/part-scan/board.pdf")} download>PDF</a></div>
        </div>
        <button class="btn primary process" @click=${() => this.processScan()} ?disabled=${images.length < 3 || this.busy}>${icon("play", 15)} Process ${images.length} photos</button>
      </aside>
      <div class="thumbs card">${this.thumbs.length ? this.thumbs.map((url, index) => html`<figure><img src=${url} alt=${`Capture ${index + 1}`}><figcaption>${index + 1}</figcaption></figure>`) : html`<span class="muted small">Captured thumbnails appear here. Aim for 60–100 sharp photos.</span>`}</div>
    </section>`;
  }

  private renderViewer(scan?: Scan): TemplateResult {
    const sample = !scan;
    const dims = sample ? SAMPLE_DIMS : scan.dims ?? null;
    const model = sample ? "/plugins/part-scan/sample.glb" : `/plugins/part-scan/file?id=${encodeURIComponent(scan.id)}&file=model.glb`;
    return html`<div class="detail-stack">
      <div class="detail-head row">
        <button class="btn ghost" @click=${() => { this.selected = ""; this.detail = null; }}>← All scans</button>
        <div><h2>${sample ? "40 × 20 × 10 mm sample" : scan.name}</h2><p class="muted small">${sample ? "Bundled viewer verification fixture" : `${scan.imageCount} photos · ${scan.job.stage}`}</p></div>
      </div>
      <part-scan-viewer .modelUrl=${model} .dimensions=${dims} .title=${sample ? "Known-size sample" : scan.name}></part-scan-viewer>
      ${dims ? html`<div class="measurements">
        ${Object.entries(dims.orientedBboxMm).map(([label, value]) => html`<div class="card metric"><span>${label}</span><strong>${value.toFixed(2)} <small>mm</small></strong></div>`)}
        <div class="card metric"><span>Surface</span><strong>${dims.surfaceAreaMm2.toFixed(0)} <small>mm²</small></strong></div>
        <div class="card metric"><span>Volume</span><strong>${dims.volumeMm3 === null ? "Open mesh" : dims.volumeMm3.toFixed(0)} <small>${dims.volumeMm3 === null ? "" : "mm³"}</small></strong></div>
        <div class="card metric"><span>Scale RMS</span><strong>${dims.scaleErrorMm === null ? "—" : dims.scaleErrorMm.toFixed(3)} <small>mm</small></strong></div>
      </div>` : nothing}
    </div>`;
  }

  private renderProgress(scan: Scan): TemplateResult {
    return html`<section class="card progress-card">
      <div class="row"><span class="status-dot ${scan.job.status}"></span><div><h2>${scan.name}</h2><p class="muted small">${scan.job.stage}</p></div><span class="spacer"></span><strong>${Math.round(scan.job.progress * 100)}%</strong></div>
      <div class="bar"><i style=${`width:${scan.job.progress * 100}%`}></i></div>
      ${scan.job.error ? html`<div class="error">${scan.job.error}</div>` : nothing}
      ${scan.job.logTail?.length ? html`<pre>${scan.job.logTail.slice(-8).join("\n")}</pre>` : nothing}
      <div class="row"><button class="btn ghost" @click=${() => this.openScan(scan.id)}>${icon("refresh",14)} Refresh</button></div>
    </section>`;
  }

  private renderList(): TemplateResult {
    return html`<div class="scan-grid">
      <button class="scan-card card sample" @click=${() => (this.selected = "sample")}>
        <div class="sample-cube">40<span>×</span>20<span>×</span>10</div><div><strong>Known-size sample</strong><span>Verify viewer + dimension labels</span></div><span class="chip">GLB fixture</span>
      </button>
      ${this.scans.map((scan) => html`<button class="scan-card card" @click=${() => this.openScan(scan.id)}>
        <div class="scan-preview">${scan.previewReady ? html`<img src=${withGatewayToken(`/plugins/part-scan/file?id=${encodeURIComponent(scan.id)}&file=preview.png`)} alt="">` : icon("cube",28)}</div>
        <div class="scan-copy"><strong>${scan.name}</strong><span>${scan.imageCount} photos · ${new Date(scan.createdAt).toLocaleDateString()}</span><span class="job-line"><i class=${scan.job.status}></i>${scan.job.status} · ${scan.job.stage}</span></div>
        <button class="delete" title="Delete scan" @click=${(event: Event) => this.deleteScan(scan.id,event)}>${icon("trash",14)}</button>
      </button>`)}
    </div>`;
  }

  render() {
    const active = this.detail?.scan;
    return html`<div class="page" data-part-scan-page>
      <div class="head">
        <div><div class="eyebrow">Photogrammetry lab</div><h1>Part Scan</h1><p class="lede">Camera → metric reconstruction → color-textured 3D model. Capture around a printed ChArUco mat, then inspect or export GLB/STL.</p></div>
        <div class="row"><span class="chip">${this.config?.workerMode ?? "…"} worker</span><span class="chip">${this.config?.quality ?? "…"} quality</span><button class="btn primary" @click=${() => this.createScan()} ?disabled=${this.busy}>${icon("plus",15)} New scan</button></div>
      </div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.captureId && active ? this.renderCapture()
        : this.selected === "sample" ? this.renderViewer()
        : active?.modelReady ? this.renderViewer(active)
        : active && (active.job.status === "queued" || active.job.status === "processing" || active.job.status === "failed") ? this.renderProgress(active)
        : this.renderList()}
    </div>`;
  }

  static styles = [pageStyles, css`
    .scan-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.scan-card{position:relative;padding:12px;text-align:left;color:inherit;display:grid;grid-template-columns:74px 1fr auto;align-items:center;gap:12px;cursor:pointer;min-height:104px}.scan-card:hover{border-color:color-mix(in srgb,var(--accent) 55%,var(--border));transform:translateY(-1px)}.scan-preview{height:72px;border-radius:10px;background:var(--surface-2);display:grid;place-items:center;color:var(--accent);overflow:hidden}.scan-preview img{width:100%;height:100%;object-fit:cover}.scan-copy{display:flex;flex-direction:column;gap:5px;min-width:0}.scan-copy strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.scan-copy>span{font-size:11px;color:var(--muted)}.job-line{display:flex;align-items:center;gap:5px}.job-line i,.status-dot{width:7px;height:7px;border-radius:50%;background:var(--muted);display:inline-block}.job-line i.done,.status-dot.done{background:var(--success,#4ade80)}.job-line i.processing,.job-line i.queued,.status-dot.processing,.status-dot.queued{background:var(--accent);box-shadow:0 0 8px var(--accent)}.job-line i.failed,.status-dot.failed{background:var(--danger,#f87171)}.delete{position:absolute;top:7px;right:7px;border:0;background:transparent;color:var(--muted);padding:5px;cursor:pointer}.delete:hover{color:var(--danger,#f87171)}.scan-card.sample{background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 12%,var(--surface)),var(--surface));}.sample-cube{height:72px;border:1px solid color-mix(in srgb,var(--accent) 48%,var(--border));border-radius:10px;display:grid;place-items:center;color:var(--accent);font:700 16px ui-monospace,monospace;box-shadow:inset 10px 10px 24px color-mix(in srgb,var(--accent) 8%,transparent)}.sample-cube span{font-size:9px}.scan-card.sample>div:nth-child(2){display:flex;flex-direction:column;gap:5px}.scan-card.sample>div:nth-child(2) span{font-size:11px;color:var(--muted)}
    .capture-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(250px,.7fr);gap:12px}.camera-card{overflow:hidden}.camera-stage{aspect-ratio:16/9;background:#080a0f;position:relative;display:grid;place-items:center}.camera-stage video{width:100%;height:100%;object-fit:contain}.camera-empty{display:flex;flex-direction:column;align-items:center;gap:8px;color:#9aa6b8;text-align:center;max-width:420px;padding:28px}.camera-empty strong{color:#dce4ef}.camera-empty span{font-size:12px;line-height:1.5}.sharpness{position:absolute;top:10px;right:10px;background:#0b0e14cc;border:1px solid #394253;color:#d7e1ef;padding:5px 8px;border-radius:999px;font:10px ui-monospace,monospace}.camera-controls{padding:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.camera-controls select:first-child{flex:1;min-width:160px}.shutter{margin-left:auto}.capture-side{display:flex;flex-direction:column;gap:12px}.coverage-card{padding:12px;display:grid;grid-template-columns:128px 1fr;align-items:center;gap:8px}.coverage{width:128px;height:128px}.coverage path{fill:none;stroke:var(--border);stroke-width:6;stroke-linecap:round}.coverage path.filled{stroke:var(--success,#4ade80)}.coverage path.next{stroke:var(--accent);filter:drop-shadow(0 0 3px var(--accent))}.coverage text{text-anchor:middle;fill:var(--text-strong);font-size:19px;font-weight:700}.coverage text.sub{font-size:8px;fill:var(--muted);font-weight:400}.pass-row{display:flex;gap:4px;margin-top:10px;flex-wrap:wrap}.pass-row button{border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:6px;padding:4px 6px;font-size:10px;cursor:pointer}.pass-row button.active{border-color:var(--accent);color:var(--accent)}.board-card{padding:14px;display:flex;flex-direction:column;gap:8px}.board-card a{text-decoration:none}.process{width:100%;justify-content:center}.thumbs{grid-column:1/-1;padding:10px;display:flex;gap:8px;overflow:auto;min-height:72px;align-items:center}.thumbs figure{margin:0;position:relative;flex:0 0 86px;height:54px}.thumbs img{width:100%;height:100%;object-fit:cover;border-radius:7px}.thumbs figcaption{position:absolute;right:3px;bottom:3px;background:#000a;color:#fff;border-radius:4px;padding:1px 4px;font-size:9px}
    .detail-stack{display:flex;flex-direction:column;gap:12px}.detail-head{align-items:center}.detail-head h2{font-size:17px}.measurements{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px}.metric{padding:11px;display:flex;flex-direction:column;gap:5px}.metric span{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.metric strong{font-size:17px}.metric small{font-size:9px;color:var(--muted)}.progress-card{padding:18px;display:flex;flex-direction:column;gap:14px}.bar{height:9px;background:var(--surface-2);border-radius:999px;overflow:hidden}.bar i{height:100%;display:block;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 55%,white));border-radius:inherit;transition:width .3s}.progress-card pre{max-height:220px;overflow:auto;background:#090b10;color:#9eabc0;border-radius:9px;padding:10px;font:10px/1.5 ui-monospace,monospace;white-space:pre-wrap}
    @container (max-width:1000px){.scan-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.capture-grid{grid-template-columns:1fr}.measurements{grid-template-columns:repeat(3,1fr)}}@container (max-width:620px){.scan-grid{grid-template-columns:1fr}.scan-card{grid-template-columns:64px 1fr}.scan-card>.chip{display:none}.capture-grid{gap:9px}.coverage-card{grid-template-columns:110px 1fr}.coverage{width:110px;height:110px}.camera-controls>*{flex:1}.shutter{margin-left:0}.measurements{grid-template-columns:repeat(2,1fr)}}
  `];
}

if (!customElements.get("part-scan-page")) customElements.define("part-scan-page", PartScanPage);
