import unittest

import numpy as np
import torch

from run_v123_cortex_research import (
    CortexTransformer,
    VARIANTS,
    _select_development_variant,
)


class V123CortexResearchTests(unittest.TestCase):
    def test_variant_set_is_predeclared(self):
        self.assertEqual(VARIANTS, ("baseline", "smc_only", "technical_patterns_only", "full_cortex"))

    def test_development_selection_requires_quality_guard(self):
        development = {"variants": {
            "baseline": {"passesDevelopmentGuard": False, "model": {"selectionScore": 0.99}},
            "smc_only": {"passesDevelopmentGuard": True, "model": {"selectionScore": 0.36}},
            "full_cortex": {"passesDevelopmentGuard": True, "model": {"selectionScore": 0.37}},
        }}
        self.assertEqual(_select_development_variant(development), "full_cortex")
        rejected = {"variants": {
            "smc_only": {"passesDevelopmentGuard": False, "model": {"selectionScore": 0.99}},
        }}
        self.assertIsNone(_select_development_variant(rejected))

    def test_transformer_accepts_different_target_and_context_widths(self):
        model = CortexTransformer(target_features=73, context_features_with_age=29, slots=6, seq_len=32)
        target = torch.randn(3, 32, 73)
        context = torch.randn(3, 6, 29)
        missing = torch.zeros(3, 6, dtype=torch.bool)
        output = model(target, context, missing)
        self.assertEqual(tuple(output.shape), (3, 3))
        self.assertTrue(torch.isfinite(output).all())


if __name__ == "__main__":
    unittest.main()
