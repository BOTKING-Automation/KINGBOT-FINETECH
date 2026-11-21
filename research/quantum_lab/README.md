# KINGBOT Quantum Research Lab (isolated / offline)

This package is an isolated research area for evaluating relevant parts of Google Quantum AI's Qualtran. It is not a quantum-enhanced live trading engine. It does not connect to brokers, market feeds, model stores, workers or order execution.

## What the supplied archive contains

The uploaded source snapshot reports version 0.8.0.dev0 in qualtran/_version.py while its CITATION.cff lists 0.6.0. That is a development snapshot rather than a reproducible dependency pin. The research environment pins the stable Qualtran 0.7.0 release. Qualtran itself describes the package as an experimental preview and does not promise backwards compatibility.

## Selected Qualtran capabilities

| Capability | KINGBOT research application | Limitation |
|---|---|---|
| QROM, QROAMClean, SelectSwapQROM | Encode discretized trade outcomes for circuit data loading | Circuit primitives, not a market-data API |
| StatePreparationAliasSampling | Prepare probability states from historical closed-trade outcomes | Does not calculate VaR by itself |
| MeanEstimationOperator and TextbookQPE | Build and resource-count a mean-estimation / phase-estimation Bloq for a tail-event indicator | Research circuit only; it is not run on hardware here |
| AlgorithmSummary, QECGatesCost, QubitCount | Estimate logical gates, T-cost and algorithm qubits | Counts the circuit model; it does not prove practical speedup |
| PhysicalCostModel | Estimate physical-qubit, runtime and logical-error scenarios | Literature-based assumptions, not measured hardware |
| Rotation synthesis and Clifford+T | Study fault-tolerant compilation costs | No direct live ML benefit |
| Cirq interoperability, simulation and QLT IR | Small-circuit inspection and exchange | Research tooling, not a trading service |

The supplied library also contains specialized quantum optimization algorithms, including planted noisy k-XOR-SAT/Kikuchi examples. These are not drop-in portfolio or forex optimizers.

## XAUUSD trade dataset

Use the provided xauusd-trade-outcomes.template.csv. Required fields:

- trade_id: unique ID within the file; never include broker credentials.
- closed_at: ISO-8601 timestamp with an explicit timezone.
- symbol: XAUUSD, XAUUSDm or GOLD.
- net_pnl_after_costs_r: net trade result in R-multiples after spread, commission, swap and slippage.

Instead of net_pnl_after_costs_r, you may supply the complete cash ledger: gross_pnl_cash, commission_cash, swap_cash, spread_cost_cash, slippage_cost_cash and initial_risk_cash. Commission and swap use signed ledger values; spread and slippage must be non-negative costs; initial_risk_cash must be positive. The loader computes net R as (gross + commission + swap - spread - slippage) / initial risk.

Rows must be chronological and timestamps timezone-aware. The loader rejects mixed instruments, non-finite outcomes, ambiguous PnL schemas and duplicate trade IDs. It normalizes timestamps to UTC. Do not put account numbers, names, broker tokens or other identifying information into the research CSV.

The 30-trade marker in reports is only a minimum record-count check; it does not guarantee statistical power or stable tail estimates. Larger independent histories and regime-separated analyses are preferable.

## Classical baseline and quantum estimand

The pipeline runs two distinct baselines:

1. Classical Monte Carlo bootstraps paths of closed-trade net R outcomes. IID mode samples individual trades; circular moving-block mode preserves short local sequences. It reports horizon PnL, maximum drawdown, loss VaR/CVaR and the probability a simulated horizon loses more than the selected threshold.
2. Tail-probability estimation compares a classical Bernoulli Monte Carlo Hoeffding sample bound with an ideal textbook amplitude-estimation query bound for the same single-trade event: loss in R is greater than or equal to the selected threshold.

The QAE query comparison is theory-only. It excludes preparing and loading the empirical distribution, inverse state preparation, the controlled oracle and uncomputation costs, physical error correction, noise, readout, calibration and queue latency. It must not be presented as an end-to-end quantum speedup.

When Qualtran is installed in the separate environment, estimate_xauusd_tail_probability_bloq constructs a real Bloq composition using StatePreparationAliasSampling, MeanEstimationOperator and TextbookQPE. A one-bit SELECT oracle marks each original trade outcome, not a coarse histogram mean, so the empirical threshold event is not changed by binning. AlgorithmSummary then estimates logical resources. Optional physical resource models are literature scenarios.

No quantum hardware is connected and no quantum measurement is performed. The reported tail probability is an empirical classical value used to define and validate the circuit's estimand.

### Qualtran 0.7.0 resource-counting limitation observed in CI

The dedicated interop job installs Qualtran 0.7.0 and constructs the empirical-tail
StatePreparationAliasSampling → MeanEstimationOperator → TextbookQPE composition.
On the four-outcome test fixture, Qualtran counts the state-preparation component as
79 algorithm qubits and approximately 132 T gates. The uncontrolled mean-estimation
component reports 79 qubits and a symbolic T expression (4096*_c0 + 727), not a
numerical total.

The complete controlled QPE resource walk is blocked by Qualtran's controlled atomic
And decomposition (C[And], "And is atomic"). The adapter reports this limitation and
does not claim a complete QPE T-count, total logical-qubit requirement, physical-qubit
estimate, or runtime. These small-fixture component figures are not XAUUSD performance
data and are not additive end-to-end QPE costs.

## Run the offline study

From the repository root, prepare a private CSV following the schema above, then run:

python -m research.quantum_lab.run_research --trades-csv /path/to/xauusd-trades.csv --output /path/to/xauusd-research.json

Optional settings include --simulations, --horizon-trades, --block-length, --seed, --loss-threshold-r, --error and --confidence.

To include Qualtran logical-resource estimation, first create a dedicated research virtual environment and install research/quantum_lab/requirements.txt. Then add --with-qualtran-resource-estimate. Optional physical scenario estimates can be requested with --physical-model gidney-fowler or --physical-model beverland-et-al. The optional install and circuit resource-count test run in a separate GitHub Actions job.

## Guardrails

- Do not import this package from ml-signal-service/service.py or backend runtime code.
- Do not add Qualtran to ml-signal-service/requirements.txt, root requirements.txt, backend/package.json or render.yaml.
- Do not route research outputs into the live strategy council, confidence threshold, risk governor, broker adapter or order executor.
- No V9/V10 champion, challenger, blend, calibration or acceptance threshold is changed.
- Any future signal-facing use requires a separate research PR, matched walk-forward benchmark, transaction-cost/slippage analysis, shadow deployment and explicit approval.

## Attribution and licence

Qualtran is maintained by Google Quantum AI and is licensed under Apache-2.0. The integration references it as an optional dependency and does not vendor upstream implementation files. See the upstream project documentation and release notes.
