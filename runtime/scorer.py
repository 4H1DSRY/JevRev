"""Qwen3-Reranker scoring with a local Transformers checkpoint."""

from __future__ import annotations

import inspect
import math
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


DEFAULT_INSTRUCTION = (
    "Given a query, determine whether the document satisfies the query's "
    "requirements."
)

SYSTEM_PREFIX = (
    "<|im_start|>system\n"
    "Judge whether the Document meets the requirements based on the Query and "
    "the Instruct provided. Note that the answer can only be \"yes\" or \"no\"."
    "<|im_end|>\n<|im_start|>user\n"
)

ASSISTANT_SUFFIX = (
    "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
)


@dataclass(frozen=True, slots=True)
class ScoreItem:
    """One query/document pair to score."""

    item_id: str
    query: str
    document: str
    instruction: str = DEFAULT_INSTRUCTION


@dataclass(frozen=True, slots=True)
class ScoreResult:
    """Scores and aggregate tokenizer usage for one request."""

    scores: list[float]
    input_tokens: int


def format_instruction(item: ScoreItem) -> str:
    """Build the user section expected by Qwen3-Reranker."""

    return (
        f"<Instruct>: {item.instruction}\n"
        f"<Query>: {item.query}\n"
        f"<Document>: {item.document}"
    )


def yes_probability(no_logit: float, yes_logit: float) -> float:
    """Return a numerically stable two-class probability for tests/tools."""

    difference = no_logit - yes_logit
    if difference >= 0:
        exp_negative = math.exp(-difference)
        return exp_negative / (1.0 + exp_negative)
    exp_difference = math.exp(difference)
    return 1.0 / (1.0 + exp_difference)


class Qwen3Reranker:
    """Local Qwen3 reranker with CPU fallback and serialized inference."""

    def __init__(
        self,
        model_path: str,
        *,
        device: str = "auto",
        max_length: int = 8192,
        default_batch_size: int = 8,
        local_files_only: bool = True,
        trust_remote_code: bool = False,
    ) -> None:
        if not model_path.strip():
            raise ValueError("model_path must not be empty")
        if max_length < 128:
            raise ValueError("max_length must be at least 128")
        if default_batch_size < 1:
            raise ValueError("default_batch_size must be positive")

        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError as exc:  # pragma: no cover - depends on deployment env
            raise RuntimeError(
                "The local runtime requires torch and transformers. "
                "Install runtime/requirements.txt in an isolated environment."
            ) from exc

        self._torch = torch
        self.model_name = f"local/{Path(model_path).name}"
        self.device = self._resolve_device(device, torch)
        self.max_length = max_length
        self.default_batch_size = default_batch_size
        self._inference_lock = threading.Lock()

        self._tokenizer = AutoTokenizer.from_pretrained(
            model_path,
            local_files_only=local_files_only,
            trust_remote_code=trust_remote_code,
            padding_side="left",
        )
        if self._tokenizer.pad_token_id is None:
            self._tokenizer.pad_token = self._tokenizer.eos_token

        dtype = torch.float16 if self.device.startswith("cuda") else torch.float32
        self._model = AutoModelForCausalLM.from_pretrained(
            model_path,
            local_files_only=local_files_only,
            trust_remote_code=trust_remote_code,
            dtype=dtype,
        )
        self._model.to(self.device)
        self._model.eval()
        self._forward_kwargs: dict[str, Any] = {"use_cache": False}
        forward_parameters = inspect.signature(self._model.forward).parameters
        if "logits_to_keep" in forward_parameters:
            self._forward_kwargs["logits_to_keep"] = 1
        elif "num_logits_to_keep" in forward_parameters:
            self._forward_kwargs["num_logits_to_keep"] = 1

        self._no_token_id = self._required_token_id("no")
        self._yes_token_id = self._required_token_id("yes")
        self._prefix_tokens = self._encode_without_special_tokens(SYSTEM_PREFIX)
        self._suffix_tokens = self._encode_without_special_tokens(ASSISTANT_SUFFIX)
        self._content_budget = (
            self.max_length - len(self._prefix_tokens) - len(self._suffix_tokens)
        )
        if self._content_budget < 1:
            raise ValueError(
                "max_length is too small for the Qwen3-Reranker prompt wrapper"
            )

    @staticmethod
    def _resolve_device(requested: str, torch: Any) -> str:
        normalized = requested.strip().lower()
        if normalized == "auto":
            return "cuda" if torch.cuda.is_available() else "cpu"
        if normalized == "cpu":
            return normalized
        if normalized == "cuda" or normalized.startswith("cuda:"):
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA was requested but torch.cuda.is_available() is false")
            return normalized
        raise ValueError("device must be auto, cpu, cuda, or cuda:<index>")

    def _required_token_id(self, token: str) -> int:
        token_id = self._tokenizer.convert_tokens_to_ids(token)
        if token_id is None or token_id == self._tokenizer.unk_token_id:
            raise RuntimeError(f"Tokenizer has no distinct token for {token!r}")
        return int(token_id)

    def _encode_without_special_tokens(self, text: str) -> list[int]:
        encoded = self._tokenizer.encode(text, add_special_tokens=False)
        return [int(token_id) for token_id in encoded]

    def _prepare_batch(self, items: Sequence[ScoreItem]) -> tuple[dict[str, Any], int]:
        texts = [format_instruction(item) for item in items]
        content = self._tokenizer(
            texts,
            add_special_tokens=False,
            padding=False,
            truncation=True,
            max_length=self._content_budget,
            return_attention_mask=False,
        )["input_ids"]

        sequences = [
            self._prefix_tokens + token_ids + self._suffix_tokens
            for token_ids in content
        ]
        encoded = self._tokenizer.pad(
            {"input_ids": sequences},
            padding=True,
            return_attention_mask=True,
            return_tensors="pt",
        )
        input_tokens = int(encoded["attention_mask"].sum().item())
        model_inputs = {key: value.to(self.device) for key, value in encoded.items()}
        return model_inputs, input_tokens

    def score(
        self,
        items: Sequence[ScoreItem],
        *,
        batch_size: int | None = None,
    ) -> ScoreResult:
        """Score items in order, returning P(yes) for each item."""

        if not items:
            return ScoreResult(scores=[], input_tokens=0)
        effective_batch_size = batch_size or self.default_batch_size
        if effective_batch_size < 1:
            raise ValueError("batch_size must be positive")

        scores: list[float] = []
        input_tokens = 0
        with self._inference_lock, self._torch.inference_mode():
            for offset in range(0, len(items), effective_batch_size):
                model_inputs, batch_tokens = self._prepare_batch(
                    items[offset : offset + effective_batch_size]
                )
                logits = self._model(
                    **model_inputs, **self._forward_kwargs
                ).logits[:, -1, :]
                no_logits = logits[:, self._no_token_id].float()
                yes_logits = logits[:, self._yes_token_id].float()
                probabilities = self._torch.sigmoid(yes_logits - no_logits)
                raw_scores = [float(value) for value in probabilities.cpu().tolist()]
                if not all(math.isfinite(value) for value in raw_scores):
                    raise RuntimeError("model produced a non-finite reranker score")
                batch_scores = [min(1.0, max(0.0, value)) for value in raw_scores]
                scores.extend(batch_scores)
                input_tokens += batch_tokens

        return ScoreResult(scores=scores, input_tokens=input_tokens)
