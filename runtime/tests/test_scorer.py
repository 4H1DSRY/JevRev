from __future__ import annotations

import unittest

from runtime.scorer import ScoreItem, format_instruction, yes_probability


class ScorerHelpersTest(unittest.TestCase):
    def test_formats_qwen3_reranker_fields(self) -> None:
        prompt = format_instruction(
            ScoreItem(
                item_id="a",
                instruction="Judge feasibility.",
                query="Can this run locally?",
                document="It uses a local checkpoint.",
            )
        )

        self.assertEqual(
            prompt,
            "<Instruct>: Judge feasibility.\n"
            "<Query>: Can this run locally?\n"
            "<Document>: It uses a local checkpoint.",
        )

    def test_yes_probability_is_stable(self) -> None:
        self.assertEqual(yes_probability(0.0, 0.0), 0.5)
        self.assertGreater(yes_probability(-1000.0, 1000.0), 0.999)
        self.assertLess(yes_probability(1000.0, -1000.0), 0.001)


if __name__ == "__main__":
    unittest.main()
