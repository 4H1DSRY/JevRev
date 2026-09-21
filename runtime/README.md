# Local Qwen3-Reranker runtime

This service loads a Qwen3-Reranker Transformers checkpoint from local storage
and exposes it only on `127.0.0.1` by default.

Use an isolated Python 3.13 environment and keep the environment and model on a
drive with sufficient free space. Install dependencies, then start the service:

On Windows, the repository scripts create the environment and model cache on
`D:` so a small system drive is not filled:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-local.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1
```

The portable equivalent is:

```powershell
python -m pip install -r runtime/requirements.txt
python -m runtime.server --model D:\SpecJevLocal\models\Qwen3-Reranker-0.6B
```

`--device auto` selects CUDA when the installed PyTorch build can use it and
otherwise uses CPU. Model downloads and repository code execution are disabled
by default. `--allow-download` and `--trust-remote-code` opt into them.

## API

`GET /health` reports the loaded model and selected device.

`POST /v1/score` accepts up to 256 query/document pairs:

```json
{
  "items": [
    {
      "id": "candidate-a",
      "query": "Does this approach satisfy the requirement?",
      "document": "The candidate approach and its evidence.",
      "instruction": "Judge requirement coverage."
    }
  ],
  "batch_size": 8
}
```

The response preserves item order. Each score is the model's probability of
the `yes` token within the model's `yes/no` logits, in the range `[0, 1]`.
It is a ranking signal, not a calibrated real-world probability:

```json
{
  "model": "local/Qwen3-Reranker-0.6B",
  "device": "cuda",
  "count": 1,
  "scores": [{"id": "candidate-a", "score": 0.91}],
  "input_tokens": 87,
  "duration_ms": 24.7
}
```

Configuration can also be supplied with `SPECJEV_MODEL_PATH`,
`SPECJEV_HOST`, `SPECJEV_PORT`, `SPECJEV_DEVICE`, `SPECJEV_MAX_LENGTH`, and
`SPECJEV_BATCH_SIZE`.

Startup includes one warm-up inference so the first real ranking request does
not pay CUDA initialization cost. Pass `--skip-warmup` when measuring cold
start behavior.

Run the dependency-free tests with:

```powershell
python -m unittest discover -s runtime/tests -v
```

With a real server running, verify basic requirement, duplication, and Chinese
discrimination with:

```powershell
python -m runtime.smoke
```
