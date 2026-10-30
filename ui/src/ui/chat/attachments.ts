import type { GatewayBrowserClient } from "../gateway";
import type { ChatAttachment } from "../ui-types";
import { generateUUID } from "../uuid";
import { isSecureSessionKey } from "../secure-mode/session-key";

export const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const CHAT_ATTACHMENT_ACCEPT = [
  "image/*",
  "video/*",
  "application/pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
].join(",");

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

export type AttachmentPreparationProgress = {
  phase: "reading" | "uploading" | "queued" | "error";
  loaded: number;
  total: number;
  message?: string;
};

export function normalizedFileMime(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function isSupportedChatFile(file: File): boolean {
  const mime = normalizedFileMime(file);
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime === "application/pdf" ||
    Object.values(MIME_BY_EXT).includes(mime)
  );
}

function readFile(
  file: File,
  onProgress?: (p: AttachmentPreparationProgress) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) =>
      onProgress?.({
        phase: "reading",
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : file.size,
      });
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function safeFileName(name: string): string {
  return (
    (name.split(/[\\/]/).pop() ?? "attachment")
      .replace(/[^\w.\- ]+/g, "_")
      .trim()
      .slice(0, 120) || "attachment"
  );
}

export async function prepareChatAttachment(params: {
  file: File;
  client: GatewayBrowserClient;
  sessionKey: string;
  onProgress?: (p: AttachmentPreparationProgress) => void;
}): Promise<ChatAttachment> {
  const { file, client, sessionKey, onProgress } = params;
  const mimeType = normalizedFileMime(file);
  const id = generateUUID();
  if (!isSupportedChatFile(file)) {
    throw new Error(
      `Unsupported file type: ${file.name}. Use PDF, DOCX, XLSX, PPTX, TXT/MD, CSV, image, or video.`,
    );
  }
  if (file.size <= 0) throw new Error(`${file.name} is empty.`);
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `${file.name} is larger than the 25 MB chat limit. Upload it on Files, then ask the agent about it.`,
    );
  }

  const dataUrl = await readFile(file, onProgress);
  onProgress?.({ phase: "uploading", loaded: file.size, total: file.size });
  const content = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const secure = isSecureSessionKey(sessionKey);
  let ocrId: string | undefined;
  let filePath: string | undefined;
  let extractionStatus: ChatAttachment["extractionStatus"];

  if (secure) {
    const result = await client.request<{
      entry?: { id?: string; status?: ChatAttachment["extractionStatus"] };
    }>("files.secure.upload", { name: safeFileName(file.name), content });
    ocrId = result?.entry?.id;
    extractionStatus = result?.entry?.status;
  } else {
    const day = new Date().toISOString().slice(0, 10);
    const path = `chat-uploads/${day}/${id.slice(0, 8)}-${safeFileName(file.name)}`;
    const result = await client.request<{
      path?: string;
      ocr?: { id?: string; status?: ChatAttachment["extractionStatus"] };
    }>("files.upload", { path, content, sessionKey });
    ocrId = result?.ocr?.id;
    extractionStatus = result?.ocr?.status;
    filePath = result?.path ?? path;
  }

  onProgress?.({ phase: "queued", loaded: file.size, total: file.size });
  return {
    id,
    dataUrl,
    mimeType,
    fileName: safeFileName(file.name),
    size: file.size,
    sourceFile: file,
    ocrId,
    filePath,
    secure,
    extractionStatus: ocrId ? (extractionStatus ?? "queued") : "done",
    ...(mimeType.startsWith("video/") ? { analysts: ["archaeologist"] } : {}),
  };
}
