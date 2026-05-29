// engine/cairn/index.ts — Cairn module barrel (Addition #30 / Q30).

export type {
  AttributionCandidate, CandidateKind, CandidateMetadata,
  IncidentDefinition, CairnScoringConfig,
  ScoredCandidate, SuppressedCandidate, RankedAttribution,
} from './types';
export { scoreCandidate, rankCandidates } from './score';
export type { ScoreBreakdown } from './score';
export { priorSensitivity } from './prior-sensitivity';
export type { PriorSensitivity } from './prior-sensitivity';
export {
  candidatesFromDsAudit, candidatesFromTesseraFeed,
  candidatesFromAnvilExperiments, candidatesFromExternalEvents,
} from './ingest';
export type {
  MinimalDsRecord, MinimalTesseraPayload, MinimalAnvilExperiment,
  ExternalEvent,
} from './ingest';
export { coverageDiagnostic } from './coverage';
export type { CoverageDiagnostic } from './coverage';
export { attributionSummary } from './summary';
export type { AttributionSummary } from './summary';
export {
  decisiveness, robustness,
  DEFAULT_DECISIVE_MARGIN, DEFAULT_CONTESTED_MARGIN,
  DEFAULT_ONSET_JITTER_SECONDS, DEFAULT_SIGMA_MULTIPLIERS,
} from './confidence';
export {
  calibrate, scoreScenario, reliabilityBins,
  DEFAULT_K_VALUES, DEFAULT_BIN_COUNT,
} from './calibration';
export type {
  Decisiveness, DecisivenessThresholds,
  RobustnessOptions, RobustnessTrial, RobustnessReport,
  LabeledScenario, CalibrationOptions, CalibrationReport,
  ScenarioOutcome, ReliabilityBin,
} from './types';
