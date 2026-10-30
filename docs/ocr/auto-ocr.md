# Local auto-OCR for uploaded files

Every uploaded image and document is read **on this machine**. The text, a
local vision-model description and per-page detail become agent context.
Agents can search files by content, read the text, or ask the local vision
model a question about an image.

## What gets processed

| Source | Hook | Lane |
| --- | --- | --- |
| Files page upload (`files.upload`) | `src/gateway/server-methods/files.ts` | normal |
| Files page in Secure Mode (`files.secure.upload`) | `src/gateway/server-methods/files-ocr.ts` | secure (vault) |
| 1:1 chat attachments (`chat.send`) | `buildAttachmentOcrContext` in `src/ocr/runtime.ts` | secure when the session key is secure |
| Group chat attachments | `handleGroupChatSend` → message `attachmentContext` | secure for `groupchat-sec-*` |
| Documents uploads / re-extract | `src/documents/service.ts` (`queueDocumentOcr`, `applyOcrToDocument`) | normal |
| Channel media (Telegram, WhatsApp, …) | `src/auto-reply/reply/get-reply.ts` → `enqueueChannelMedia` | normal (never secure sessions) |

Chat and group-chat attachments are kept under `<files root>/chat-uploads/<date>/`.
Channel media is copied out of the 2-minute media cache into
`<files root>/inbox-media/<date>/`. Secure-lane bytes never touch plaintext
disk. They are sealed in the Secure Mode vault, and an engine only sees a
tmpfs copy for the length of one job.

The Supabase-backed shop vault (`vault.shop.uploadAsset`) is a hosted asset
store, not a local upload path, so it is not OCR'd.

## Tiers (defaults)

- **Images** (png, jpg, webp, heic, gif, bmp, tiff): RapidOCR always, plus a
  local vision description (Summary / Text / Key entities).
- **PDFs**: handled page by page. The text layer (`pdftotext`) is used first.
  Pages without one are rendered (`pdftoppm`, 200 dpi) and OCR'd. Pages with
  low confidence (< 0.85) or almost no text also get a vision reading, capped
  at 3 pages per document. Progress is saved after every page.
- **Office documents** (docx, pptx, xlsx, and doc/odt/rtf/epub via markitdown):
  native text only.

Engines:

- OCR uses RapidOCR (PaddleOCR models on ONNX Runtime, CPU, offline). It
  lives in the venv `~/.infinibot/tools/ocr-venv`:
  `python3 -m venv ~/.infinibot/tools/ocr-venv && ~/.infinibot/tools/ocr-venv/bin/pip install rapidocr-onnxruntime pillow-heif`
  (about 420 MB, no GPU needed). Tesseract is not required.
- Vision uses Ollama on loopback. It auto-picks an installed vision-capable
  model and prefers Qwen VL (on this host: `huihui_ai/Qwen3.8-abliterated`,
  which has the `vision` capability). Force a model with
  `INFINIBOT_OCR_VL_MODEL`.
- PDF processing uses Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`).

Env knobs:

| Variable | Default |
| --- | --- |
| `INFINIBOT_OCR_DISABLED` | unset; `1` turns the pipeline off |
| `INFINIBOT_OCR_PYTHON` | `~/.infinibot/tools/ocr-venv/bin/python` |
| `INFINIBOT_OCR_OLLAMA_URL` | `OLLAMA_HOST`, otherwise `http://127.0.0.1:11434` |
| `INFINIBOT_OCR_VL_MODE` | `auto`; also `always` or `off` |
| `INFINIBOT_OCR_LOW_CONFIDENCE` | `0.85` |
| `INFINIBOT_OCR_MAX_PAGES` | `300` |
| `INFINIBOT_OCR_MAX_VL_PAGES` | `3` |
| `INFINIBOT_OCR_MAX_ATTEMPTS` | `4` |
| `INFINIBOT_OCR_RETRY_BASE_MS` | `5000` |

## Local-only enforcement

`src/ocr/local-only.ts`:

- The vision endpoint must be loopback. Anything else, including a remote
  `OLLAMA_HOST`, is refused, and the vision tier is disabled rather than sent
  off-box.
- Every request re-validates the URL.
- OCR subprocesses run with a scrubbed environment: no proxies, and
  `HF_HUB_OFFLINE=1`.
- There is no cloud fallback.

## Queue (durable)

The registry row of each file is its job:

- `status`: `queued`, `processing`, `done` or `failed`
- `attempts`, `nextAttemptAt` and `error`

The registry is persisted after every transition:

- Normal lane: `<stateDir>/ocr/registry.json`
- Secure lane: the vault store `ocr-registry`

On restart, a job left in `processing` is re-queued. A multi-page PDF
resumes from its saved partial sidecar.

Other behaviour:

- Failures retry with exponential backoff (5 s, 10 s, 20 s, …) up to 4
  attempts.
- One job runs at a time, and chat attachments jump the queue.
- Uploads never wait for extraction.
- `chat.send` acknowledges first, then waits at most 10 s for the OCR text
  before the agent turn starts.

### Interactive turns come first

While an interactive agent turn runs on a local model (Ollama or vLLM on this
machine), the GPU is reserved for the chat. Every Secure Mode turn counts as
local. The gate lives in `src/ocr/interactive-gate.ts`.

- Background OCR (backfill, uploads) and queued video analyses pause.
- Jobs the turn itself needs keep running: chat attachments (priority ≥ 10),
  and `video_analysis analyze`/`ask` jobs started by the agent tool.
- A background job that is already running waits before its next vision
  call.
- The queue resumes when the turn ends. Holds auto-expire after the turn
  timeout plus one minute.
- `files.ocr.status` reports `pausedForInteractive`.

TODO: fold this into the GPU runtime manager's priority scheduler
(`feat/local-runtime-manager`) once it lands.

## Storage

Normal lane: the sidecar sits next to the file in a hidden `.ocr/` folder.

- `<name>.ocr.json` holds the full sidecar.
- `<name>.ocr.md` holds a readable copy.
- If the folder is read-only, the sidecar falls back to
  `<stateDir>/ocr/sidecars/`.
- `.ocr` folders are hidden from Files listings.

The sidecar contains:

- `markdown`, `description` and `entities`
- `pages[]`, each with method, text and confidence
- `confidence`
- `engines` (text, OCR and vision model)
- `warnings`
- `analyses[]`
- `source` (project id, session key, agent, doc id, channel)
- timestamps

Agent memory: every finished normal-lane file is mirrored to
`<agent workspace>/memory/files-ocr/<id>.md`, for the default agent and the
uploading agent, which `memory_search` indexes. Secure files are never
mirrored.

## Agent and UI access

RPCs (`src/gateway/server-methods/files-ocr.ts`):

- `files.context.get`, `files.context.search`, `files.context.list`
- `files.ocr.status`, `files.ocr.rerun`
- `files.inspect`, which sends an image or PDF page plus a question to the
  local vision model
- `files.secure.list`, `files.secure.upload`, `files.secure.download`,
  `files.secure.delete`

Passing `secure: true` selects the vault lane. These calls fail closed with
`SECURE_MODE_LOCKED` while the lane is locked.

Agent tool: `file_context`, with actions `digest`, `search`, `get`,
`inspect` and `list`. It is lane-bound: a secure session sees only the secure
lane. It is seeded into every allow-listed agent (`FILE_CONTEXT_TOOLS`) and is
on the Secure Mode allowlist.

Reads are cached and cheap. They return the saved sidecar and never re-run
OCR or vision:

- `digest` returns a compact digest of up to 40 recent files (or `ids[]`) in
  one call: saved description, entities, analyses and a short excerpt.
- `get` with `ids[]` batches the same way, and `compact:true` shortens a
  single file.
- `video_analysis get` with `ids[]` returns compact saved summaries for many
  videos.
- Every result is capped at about 24k characters (`capToolPayload` in
  `src/agents/tools/file-digest.ts`).

Vision runs only when asked:

- `inspect` answers are saved in `analyses[]` (analyzer `inspect`) and
  reused for the same question.
- `video_analysis analyze` returns an analyst's existing analysis, and `ask`
  returns an existing answer to the same question and timecodes.
- `refresh:true` re-runs either one. The Files page buttons always re-run.

Chat agents get an `<attachment_context source="local-ocr">` block with each
attachment's text and description in their prompt.

UI:

- The Files page shows OCR chips on rows, an inline image preview, the
  `<ib-file-context>` panel (Extracted text, Description, Pages, Copy,
  Re-run, Ask the image), a Names/Contents search switch, and the Secure Mode
  toggle. When Secure Mode is on, the page swaps to `<ib-secure-files>`.
- In chat and group chat, a "Text" button on each attachment image opens the
  same panel. It matches the attachment by sha256.

## Extension point (video and specialist analyzers)

```ts
import { registerExtractionHandler } from "../ocr/handlers.js";
import { newSidecar } from "../ocr/extract.js";

registerExtractionHandler({
  id: "video",
  exts: [".mp4", ".mov", ".webm", ".mkv"],
  mimes: [/^video\//],
  defaultMime: { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" },
  priority: 0,
  async extract(params, { saveProgress }) {
    // params: { entry, filePath, engines, cfg, prior, onProgress, tmpDir, now }
    const sc = newSidecar(params);              // resumes from params.prior when sha matches
    // … process chunks; after each one:
    saveProgress(sc, { done, total, stage: "chunks" });
    sc.video = { /* opaque, owned by the analyzer */ };
    sc.analyses = [...(sc.analyses ?? []), { id: "video:frames", analyzer: "video", createdAt: Date.now(), summary, frames }];
    sc.complete = true;
    sc.stage = "vl";
    return sc;
  },
});
```

- Once a handler is registered for an extension or MIME type, those uploads
  are queued automatically on every hook listed above.
- Analyzers that run later, such as a specialist agent's review, call
  `getOcrService().addAnalysis(lane, { id }, analysis)`, or
  `updateSidecar(lane, ref, fn)` for arbitrary edits. Neither re-queues the
  file. Both update search, the memory mirror and the KG node.
- Secure lane: use `params.tmpDir`, which is tmpfs, for scratch files, and
  never log names or content.
- `file_context get` returns `analyses` and `video`.
