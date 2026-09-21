# Local runtime baseline

Recorded on 2026-09-20 with an RTX 5070 Laptop GPU (8 GB). The legacy
Transformers path uses CUDA 13.0, PyTorch 2.14.0, and `Qwen3-Reranker-0.6B`
in FP16 inference. The recommended SemIf path uses the pinned Q4_K_M
`Qwen3.5-4B` GGUF through llama.cpp.

## Semantic smoke test

The smoke set contains one positive and one negative item for each behavior.
It is a deployment check, not a quality benchmark.

| Behavior | Positive | Negative | Margin |
| --- | ---: | ---: | ---: |
| Hard requirement | 0.9828 | 0.0002 | 0.9827 |
| Duplicate mechanism | 0.9907 | 0.1312 | 0.8596 |
| Chinese requirement | 0.9968 | 0.0140 | 0.9828 |

Warm inference for all six items was about 41 ms. Service startup, including
model loading and one CUDA warm-up, was about 25 seconds.

## Seven-candidate run: legacy reranker

`examples/parser-speedup.json` produces 56 independent scoring items: five
criteria for each of seven candidates plus all 21 candidate pairs. A warm run
took about 1.3-1.5 seconds and consumed 19,704 input tokens with no generated
tokens.

The current uncalibrated policy selected `allocation-cut`, rejected
`object-pool` as a duplicate, rejected `bounded-memoization` on low signals,
and sent four candidates to review. This differs from the representative Jev
fixture, which selected two candidates. The difference is useful evidence that
the existing confidence policy is not yet calibrated for reranker logits.

Do not tune thresholds to this one example. The next quality gate is a labeled
100-200-decision corpus with false rejection rate as the primary metric.

## Seven-candidate run: SemIf direct logits

The same request produces 56 one-token probes (five questions for each of seven
candidates plus 21 pairwise duplicate checks). With the local Q4_K_M model and
the single-slot service on the same GPU, a warm run took 10-12 seconds and
used roughly 27,500 input tokens plus 56 output tokens. The service used about
5.9 GiB of the 8 GiB GPU while resident.

After trimming irrelevant candidate index metadata and making the hard-constraint
polarity explicit, the run selected `allocation-cut` and `byte-fast-path`, sent
no candidates to review, and rejected the remaining five. This is a transport
and product smoke test, not a quality claim: direct option logits still need a
labeled corpus and calibration before production thresholds are trusted.
