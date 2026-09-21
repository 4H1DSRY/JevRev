# JevRev local SemIf judge

JevRev can use the open SemIf protocol with a local Qwen3.5-4B model. SemIf
reads the logits for the declared answer letters (A, B, C, or D) instead of
asking the model to generate an explanation. That makes a typed Jev decision
cheap, inspectable, and resistant to JSON-format failures.

The protocol is based on [TheoLeeCJ/SemIf](https://github.com/TheoLeeCJ/SemIf)
(MIT). The bundled runtime uses the pinned Q4_K_M GGUF through
[llama.cpp](https://github.com/ggml-org/llama.cpp), so no Python model server is
needed for this path. The tested Windows binary is llama.cpp build `b9222`
(commit `9a532ae4b`) with CUDA 13 support.

## Pinned artifacts

The Windows scripts expect these files outside the repository:

```text
D:\SpecJevLocal\llama-b9222\llama-server.exe
D:\SpecJevLocal\models\Qwen3.5-4B-GGUF\Qwen_Qwen3.5-4B-Q4_K_M.gguf
```

The GGUF is the `Qwen/Qwen3.5-4B` Q4_K_M artifact (3,013,027,808 bytes).
The source conversion is `bartowski/Qwen_Qwen3.5-4B-GGUF` at revision
`4168f45a16a1290d65a4ec0fa312ae917a4c15d6`; the upstream Qwen checkpoint is
pinned at revision `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`. Its SHA-256 is:

```text
13C16F426047E2DE38CD075BDADE4A7BCBC8C774384876F677740CDA65F8A983
```

Run the artifact check before starting a service:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-semif.ps1
```

The repository does not check in model weights or CUDA DLLs. Keep those large
binary artifacts in the install root and verify their provenance before use.

## Start and stop

Start in the foreground while diagnosing startup:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1
```

For normal CLI use, start a hidden local service:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
powershell -ExecutionPolicy Bypass -File scripts/status-semif.ps1
```

The service binds to `127.0.0.1:4878` and enables the llama.cpp Jinja chat
template. It disables prompt-cache checkpoints between slots because repeated
direct-logit probes must not reuse an incompatible sequence state. The default
single slot is deliberate; raise `-ParallelSlots` only after measuring GPU
memory and latency on the target machine.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-semif.ps1
```

The stop script verifies the executable, model path, and port in the process
command line before terminating anything. The older Transformers reranker
service remains independent on port `4877` and is managed by
`scripts/start-local.ps1` and `scripts/stop-local.ps1`.

## API shape

The TypeScript SemIf provider sends the exact decision form used by the
upstream project to:

```text
POST http://127.0.0.1:4878/v1/chat/completions
```

It sets `max_tokens: 1`, disables Qwen thinking, requests token logprobs, and
normalizes only the declared option letters. A score question maps A-D to the
four rubric levels; a noul question maps A/B to its two boolean choices. The
returned probability is a local decision signal, not a calibrated claim about
the world.

For a quick transport check:

```powershell
Invoke-RestMethod http://127.0.0.1:4878/health
```

Then run the CLI with `--provider semif` (see the root README for the complete
ranking command). Keep the server loopback-only when candidate evidence may
contain source code or private project context.
