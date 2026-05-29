// engine/cairn/duration.ts — compact human duration formatter (Whd).
//
// Pure presentation helper for rendering a lead/lag in seconds as a short string
// ("1h 30m", "45s"). No scoring, no I/O, no RNG, no clock. Read-only.

/** Render a duration in seconds as a compact human string:
 *  0 → "0s", 45 → "45s", 90 → "1m 30s", 3600 → "1h", 5400 → "1h 30m".
 *  Negative durations are prefixed with "-". Fractional seconds are truncated. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds === 0) return '0s';
  const sign = seconds < 0 ? '-' : '';
  let rem = Math.abs(Math.trunc(seconds));
  const h = Math.floor(rem / 3600); rem -= h * 3600;
  const m = Math.floor(rem / 60); rem -= m * 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (rem) parts.push(`${rem}s`);
  return sign + (parts.length ? parts.join(' ') : '0s');
}
