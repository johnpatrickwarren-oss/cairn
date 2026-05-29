// engine/cairn/index.ts — Cairn module barrel (Addition #30 / Q30).

export type {
  AttributionCandidate, CandidateKind, CandidateMetadata,
  IncidentDefinition, CairnScoringConfig,
  ScoredCandidate, SuppressedCandidate, RankedAttribution,
} from './types';
export { scoreCandidate, rankCandidates } from './score';
export type { ScoreBreakdown } from './score';
export {
  candidatesFromDsAudit, candidatesFromTesseraFeed,
  candidatesFromAnvilExperiments, candidatesFromExternalEvents,
} from './ingest';
export type {
  MinimalDsRecord, MinimalTesseraPayload, MinimalAnvilExperiment,
  ExternalEvent,
} from './ingest';
export {
  calibrate, scoreScenario, reliabilityBins,
  DEFAULT_K_VALUES, DEFAULT_BIN_COUNT,
} from './calibration';
export type {
  LabeledScenario, CalibrationOptions, CalibrationReport,
  ScenarioOutcome, ReliabilityBin,
} from './types';
