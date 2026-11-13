# KINGBOT Quantum Research Lab (isolated / offline)

This package creates a safe research boundary for evaluating relevant parts of Google Quantum AI's Qualtran. It is not a quantum-enhanced live trading engine. It does not connect to brokers, market feeds, model stores, the worker, or order execution.

## What the supplied archive contains

The supplied source snapshot identifies itself as version 0.8.0.dev0 in qualtran/_version.py while its CITATION.cff still lists 0.6.0. Treat it as a development snapshot, not a production pin. Qualtran is an experimental library for expressing, simulating and estimating fault-tolerant quantum algorithms. The optional research environment pins the stable 0.7.0 release for reproducibility rather than tracking upstream main.

## Selected capabilities and KINGBOT relevance

| Qualtran capability | KINGBOT research use | Limitation |
|---|---|---|
| QROM, QROAMClean, SelectSwapQROM | Encode discretized trade-loss arrays for a future quantum circuit | Circuit data-loading primitives; not a market-data API or cache |
| StatePreparationAliasSampling | Prepare probability distributions from historical trade outcomes | Does not calculate VaR by itself |
| MeanEstimationOperator and phase estimation | Future Monte Carlo estimates of expected loss and tail risk | Requires a complete oracle/circuit formulation and suitable quantum hardware |
| AlgorithmSummary, QECGatesCost, QubitCount | Count logical gates, T-cost and algorithm qubits | Useful after an actual circuit exists |
| PhysicalCostModel, surface-code and FLASQ tools | Scenario estimates for physical qubits, runtime and hardware failure | Literature assumptions, not measured device capability |
| Rotation synthesis / Clifford+T | Estimate and reduce compiled rotation costs | Compiler research only; no live ML benefit |
| Cirq interop, simulation and QLT IR | Circuit exchange, small-circuit tests and serialization | Research tooling; the supplied Rust fast simulator is experimental and basis-state-oriented |

## What is not in the archive

The archive is not a forex/XAUUSD predictor, SMC detector, ICT pattern engine, brokerage connector or production portfolio optimizer. Its optimization examples include a specialized planted noisy k-XOR-SAT/Kikuchi algorithm, not a drop-in portfolio optimizer. Quantum speedup primitives must not be presented as a live-market accuracy improvement without an end-to-end formulation, hardware path and matched empirical benchmark.

## What this integration adds

1. market_risk.py converts completed net trade PnL samples after spread, commission, swap and slippage into a reproducible loss histogram. It reports empirical expected loss, VaR and CVaR with integer-coded values, exact counts, probability denominators and fixed-point register widths for future QROM/state-preparation research.
2. qualtran_adapter.py lazily imports Qualtran only when a researcher explicitly supplies a Bloq. It returns logical gate/qubit counts and optional, clearly labelled Gidney-Fowler or Beverland physical-resource scenarios.
3. Unit tests validate histogram conservation, tail-risk calculations, input rejection, adapter serialization and the research-only boundary without installing Qualtran in the normal CI runner.

## Running the research code

From the repository root, import build_loss_distribution from research.quantum_lab.market_risk and pass completed trade net PnL values after all trading costs. R-multiples are preferred when comparing instruments. The returned record marks itself OFFLINE_RESEARCH_ONLY and has both can_generate_trade_signal and can_place_order set to false.

For Qualtran experiments, create a separate Python environment and install research/quantum_lab/requirements.txt there. Do not install this dependency into Render, the live ML service or the regular ML requirements. Construct and test a Qualtran Bloq first, then pass it to estimate_qualtran_bloq in qualtran_adapter.py. Physical-cost scenarios use literature assumptions and are not hardware benchmarks.

## KINGBOT integration guardrails

- Do not import this package from ml-signal-service/service.py or backend runtime code.
- Do not add Qualtran to ml-signal-service/requirements.txt, root requirements.txt, backend/package.json or render.yaml.
- Do not route research outputs into the live strategy council, confidence threshold, risk governor, broker adapter or order executor.
- No V9/V10 champion, challenger, blend, calibration or acceptance threshold is changed.
- Any future signal-facing use requires a separate research PR, matched walk-forward backtest, transaction-cost/slippage evaluation, shadow period and explicit approval.

## Attribution and licence

Qualtran is maintained by Google Quantum AI and is licensed under Apache-2.0. This integration references the package through an optional dependency; it does not vendor or copy upstream implementation files. See the Qualtran upstream LICENSE, documentation and release notes.
