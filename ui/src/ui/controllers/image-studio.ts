/**
 * Image Studio Controller
 * 
 * Handles image processing operations: crop, upscale, background removal
 * Manages processing queue and federation node routing
 */

import type { GatewayBrowserClient } from "../gateway.js";
import type { AppViewState } from "../app-view-state.js";

// ── Types ─────────────────────────────────────────────────

export type ImageTool = "crop" | "upscale" | "remove-bg" | "batch" | "generate";
export type AspectRatio = "free" | "1:1" | "16:9" | "4:3" | "9:16" | "3:4";
export type UpscaleModel = "real-esrgan" | "lanczos" | "nvenc";
export type UpscaleScale = 2 | 4;
export type JobStatus = "pending" | "processing" | "complete" | "error" | "cancelled";

export interface ImageFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  dataUrl: string;
  width: number;
  height: number;
  thumbnail?: string;
  addedAt: number;
}

export interface CropSettings {
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio: AspectRatio;
}

export interface UpscaleSettings {
  scale: UpscaleScale;
  model: UpscaleModel;
}

// ── AI Generation Types ───────────────────────────────────

export type GenerationAspectRatio = "1:1" | "2:3" | "3:2" | "16:9" | "9:16" | "21:9";
export type GenerationQuality = "draft" | "standard" | "high" | "ultra";

export interface GenerationModel {
  id: string;
  name: string;
  type: string;
  description: string;
  supports_img2img: boolean;
  supports_inpaint: boolean;
  vram_gb: number;
}

export interface GenerationSettings {
  prompt: string;
  negativePrompt: string;
  model: string;
  aspectRatio: GenerationAspectRatio;
  quality: GenerationQuality;
  seed: number;
  batchSize: number;
}

export interface GenerationJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  model: string;
  created_at: string;
  output?: {
    images?: Array<{ url: string; filename: string; width: number; height: number }>;
    url?: string;
    seed?: number;
    dimensions?: string;
  };
  error?: string;
  timing?: { inference_time_ms: number };
}

export interface ProcessedImage {
  id: string;
  sourceId: string;
  sourceName: string;
  tool: ImageTool;
  dataUrl: string;
  width: number;
  height: number;
  processedAt: number;
  processingTime: number;
  nodeId?: string;
  settings?: Record<string, any>;
}

export interface ProcessingJob {
  id: string;
  sourceId: string;
  sourceName: string;
  tool: ImageTool;
  settings: Record<string, any>;
  status: JobStatus;
  progress: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  resultId?: string;
  nodeId?: string;
}

export interface ImageStudioState {
  // Uploaded images
  images: ImageFile[];
  selectedImageId: string | null;
  dragOver: boolean;
  
  // Current tool
  activeTool: ImageTool;
  
  // Crop tool settings
  cropSettings: CropSettings;
  cropPreview: { dataUrl: string; width: number; height: number } | null;
  
  // Upscale tool settings
  upscaleSettings: UpscaleSettings;
  
  // Processing queue
  jobs: ProcessingJob[];
  
  // Processed results
  results: ProcessedImage[];
  
  // Preview state
  previewMode: "before" | "after" | "compare";
  comparePosition: number; // 0-100 slider position
  zoomLevel: number;
  
  // Federation
  selectedNodeId: string | null;
  availableNodes: { id: string; name: string; hasGpu: boolean }[];
  
  // Batch mode
  batchMode: boolean;
  batchOperations: { tool: ImageTool; settings: Record<string, any> }[];
  
  // AI Generation
  generationSettings: GenerationSettings;
  generationModels: GenerationModel[];
  generationJobs: GenerationJob[];
  generationServerUrl: string;
  generationServerHealthy: boolean;
  serverStarting: boolean;
  
  // UI state
  loading: boolean;
  error: string | null;
  showGallery: boolean;
}

// ── Initial State ─────────────────────────────────────────

export function createInitialImageStudioState(): ImageStudioState {
  return {
    images: [],
    selectedImageId: null,
    dragOver: false,
    
    activeTool: "generate",
    
    cropSettings: {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      aspectRatio: "free",
    },
    cropPreview: null,
    
    upscaleSettings: {
      scale: 2,
      model: "real-esrgan",
    },
    
    jobs: [],
    results: [],
    
    previewMode: "before",
    comparePosition: 50,
    zoomLevel: 100,
    
    selectedNodeId: null,
    availableNodes: [],
    
    batchMode: false,
    batchOperations: [],
    
    // AI Generation defaults
    generationSettings: {
      prompt: "",
      negativePrompt: "blurry, low quality, ugly, deformed",
      model: "",
      aspectRatio: "1:1",
      quality: "standard",
      seed: -1,
      batchSize: 1,
    },
    generationModels: [],
    generationJobs: [],
    generationServerUrl: "http://localhost:8899",
    generationServerHealthy: false,
    serverStarting: false,
    
    loading: false,
    error: null,
    showGallery: false,
  };
}

// ── State Accessor ────────────────────────────────────────

export function getImageStudioState(state: AppViewState): ImageStudioState {
  if (!(state as any).imageStudioState) {
    (state as any).imageStudioState = createInitialImageStudioState();
  }
  return (state as any).imageStudioState;
}

// ── Helpers ───────────────────────────────────────────────

function generateId(): string {
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function createThumbnail(dataUrl: string, maxSize = 200): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      
      let width = img.width;
      let height = img.height;
      
      if (width > height) {
        if (width > maxSize) {
          height = (height * maxSize) / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width = (width * maxSize) / height;
          height = maxSize;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function dataUrlToBase64(dataUrl: string): string {
  // Remove data:image/...;base64, prefix
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function base64ToDataUrl(base64: string, mimeType = "image/png"): string {
  return `data:${mimeType};base64,${base64}`;
}

// ── Image Management ──────────────────────────────────────

export async function addImage(
  state: AppViewState,
  file: File
): Promise<ImageFile | null> {
  const studio = getImageStudioState(state);
  
  if (!file.type.startsWith("image/")) {
    studio.error = "Only image files are supported";
    return null;
  }
  
  try {
    const dataUrl = await fileToDataUrl(file);
    const dimensions = await getImageDimensions(dataUrl);
    const thumbnail = await createThumbnail(dataUrl);
    
    const imageFile: ImageFile = {
      id: generateId(),
      file,
      name: file.name,
      size: file.size,
      type: file.type,
      dataUrl,
      width: dimensions.width,
      height: dimensions.height,
      thumbnail,
      addedAt: Date.now(),
    };
    
    studio.images.push(imageFile);
    
    // Auto-select first image
    if (studio.images.length === 1) {
      studio.selectedImageId = imageFile.id;
      // Initialize crop to full image
      studio.cropSettings = {
        x: 0,
        y: 0,
        width: dimensions.width,
        height: dimensions.height,
        aspectRatio: "free",
      };
    }
    
    studio.error = null;
    state.requestUpdate?.();
    return imageFile;
  } catch (err) {
    studio.error = `Failed to load image: ${(err as Error).message}`;
    state.requestUpdate?.();
    return null;
  }
}

export async function addImages(
  state: AppViewState,
  files: FileList | File[]
): Promise<void> {
  const studio = getImageStudioState(state);
  studio.loading = true;
  state.requestUpdate?.();
  
  for (const file of Array.from(files)) {
    await addImage(state, file);
  }
  
  studio.loading = false;
  state.requestUpdate?.();
}

export function removeImage(state: AppViewState, imageId: string): void {
  const studio = getImageStudioState(state);
  const index = studio.images.findIndex(img => img.id === imageId);
  
  if (index !== -1) {
    studio.images.splice(index, 1);
    
    // Update selection
    if (studio.selectedImageId === imageId) {
      studio.selectedImageId = studio.images[0]?.id ?? null;
    }
    
    state.requestUpdate?.();
  }
}

export function selectImage(state: AppViewState, imageId: string): void {
  const studio = getImageStudioState(state);
  const image = studio.images.find(img => img.id === imageId);
  
  if (image) {
    studio.selectedImageId = imageId;
    
    // Reset crop to full image
    studio.cropSettings = {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
      aspectRatio: "free",
    };
    studio.cropPreview = null;
    
    state.requestUpdate?.();
  }
}

export function clearImages(state: AppViewState): void {
  const studio = getImageStudioState(state);
  studio.images = [];
  studio.selectedImageId = null;
  studio.cropPreview = null;
  state.requestUpdate?.();
}

// ── Tool Selection ────────────────────────────────────────

export function setActiveTool(state: AppViewState, tool: ImageTool): void {
  const studio = getImageStudioState(state);
  studio.activeTool = tool;
  state.requestUpdate?.();
}

// ── Crop Tool ─────────────────────────────────────────────

export function updateCropSettings(
  state: AppViewState,
  settings: Partial<CropSettings>
): void {
  const studio = getImageStudioState(state);
  studio.cropSettings = { ...studio.cropSettings, ...settings };
  state.requestUpdate?.();
}

export function setAspectRatio(state: AppViewState, ratio: AspectRatio): void {
  const studio = getImageStudioState(state);
  const image = studio.images.find(img => img.id === studio.selectedImageId);
  
  if (!image) return;
  
  studio.cropSettings.aspectRatio = ratio;
  
  if (ratio !== "free") {
    // Adjust crop box to match aspect ratio
    const [w, h] = ratio.split(":").map(Number);
    const aspectRatio = w / h;
    
    let newWidth = studio.cropSettings.width;
    let newHeight = studio.cropSettings.height;
    
    if (newWidth / newHeight > aspectRatio) {
      newWidth = newHeight * aspectRatio;
    } else {
      newHeight = newWidth / aspectRatio;
    }
    
    // Ensure it fits within image bounds
    if (newWidth > image.width) {
      newWidth = image.width;
      newHeight = newWidth / aspectRatio;
    }
    if (newHeight > image.height) {
      newHeight = image.height;
      newWidth = newHeight * aspectRatio;
    }
    
    // Center the crop box
    studio.cropSettings.width = Math.floor(newWidth);
    studio.cropSettings.height = Math.floor(newHeight);
    studio.cropSettings.x = Math.floor((image.width - newWidth) / 2);
    studio.cropSettings.y = Math.floor((image.height - newHeight) / 2);
  }
  
  state.requestUpdate?.();
}

export async function generateCropPreview(state: AppViewState): Promise<void> {
  const studio = getImageStudioState(state);
  const image = studio.images.find(img => img.id === studio.selectedImageId);
  
  if (!image) return;
  
  const { x, y, width, height } = studio.cropSettings;
  
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = image.dataUrl;
  });
  
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
  
  studio.cropPreview = {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
  };
  
  state.requestUpdate?.();
}

// ── Upscale Tool ──────────────────────────────────────────

export function setUpscaleSettings(
  state: AppViewState,
  settings: Partial<UpscaleSettings>
): void {
  const studio = getImageStudioState(state);
  studio.upscaleSettings = { ...studio.upscaleSettings, ...settings };
  state.requestUpdate?.();
}

// ── Preview Controls ──────────────────────────────────────

export function setPreviewMode(
  state: AppViewState,
  mode: "before" | "after" | "compare"
): void {
  const studio = getImageStudioState(state);
  studio.previewMode = mode;
  state.requestUpdate?.();
}

export function setComparePosition(state: AppViewState, position: number): void {
  const studio = getImageStudioState(state);
  studio.comparePosition = Math.max(0, Math.min(100, position));
  state.requestUpdate?.();
}

export function setZoomLevel(state: AppViewState, zoom: number): void {
  const studio = getImageStudioState(state);
  studio.zoomLevel = Math.max(10, Math.min(400, zoom));
  state.requestUpdate?.();
}

// ── Federation ────────────────────────────────────────────

export function setSelectedNode(state: AppViewState, nodeId: string | null): void {
  const studio = getImageStudioState(state);
  studio.selectedNodeId = nodeId;
  state.requestUpdate?.();
}

export async function loadAvailableNodes(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  const studio = getImageStudioState(state);
  
  try {
    // Try to get federation nodes with GPU capabilities
    const result = await client.request("federation.nodes.list", {});
    
    if (result && Array.isArray((result as any).nodes)) {
      studio.availableNodes = (result as any).nodes.map((node: any) => ({
        id: node.id,
        name: node.name || node.id,
        hasGpu: node.capabilities?.gpu ?? false,
      }));
    }
  } catch (err) {
    // Federation not available, use local processing
    studio.availableNodes = [
      { id: "local", name: "Local (Master)", hasGpu: true },
    ];
  }
  
  state.requestUpdate?.();
}

// ── Processing Queue ──────────────────────────────────────

export function addJob(
  state: AppViewState,
  sourceId: string,
  tool: ImageTool,
  settings: Record<string, any>
): ProcessingJob {
  const studio = getImageStudioState(state);
  const image = studio.images.find(img => img.id === sourceId);
  
  const job: ProcessingJob = {
    id: generateId(),
    sourceId,
    sourceName: image?.name ?? "Unknown",
    tool,
    settings,
    status: "pending",
    progress: 0,
    nodeId: studio.selectedNodeId ?? undefined,
  };
  
  studio.jobs.push(job);
  state.requestUpdate?.();
  
  return job;
}

export function updateJobStatus(
  state: AppViewState,
  jobId: string,
  status: JobStatus,
  progress?: number,
  error?: string
): void {
  const studio = getImageStudioState(state);
  const job = studio.jobs.find(j => j.id === jobId);
  
  if (job) {
    job.status = status;
    if (progress !== undefined) job.progress = progress;
    if (error !== undefined) job.error = error;
    if (status === "processing" && !job.startedAt) job.startedAt = Date.now();
    if (status === "complete" || status === "error") job.completedAt = Date.now();
    state.requestUpdate?.();
  }
}

export function cancelJob(state: AppViewState, jobId: string): void {
  const studio = getImageStudioState(state);
  const job = studio.jobs.find(j => j.id === jobId);
  
  if (job && (job.status === "pending" || job.status === "processing")) {
    job.status = "cancelled";
    job.completedAt = Date.now();
    state.requestUpdate?.();
  }
}

export function clearCompletedJobs(state: AppViewState): void {
  const studio = getImageStudioState(state);
  studio.jobs = studio.jobs.filter(
    j => j.status === "pending" || j.status === "processing"
  );
  state.requestUpdate?.();
}

// ── Results Management ────────────────────────────────────

export function addResult(
  state: AppViewState,
  sourceId: string,
  tool: ImageTool,
  dataUrl: string,
  width: number,
  height: number,
  processingTime: number,
  settings?: Record<string, any>,
  nodeId?: string
): ProcessedImage {
  const studio = getImageStudioState(state);
  const sourceImage = studio.images.find(img => img.id === sourceId);
  
  const result: ProcessedImage = {
    id: generateId(),
    sourceId,
    sourceName: sourceImage?.name ?? "Unknown",
    tool,
    dataUrl,
    width,
    height,
    processedAt: Date.now(),
    processingTime,
    nodeId,
    settings,
  };
  
  studio.results.push(result);
  state.requestUpdate?.();
  
  return result;
}

export function removeResult(state: AppViewState, resultId: string): void {
  const studio = getImageStudioState(state);
  const index = studio.results.findIndex(r => r.id === resultId);
  
  if (index !== -1) {
    studio.results.splice(index, 1);
    state.requestUpdate?.();
  }
}

export function clearResults(state: AppViewState): void {
  const studio = getImageStudioState(state);
  studio.results = [];
  state.requestUpdate?.();
}

// ── Gateway Processing Calls ──────────────────────────────

export async function processCrop(
  state: AppViewState,
  client: GatewayBrowserClient,
  imageId: string
): Promise<ProcessedImage | null> {
  const studio = getImageStudioState(state);
  const image = studio.images.find(img => img.id === imageId);
  
  if (!image) return null;
  
  const { x, y, width, height } = studio.cropSettings;
  const job = addJob(state, imageId, "crop", { x, y, width, height });
  
  try {
    updateJobStatus(state, job.id, "processing", 10);
    const startTime = Date.now();
    
    const base64Input = dataUrlToBase64(image.dataUrl);
    
    // Gateway call (stubbed for now)
    let resultBase64: string;
    try {
      const response = await client.request("media.image.crop", {
        input: base64Input,
        x,
        y,
        width,
        height,
        nodeId: studio.selectedNodeId,
      });
      resultBase64 = (response as any).output ?? (response as any).result;
    } catch (err) {
      // Fallback to local processing
      console.log("Gateway crop not available, using local processing");
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = image.dataUrl;
      });
      
      ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
      resultBase64 = dataUrlToBase64(canvas.toDataURL("image/png"));
    }
    
    updateJobStatus(state, job.id, "processing", 80);
    
    const resultDataUrl = base64ToDataUrl(resultBase64, "image/png");
    const processingTime = Date.now() - startTime;
    
    const result = addResult(
      state,
      imageId,
      "crop",
      resultDataUrl,
      width,
      height,
      processingTime,
      { x, y, width, height },
      studio.selectedNodeId ?? undefined
    );
    
    job.resultId = result.id;
    updateJobStatus(state, job.id, "complete", 100);
    
    return result;
  } catch (err) {
    updateJobStatus(state, job.id, "error", 0, (err as Error).message);
    return null;
  }
}

export async function processUpscale(
  state: AppViewState,
  client: GatewayBrowserClient,
  imageId: string
): Promise<ProcessedImage | null> {
  const studio = getImageStudioState(state);
  const image = studio.images.find(img => img.id === imageId);
  
  if (!image) return null;
  
  const { scale, model } = studio.upscaleSettings;
  const job = addJob(state, imageId, "upscale", { scale, model });
  
  try {
    updateJobStatus(state, job.id, "processing", 10);
    const startTime = Date.now();
    
    const base64Input = dataUrlToBase64(image.dataUrl);
    
    // Gateway call
    let resultBase64: string;
    let newWidth = image.width * scale;
    let newHeight = image.height * scale;
    
    try {
      const response = await client.request("media.image.upscale", {
        input: base64Input,
        scale,
        model,
        nodeId: studio.selectedNodeId,
      });
      resultBase64 = (response as any).output ?? (response as any).result;
      if ((response as any).width) newWidth = (response as any).width;
      if ((response as any).height) newHeight = (response as any).height;
    } catch (err) {
      // Fallback to basic browser upscale (not as good as Real-ESRGAN)
      console.log("Gateway upscale not available, using basic upscale");
      const canvas = document.createElement("canvas");
      canvas.width = newWidth;
      canvas.height = newHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = image.dataUrl;
      });
      
      ctx.drawImage(img, 0, 0, newWidth, newHeight);
      resultBase64 = dataUrlToBase64(canvas.toDataURL("image/png"));
    }
    
    updateJobStatus(state, job.id, "processing", 80);
    
    const resultDataUrl = base64ToDataUrl(resultBase64, "image/png");
    const processingTime = Date.now() - startTime;
    
    const result = addResult(
      state,
      imageId,
      "upscale",
      resultDataUrl,
      newWidth,
      newHeight,
      processingTime,
      { scale, model },
      studio.selectedNodeId ?? undefined
    );
    
    job.resultId = result.id;
    updateJobStatus(state, job.id, "complete", 100);
    
    return result;
  } catch (err) {
    updateJobStatus(state, job.id, "error", 0, (err as Error).message);
    return null;
  }
}

export async function processRemoveBg(
  state: AppViewState,
  client: GatewayBrowserClient,
  imageId: string
): Promise<ProcessedImage | null> {
  const studio = getImageStudioState(state);
  const image = studio.images.find(img => img.id === imageId);
  
  if (!image) return null;
  
  const job = addJob(state, imageId, "remove-bg", {});
  
  try {
    updateJobStatus(state, job.id, "processing", 10);
    const startTime = Date.now();
    
    const base64Input = dataUrlToBase64(image.dataUrl);
    
    // Gateway call
    let resultBase64: string;
    
    try {
      const response = await client.request("media.image.removeBg", {
        input: base64Input,
        nodeId: studio.selectedNodeId,
      });
      resultBase64 = (response as any).output ?? (response as any).result;
    } catch (err) {
      throw new Error("Background removal requires the gateway service with rembg support");
    }
    
    updateJobStatus(state, job.id, "processing", 80);
    
    const resultDataUrl = base64ToDataUrl(resultBase64, "image/png");
    const processingTime = Date.now() - startTime;
    
    const result = addResult(
      state,
      imageId,
      "remove-bg",
      resultDataUrl,
      image.width,
      image.height,
      processingTime,
      {},
      studio.selectedNodeId ?? undefined
    );
    
    job.resultId = result.id;
    updateJobStatus(state, job.id, "complete", 100);
    
    return result;
  } catch (err) {
    updateJobStatus(state, job.id, "error", 0, (err as Error).message);
    return null;
  }
}

export async function processBatch(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<ProcessedImage[]> {
  const studio = getImageStudioState(state);
  const results: ProcessedImage[] = [];
  
  if (studio.batchOperations.length === 0) {
    studio.error = "No batch operations configured";
    state.requestUpdate?.();
    return results;
  }
  
  for (const image of studio.images) {
    for (const op of studio.batchOperations) {
      let result: ProcessedImage | null = null;
      
      switch (op.tool) {
        case "crop":
          // Use current crop settings for batch
          result = await processCrop(state, client, image.id);
          break;
        case "upscale":
          result = await processUpscale(state, client, image.id);
          break;
        case "remove-bg":
          result = await processRemoveBg(state, client, image.id);
          break;
      }
      
      if (result) {
        results.push(result);
      }
    }
  }
  
  return results;
}

// ── Batch Mode ────────────────────────────────────────────

export function toggleBatchMode(state: AppViewState): void {
  const studio = getImageStudioState(state);
  studio.batchMode = !studio.batchMode;
  if (!studio.batchMode) {
    studio.batchOperations = [];
  }
  state.requestUpdate?.();
}

export function addBatchOperation(
  state: AppViewState,
  tool: ImageTool,
  settings: Record<string, any>
): void {
  const studio = getImageStudioState(state);
  studio.batchOperations.push({ tool, settings });
  state.requestUpdate?.();
}

export function removeBatchOperation(state: AppViewState, index: number): void {
  const studio = getImageStudioState(state);
  studio.batchOperations.splice(index, 1);
  state.requestUpdate?.();
}

export function clearBatchOperations(state: AppViewState): void {
  const studio = getImageStudioState(state);
  studio.batchOperations = [];
  state.requestUpdate?.();
}

// ── Gallery ───────────────────────────────────────────────

export function toggleGallery(state: AppViewState): void {
  const studio = getImageStudioState(state);
  studio.showGallery = !studio.showGallery;
  state.requestUpdate?.();
}

// ── Download Functions ────────────────────────────────────

export function downloadResult(result: ProcessedImage): void {
  const link = document.createElement("a");
  link.href = result.dataUrl;
  
  // Generate filename
  const ext = result.dataUrl.includes("image/png") ? "png" : "jpg";
  const toolSuffix = result.tool === "remove-bg" ? "nobg" : result.tool;
  link.download = `${result.sourceName.replace(/\.[^.]+$/, "")}_${toolSuffix}.${ext}`;
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function downloadAllAsZip(results: ProcessedImage[]): Promise<void> {
  if (results.length === 0) return;
  
  // Dynamic import JSZip (assuming it's available or will be added)
  try {
    const JSZip = (window as any).JSZip ?? (await import("jszip" as any)).default;
    const zip = new JSZip();
    
    for (const result of results) {
      const ext = result.dataUrl.includes("image/png") ? "png" : "jpg";
      const toolSuffix = result.tool === "remove-bg" ? "nobg" : result.tool;
      const filename = `${result.sourceName.replace(/\.[^.]+$/, "")}_${toolSuffix}.${ext}`;
      
      // Convert data URL to blob
      const base64 = dataUrlToBase64(result.dataUrl);
      zip.file(filename, base64, { base64: true });
    }
    
    const blob = await zip.generateAsync({ type: "blob" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `processed_images_${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  } catch (err) {
    console.error("Failed to create ZIP:", err);
    // Fallback: download individually
    for (const result of results) {
      downloadResult(result);
    }
  }
}

// ══════════════════════════════════════════════════════════
// AI GENERATION (Local ComfyUI Server)
// ══════════════════════════════════════════════════════════

/**
 * Check if the local image generation server is healthy
 */
export async function checkGenerationServer(state: AppViewState): Promise<boolean> {
  const studio = getImageStudioState(state);
  
  try {
    const resp = await fetch(`${studio.generationServerUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    
    if (resp.ok) {
      studio.generationServerHealthy = true;
      state.requestUpdate?.();
      return true;
    }
  } catch (err) {
    console.warn("Generation server not reachable:", err);
  }
  
  studio.generationServerHealthy = false;
  state.requestUpdate?.();
  return false;
}

/**
 * Start the image generation server via federation services
 */
export async function startImageServer(state: AppViewState): Promise<boolean> {
  const studio = getImageStudioState(state);
  studio.serverStarting = true;
  studio.error = null;
  state.requestUpdate?.();

  try {
    const client = state.gatewayClient;
    if (!client) throw new Error("Gateway client not available");

    // Call services.start for the image-api service
    const result = await client.request("services.start", {
      serviceId: "image-api",
      waitForHealthy: true,
      timeoutMs: 60000, // Give it time to start
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to start image server");
    }

    // Server started successfully - check health and load models
    studio.generationServerHealthy = true;
    await loadGenerationModels(state);
    
    return true;
  } catch (err) {
    console.error("[ImageStudio] Failed to start server:", err);
    studio.error = `Failed to start server: ${err instanceof Error ? err.message : String(err)}`;
    studio.generationServerHealthy = false;
    return false;
  } finally {
    studio.serverStarting = false;
    state.requestUpdate?.();
  }
}

/**
 * Load available models from the generation server
 */
export async function loadGenerationModels(state: AppViewState): Promise<GenerationModel[]> {
  const studio = getImageStudioState(state);
  
  try {
    const resp = await fetch(`${studio.generationServerUrl}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    
    if (resp.ok) {
      const models: GenerationModel[] = await resp.json();
      studio.generationModels = models;
      studio.generationServerHealthy = true;
      
      // Auto-select first model if none selected
      if (!studio.generationSettings.model && models.length > 0) {
        // Prefer RealVis or flux-dev-fp8
        const preferred = models.find(m => 
          m.id.includes("RealVis") || 
          m.id.includes("flux") || 
          m.id.includes("v1-5")
        );
        studio.generationSettings.model = preferred?.id || models[0].id;
      }
      
      state.requestUpdate?.();
      return models;
    }
  } catch (err) {
    console.error("Failed to load generation models:", err);
    studio.generationServerHealthy = false;
    studio.error = "Cannot connect to image generation server";
  }
  
  state.requestUpdate?.();
  return [];
}

/**
 * Update generation settings
 */
export function updateGenerationSettings(
  state: AppViewState,
  updates: Partial<GenerationSettings>
): void {
  const studio = getImageStudioState(state);
  studio.generationSettings = { ...studio.generationSettings, ...updates };
  state.requestUpdate?.();
}

/**
 * Generate an image using the local ComfyUI server
 */
export async function generateImage(state: AppViewState): Promise<GenerationJob | null> {
  const studio = getImageStudioState(state);
  
  if (!studio.generationSettings.prompt.trim()) {
    studio.error = "Please enter a prompt";
    state.requestUpdate?.();
    return null;
  }
  
  if (!studio.generationSettings.model) {
    studio.error = "Please select a model";
    state.requestUpdate?.();
    return null;
  }
  
  studio.loading = true;
  studio.error = null;
  state.requestUpdate?.();
  
  try {
    // Use sync endpoint for immediate results
    const resp = await fetch(`${studio.generationServerUrl}/v1/generate/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: studio.generationSettings.prompt,
        negative_prompt: studio.generationSettings.negativePrompt,
        model: studio.generationSettings.model,
        aspect_ratio: studio.generationSettings.aspectRatio,
        quality: studio.generationSettings.quality,
        seed: studio.generationSettings.seed > 0 ? studio.generationSettings.seed : undefined,
        batch_size: studio.generationSettings.batchSize,
      }),
    });
    
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || `Server error: ${resp.status}`);
    }
    
    const job: GenerationJob = await resp.json();
    studio.generationJobs.unshift(job);
    
    // If successful, convert output images to ProcessedImage results
    if (job.status === "completed" && job.output?.images) {
      for (const img of job.output.images) {
        // Fetch the image and convert to data URL
        const imgUrl = `${studio.generationServerUrl}${img.url}`;
        const imgResp = await fetch(imgUrl);
        const blob = await imgResp.blob();
        const dataUrl = await blobToDataUrl(blob);
        
        const result: ProcessedImage = {
          id: generateId(),
          sourceId: `gen_${job.id}`,
          sourceName: `Generated (${studio.generationSettings.model})`,
          tool: "generate",
          dataUrl,
          width: img.width,
          height: img.height,
          processedAt: Date.now(),
          processingTime: job.timing?.inference_time_ms || 0,
          settings: {
            prompt: studio.generationSettings.prompt,
            model: studio.generationSettings.model,
            seed: job.output.seed,
          },
        };
        
        studio.results.unshift(result);
      }
    }
    
    studio.loading = false;
    state.requestUpdate?.();
    return job;
    
  } catch (err) {
    studio.loading = false;
    studio.error = (err as Error).message;
    state.requestUpdate?.();
    return null;
  }
}

/**
 * Generate image async (returns job ID, poll for status)
 */
export async function generateImageAsync(state: AppViewState): Promise<string | null> {
  const studio = getImageStudioState(state);
  
  if (!studio.generationSettings.prompt.trim()) {
    studio.error = "Please enter a prompt";
    state.requestUpdate?.();
    return null;
  }
  
  studio.loading = true;
  studio.error = null;
  state.requestUpdate?.();
  
  try {
    const resp = await fetch(`${studio.generationServerUrl}/v1/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: studio.generationSettings.prompt,
        negative_prompt: studio.generationSettings.negativePrompt,
        model: studio.generationSettings.model,
        aspect_ratio: studio.generationSettings.aspectRatio,
        quality: studio.generationSettings.quality,
        seed: studio.generationSettings.seed > 0 ? studio.generationSettings.seed : undefined,
        batch_size: studio.generationSettings.batchSize,
      }),
    });
    
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || `Server error: ${resp.status}`);
    }
    
    const job: GenerationJob = await resp.json();
    studio.generationJobs.unshift(job);
    studio.loading = false;
    state.requestUpdate?.();
    
    // Start polling for completion
    pollGenerationJob(state, job.id);
    
    return job.id;
    
  } catch (err) {
    studio.loading = false;
    studio.error = (err as Error).message;
    state.requestUpdate?.();
    return null;
  }
}

/**
 * Poll a generation job for completion
 */
async function pollGenerationJob(state: AppViewState, jobId: string): Promise<void> {
  const studio = getImageStudioState(state);
  const maxAttempts = 120; // 2 minutes at 1s intervals
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000));
    
    try {
      const resp = await fetch(`${studio.generationServerUrl}/v1/jobs/${jobId}`);
      if (!resp.ok) continue;
      
      const job: GenerationJob = await resp.json();
      
      // Update job in list
      const idx = studio.generationJobs.findIndex(j => j.id === jobId);
      if (idx >= 0) {
        studio.generationJobs[idx] = job;
      }
      
      if (job.status === "completed") {
        // Fetch images and add to results
        if (job.output?.images) {
          for (const img of job.output.images) {
            const imgUrl = `${studio.generationServerUrl}${img.url}`;
            const imgResp = await fetch(imgUrl);
            const blob = await imgResp.blob();
            const dataUrl = await blobToDataUrl(blob);
            
            const result: ProcessedImage = {
              id: generateId(),
              sourceId: `gen_${job.id}`,
              sourceName: `Generated (${job.model})`,
              tool: "generate",
              dataUrl,
              width: img.width,
              height: img.height,
              processedAt: Date.now(),
              processingTime: job.timing?.inference_time_ms || 0,
              settings: { prompt: studio.generationSettings.prompt, seed: job.output.seed },
            };
            
            studio.results.unshift(result);
          }
        }
        state.requestUpdate?.();
        return;
      }
      
      if (job.status === "failed") {
        studio.error = job.error || "Generation failed";
        state.requestUpdate?.();
        return;
      }
      
      state.requestUpdate?.();
      
    } catch (err) {
      console.warn("Poll error:", err);
    }
  }
  
  studio.error = "Generation timed out";
  state.requestUpdate?.();
}

/**
 * Helper to convert blob to data URL
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Get presets info from server
 */
export async function loadGenerationPresets(state: AppViewState): Promise<any> {
  const studio = getImageStudioState(state);
  
  try {
    const resp = await fetch(`${studio.generationServerUrl}/v1/presets`);
    if (resp.ok) {
      return await resp.json();
    }
  } catch (err) {
    console.warn("Failed to load presets:", err);
  }
  
  return null;
}
