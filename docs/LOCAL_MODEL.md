# Legacy local reranker

This document describes the original 0.6B Transformers reranker provider. For
the recommended local judge, use the direct option-logit SemIf/Qwen3.5-4B path
in [`SEMIF_LOCAL.md`](SEMIF_LOCAL.md). The reranker remains useful as a cheap
compatibility fallback and is selected explicitly with `--provider local`.

The legacy local provider uses
[`Qwen/Qwen3-Reranker-0.6B`](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B).
Its implementation is documented in the official
[`Qwen3-Embedding`](https://github.com/QwenLM/Qwen3-Embedding) repository.
The setup script downloads the same checkpoint from
[`ModelScope`](https://modelscope.cn/models/Qwen/Qwen3-Reranker-0.6B), which is
the reachable model registry used for this deployment.

## Why this model

Jev is useful here as a fast answerer of many narrow questions, not as a text
generator. Qwen3-Reranker has the closest open model interface found:

- it accepts an instruction, a query, and a candidate document;
- it derives a scalar from the final `yes` and `no` token logits;
- it is instruction-aware and supports more than 100 languages plus code;
- its 0.6B checkpoint is Apache-2.0 and small enough to keep resident locally;
- one batch can contain every candidate-by-criterion decision.

The local service preserves that interface. It does not ask the model to emit
JSON or explanations. A candidate is independently checked for goal fit, hard
constraints, feasibility, validation quality, and execution value. Candidate
pairs are separately checked for duplication.

## Alternatives considered

| Model | Useful role | Why it is not the default |
| --- | --- | --- |
| [mxbai-rerank-base-v2](https://huggingface.co/mixedbread-ai/mxbai-rerank-base-v2) | Strong multilingual/code reranker and the best first A/B challenger | Its interface is slightly less direct than Qwen's documented `yes/no` scoring path |
| [PairRM-hf](https://huggingface.co/llm-blender/PairRM-hf) | Tie-breaking between the final two or three candidates | Pairwise-only evaluation is quadratic and cannot provide an absolute rejection gate |
| [nli-deberta-v3-xsmall](https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall) | Very cheap CPU hard-constraint gate | English-only, 512-token context, and not instruction-aware |
| [nli-MiniLM2-L6-H768](https://huggingface.co/cross-encoder/nli-MiniLM2-L6-H768) | Another small CPU NLI gate | Same NLI limitations and weaker multilingual/code fit |

Generic chat models and scalar reward models were rejected as the first
provider. Chat models add generation latency and format failures. General
reward models tend to score writing style and broad preference rather than a
caller-supplied typed criterion.

## Installed artifact

The Windows setup script installs outside the repository by default:

```text
D:\SpecJevLocal\.venv
D:\SpecJevLocal\models\Qwen3-Reranker-0.6B
D:\SpecJevLocal\logs
```

The BF16 checkpoint is 1,191,588,280 bytes. Its verified SHA-256 is:

```text
27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b
```

The service binds to `127.0.0.1:4877`, loads local files only, and does not
enable repository-supplied Python code. It uses CUDA when a CUDA-enabled
PyTorch build is installed and otherwise falls back to CPU.

## What remains to prove

The `yes/no` softmax value is not a calibrated probability. Retrieval
benchmarks also do not establish that the model is a good engineering judge.
Before lowering the rejection threshold, build a set of 100-200 labeled
candidate decisions and measure false rejection rate, ranking AUC, wall time,
and peak memory. The first comparison should be Qwen versus mxbai, with Jev
and human decisions as references.
