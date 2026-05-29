#!/usr/bin/env node
/**
 * tools/cairn.js — Cairn (Addition #30 / PRD-30 / Q30) CLI driver.
 *
 * Structured RCA / postmortem attribution. Reads an incident definition
 * + a set of candidate cause-events from JSON, runs the Cairn scoring
 * algorithm, prints a ranked attribution report. Replay-clean: same
 * inputs → byte-identical output.
 *
 * Usage:
 *   node tools/cairn.js <incident.json> <candidates.json>
 *   node tools/cairn.js <incident.json> <candidates.json> --json
 *   node tools/cairn.js <incident.json> <candidates.json> --check <expected.json>
 *
 * Input shapes:
 *   incident.json    — IncidentDefinition object
 *   candidates.json  — object containing one or more of:
 *                        ds_records:        MinimalDsRecord[]
 *                        tessera_payloads:  MinimalTesseraPayload[]
 *                        anvil_experiments: MinimalAnvilExperiment[]
 *                        external_events:   ExternalEvent[]
 *                        config:            CairnScoringConfig (optional)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  rankCandidates,
  candidatesFromDsAudit,
  candidatesFromTesseraFeed,
  candidatesFromAnvilExperiments,
  candidatesFromExternalEvents,
  decisiveness,
  robustness,
} = require('../dist');

const REPORT_VERSION = 'v1';

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function assembleCandidates(src) {
  const out = [];
  if (Array.isArray(src.ds_records)) {
    out.push(...candidatesFromDsAudit(src.ds_records));
  }
  if (Array.isArray(src.tessera_payloads)) {
    out.push(...candidatesFromTesseraFeed(src.tessera_payloads));
  }
  if (Array.isArray(src.anvil_experiments)) {
    out.push(...candidatesFromAnvilExperiments(src.anvil_experiments));
  }
  if (Array.isArray(src.external_events)) {
    out.push(...candidatesFromExternalEvents(src.external_events));
  }
  return out;
}

function buildReport(incident, candidatesSrc, withConfidence) {
  const candidates = assembleCandidates(candidatesSrc);
  const config = candidatesSrc.config ?? {};
  const ranked = rankCandidates(candidates, incident, config);
  const report = {
    cairn_report_version: REPORT_VERSION,
    incident,
    ranked: ranked.ranked,
    suppressed: ranked.suppressed,
    config_used: ranked.config_used,
  };
  // Confidence is opt-in (Q31): when absent, the envelope is byte-identical to
  // v1, so the saved walkthrough fixture still verifies under --check.
  if (withConfidence) {
    report.confidence = {
      decisiveness: decisiveness(ranked),
      robustness: robustness(candidates, incident, config),
    };
  }
  return report;
}

function renderAscii(report) {
  const L = [];
  L.push('━'.repeat(78));
  L.push(`  Cairn attribution report — incident: ${report.incident.incident_id}`);
  L.push('━'.repeat(78));
  L.push('');
  L.push(`  Onset:    ${new Date(report.incident.onset_time_unix * 1000).toISOString()}`);
  L.push(`  Signals:  ${report.incident.affected_signals.join(', ')}`);
  if (report.incident.engine_onset_estimate) {
    const eo = report.incident.engine_onset_estimate;
    L.push(`  Engine-onset: center=${new Date(eo.center_unix * 1000).toISOString()}, σ=${eo.sigma_seconds}s`);
  }
  L.push('');
  if (report.ranked.length === 0) {
    L.push('  (no candidates ranked — all candidates either absent or suppressed)');
  } else {
    L.push('  Ranked candidates (posterior · kind · timestamp · evidence):');
    L.push('  ' + '─'.repeat(76));
    for (let i = 0; i < report.ranked.length; i++) {
      const s = report.ranked[i];
      const pct = (s.posterior * 100).toFixed(1).padStart(5);
      const kindPad = s.candidate.cause_kind.padEnd(18);
      const tsIso = new Date(s.candidate.timestamp_unix * 1000).toISOString();
      L.push(`  ${(i + 1).toString().padStart(2)}. ${pct}%  ${kindPad}  ${tsIso}`);
      L.push(`      evidence: ${s.candidate.evidence_ref}`);
      L.push(`      breakdown: kernel=${s.kernel_value.toFixed(4)} × prior=${s.kind_prior.toFixed(2)} × evidence_boost=${s.evidence_boost.toFixed(2)} = score ${s.raw_score.toExponential(3)}`);
      L.push('');
    }
  }
  if (report.suppressed.length > 0) {
    L.push('  Suppressed (mechanistically inconsistent):');
    L.push('  ' + '─'.repeat(76));
    for (const sup of report.suppressed) {
      const tsIso = new Date(sup.candidate.timestamp_unix * 1000).toISOString();
      L.push(`  · [${sup.suppression_reason}] ${sup.candidate.cause_kind}: ${sup.candidate.cause_id}`);
      L.push(`      timestamp: ${tsIso}`);
      L.push(`      evidence:  ${sup.candidate.evidence_ref}`);
    }
    L.push('');
  }
  if (report.confidence) {
    const d = report.confidence.decisiveness;
    const r = report.confidence.robustness;
    L.push('  Confidence & robustness:');
    L.push('  ' + '─'.repeat(76));
    L.push(`  · decisiveness: ${d.label.toUpperCase()} (top-margin ${(d.top_margin * 100).toFixed(1)}%, normalized entropy ${d.entropy_normalized.toFixed(3)})`);
    L.push(`  · robustness:   top rank held in ${(r.top_stability * 100).toFixed(0)}% of ${r.trials.length} onset-perturbation trials (σ=${r.onset_sigma_seconds_used}s)`);
    if (r.flips.length > 0) {
      L.push(`      ⚠ rank flips under onset shift:`);
      for (const f of r.flips) {
        const sign = f.offset_seconds >= 0 ? '+' : '';
        L.push(`        onset ${sign}${f.offset_seconds}s (${f.sigma_multiple}σ) → top becomes ${f.top_cause_id}`);
      }
    }
    L.push('');
  }
  L.push('  Note: Cairn does alignment-based ranked attribution, not Pearl-style');
  L.push('  causal inference. Posteriors reflect timing-consistency under the');
  L.push('  configured per-kind kernel + prior + evidence-quality boost. The');
  L.push('  postmortem narrative is the human; Cairn supplies the ranked candidates.');
  L.push('━'.repeat(78));
  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: node tools/cairn.js <incident.json> <candidates.json> [--json] [--confidence] [--check <expected.json>]');
    process.exit(2);
  }
  const incidentPath = args[0];
  const candidatesPath = args[1];
  const jsonOut = args.includes('--json');
  const checkIdx = args.indexOf('--check');
  const checkPath = checkIdx >= 0 ? args[checkIdx + 1] : null;
  // --check replays the v1 (no-confidence) report against the saved fixture,
  // so confidence is suppressed in that path regardless of the flag (Q31).
  const withConfidence = args.includes('--confidence') && !checkPath;

  const incident = loadJson(incidentPath);
  const candidatesSrc = loadJson(candidatesPath);
  const report = buildReport(incident, candidatesSrc, withConfidence);

  if (checkPath) {
    const expected = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
    const actual = JSON.parse(JSON.stringify(report));
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      console.error('[--check] Cairn report does not match expected output');
      process.exit(1);
    }
    console.log('[--check] Cairn report matches expected output.');
    return;
  }

  if (jsonOut) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(renderAscii(report));
  }
}

main();
