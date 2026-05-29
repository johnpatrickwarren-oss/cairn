#!/usr/bin/env node
/**
 * tools/cairn-calibrate.js — Cairn calibration / backtesting CLI (Q32).
 *
 * Backtests the v1 scorer over a set of LABELED incidents (each carrying the
 * post-confirmed true cause) and prints accuracy + calibration metrics:
 * top-1/top-k accuracy, MRR, multi-class Brier, a reliability table, and ECE.
 * Measurement only — never mutates the scorer. Replay-clean.
 *
 * Usage:
 *   node tools/cairn-calibrate.js <scenarios.json>
 *   node tools/cairn-calibrate.js <scenarios.json> --json
 *
 * Input shape (scenarios.json):
 *   {
 *     "scenarios": LabeledScenario[],   // { incident, candidates, config?, true_cause_id }
 *     "options":   CalibrationOptions   // optional { k_values?, bin_count? }
 *   }
 */

'use strict';

const fs = require('node:fs');
const { calibrate } = require('../dist');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function renderAscii(report) {
  const L = [];
  L.push('━'.repeat(78));
  L.push(`  Cairn calibration report — ${report.n} labeled scenario(s)`);
  L.push('━'.repeat(78));
  L.push('');
  L.push(`  top-1 accuracy: ${(report.top1_accuracy * 100).toFixed(1)}%`);
  for (const t of report.topk_accuracy) {
    if (t.k === 1) continue;
    L.push(`  top-${t.k} accuracy: ${(t.accuracy * 100).toFixed(1)}%`);
  }
  L.push(`  MRR:            ${report.mrr.toFixed(4)}`);
  L.push(`  Brier score:    ${report.brier_score.toFixed(4)}   (lower = better calibrated)`);
  L.push(`  ECE:            ${report.ece.toFixed(4)}   (expected calibration error)`);
  L.push('');
  if (report.reliability_bins.length > 0) {
    L.push('  Reliability (top-candidate confidence vs empirical accuracy):');
    L.push('  ' + '─'.repeat(76));
    L.push('    bin            n   mean-conf   empirical-acc   gap');
    for (const b of report.reliability_bins) {
      const bin = `[${b.lower.toFixed(1)},${b.upper.toFixed(1)})`.padEnd(12);
      const gap = b.mean_confidence - b.empirical_accuracy;
      L.push(
        `    ${bin} ${String(b.count).padStart(3)}   ` +
        `${(b.mean_confidence * 100).toFixed(1).padStart(7)}%   ` +
        `${(b.empirical_accuracy * 100).toFixed(1).padStart(9)}%   ` +
        `${(gap >= 0 ? '+' : '') + (gap * 100).toFixed(1)}%`,
      );
    }
    L.push('');
  }
  L.push('  Per-scenario:');
  L.push('  ' + '─'.repeat(76));
  for (const o of report.per_scenario) {
    const mark = o.top_correct ? '✓' : '✗';
    const rank = o.true_cause_rank === null ? 'suppressed/absent' : `rank ${o.true_cause_rank}`;
    L.push(`  ${mark} ${o.incident_id}: true=${o.true_cause_id} (${rank}, p=${o.true_cause_posterior.toFixed(3)}); ` +
      `predicted=${o.predicted_top_cause_id ?? 'none'} @ ${(o.top_confidence * 100).toFixed(1)}%`);
  }
  L.push('');
  L.push('  Note: calibration MEASURES the v1 scorer; it never tunes it. Metrics');
  L.push('  describe ranking accuracy + posterior calibration, not causal correctness.');
  L.push('━'.repeat(78));
  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('usage: node tools/cairn-calibrate.js <scenarios.json> [--json]');
    process.exit(2);
  }
  const src = loadJson(args[0]);
  const report = calibrate(src.scenarios ?? [], src.options ?? {});

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(renderAscii(report));
  }
}

main();
