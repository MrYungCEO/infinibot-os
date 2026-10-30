# Local model runtimes (GPU swapping)

One GPU, several local model servers. The gateway's **local runtime manager**
(`src/local-runtimes/`) starts and stops them on demand so picking a model on
a stopped runtime swaps the GPU instead of failing with
"Temporary connection issue with vllm-local".

## Registry

Built in, no config needed:

| id | kind | what it manages |
| --- | --- | --- |
| `ollama` | `ollama` | The Ollama server at `models.providers.ollama.baseUrl` / `OLLAMA_HOST` / `127.0.0.1:11434`. Models load on demand; the manager only unloads (`keep_alive: 0`) or preloads them. The Ollama service itself is never stopped. |
| `vllm-qwen` | `systemd` | `~/.config/systemd/user/vllm-qwen.service`, auto-detected when the unit file exists. Serves provider `vllm-local`. Health: `<baseUrl>/models` (the unit binds `172.17.0.1:8010`). VRAM need = `--gpu-memory-utilization` × GPU total (drop-ins honoured). |

Only units and models listed in the registry are touched. Other GPU
processes (speaches TTS/STT, the desktop, browsers) are never stopped. If
they leave too little VRAM, the swap is refused up front with a clear error.

Owner overrides go in `infinibot.json`. The reload rule is "none", so no
restart is needed:

```json5
localRuntimes: {
  // enabled: false,                 // turn the manager off
  drainTimeoutSec: 120,              // swap waits this long for in-flight requests
  backgroundPriority: "interactive-first", // or "fifo"
  backgroundSwapIdleSec: 600,        // OCR may evict chat's runtime after this much chat idle
  backgroundWaitTimeoutSec: 1800,
  reservedVramMb: 512,
  runtimes: {
    "vllm-qwen": { idleStopMinutes: 30, startAtBoot: false, etaSec: 90, startupTimeoutSec: 420 },
    // ollama: false,                // drop a runtime
    // "my-vllm": { kind: "systemd", unit: "my-vllm.service", baseUrl: "http://127.0.0.1:8020/v1",
    //              providers: ["my-vllm"], models: ["m"], visionModels: [], vramFraction: 0.8 }
  },
}
```

`startAtBoot` defaults to false. The unit stays disabled; it is started
only when something needs it. The manager never runs `systemctl enable`.

## Swap flow

When a chat run, a Secure Mode default, or an OCR/vision job needs a model on runtime X:

1. If X is healthy, the request runs at once. Ollama counts as ready when the model is loaded, or when no other runtime holds the GPU, because Ollama loads models itself.
2. Otherwise one swap runs at a time. Requests for the same runtime batch onto it.
3. **Drain:** wait for in-flight requests on the runtime being evicted, up to `drainTimeoutSec`. A timeout is logged and the swap proceeds.
4. **Free:** if free VRAM is short of the need, stop the other registry runtimes: `systemctl --user stop`, or unload Ollama models. If even that can't fit, refuse before touching anything.
5. **Start:** `systemctl --user start <unit>`, then poll health every 2 s. This fails fast when the unit exits or crash-loops (`SubState=auto-restart`) and reports the exception line from its journal. For Ollama, the model is preloaded instead.
6. **Failure:** stop the half-started unit, restore whatever was evicted, and throw "Couldn't start X: …. Back on Y." The agent run turns this into a FailoverError, so the model fallback chain continues. In Secure Mode every candidate is local, so the fallback stays local.

**Idle policy.** A systemd runtime with `idleStopMinutes > 0` (vLLM default 30) is stopped once nothing has used it for that long. Ollama reloads on demand.

**Priority.** Background work (OCR, video analysis) never forces a swap while chat holds or recently used the GPU. A background lease on the same runtime pauses while an interactive turn holds it. For queue code there are hooks in `src/local-runtimes/runtime.ts`: `withInteractiveRuntime(id, fn)`, `onLocalRuntimeInteractive(cb)` (`busy`/`idle`), `isLocalRuntimeInteractiveBusy(id)` and `runtimeIdForEndpoint(url)`.

**Vision routing.** OCR uses an already-running systemd runtime that lists `visionModels`, when its host is verified local. Otherwise it waits for Ollama.

**Secure Mode.** A stopped registry runtime counts as "starts on demand" for the agent's own model or `secureMode.defaultModel`. Automatic picks prefer a model that is already running.

## Surfaces

- **Chat** (`/webchat`): the `runtime_status` agent notices render as a status line in place of the typing dots, for example "Starting vLLM Qwen3.8-27B… (≈90 s)" with a progress bar, "Switching GPU to Ollama…", or the failure text.
- **GPU widget** `<ib-gpu-runtimes>`: shown at the bottom of the chat model picker and on the `/ollama` page. It shows which runtime holds the GPU, VRAM, Start/Stop (Load/Unload for Ollama), live swap progress, and recent swaps.
- **RPCs:** `localRuntimes.status` and `localRuntimes.log` (read), `localRuntimes.start {id, wait?}` and `localRuntimes.stop {id, wait?}` (write). Each swap broadcasts a `localRuntimes.status` event.
- **Swap log:** `<stateDir>/local-runtimes/swaps.jsonl` plus the gateway log, subsystem `local-runtimes`.

## Host notes (my-host, 2026-10-16)

- `vllm-qwen.service` can't start as configured: the weights for `nvidia/Qwen3.8-27B-NVFP4` are not in `~/.cache/huggingface` and the unit sets `HF_HUB_OFFLINE=1`. Even with the weights present, `--gpu-memory-utilization 0.85` needs 27.7 GB, but the desktop and speaches leave about 26.3 GB free. Use about 0.78, for example as a drop-in `vllm-qwen.service.d/gpu-memory.conf` that re-declares `ExecStart` with that value.
- Ollama reloads a model whenever a caller's `num_ctx` differs from the loaded context: OCR uses 8192 and the defaults use 32768. Mixed callers therefore cause slow reloads in the 40–65 s range.

## Real swap test (2026-10-16, this host)

Script: `/tmp/lrt-e2e/real-swap.mts` drives `LocalRuntimeManager` against the real
systemctl, Ollama and nvidia-smi.

| run | result |
| --- | --- |
| `vllm-qwen` (real unit, 0.85), first attempt | Ollama Qwen unloaded at once; refused after the VRAM wait (26.3 GB free < 28.2 GB needed); Ollama restored after 42 s; Ollama completion OK; speaches PIDs and start times unchanged. |
| `vllm-qwen`, with the 0.78 drop-in | Started; the unit crash-looped (`LocalEntryNotFoundError`, no weights). This led to the crash-loop fast-fail; the drop-in was removed afterwards. |
| `vllm-qwen` (0.85), final | Refused **before** evicting anything (27 ms): "5925 MiB free + 16594 MiB from ollama < ~28228 MiB". Ollama untouched; completion OK in 265 ms. |
| stand-in systemd unit (no weights needed) | Start → health in 20.2 s, completion OK; swap back to Ollama (stop unit + Qwen preload) in 54.1 s; Ollama completion OK; speaches untouched. |
| side gateway e2e (`/tmp/lrt-e2e/sgw`, own state dir) | A chat on stopped `vllm-local` streamed "Starting vLLM Qwen3.8-27B… (≈90 s)" notices; the unit started in 26.3 s; the reply came from `vllm-local/qwen3.8-27b`; `localRuntimes.stop` worked. |
