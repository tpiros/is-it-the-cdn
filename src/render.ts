// Terminal output. Hand-rolled ANSI; no dependencies.
//
// Layout (top to bottom):
//   header   — tool name + final URL
//   identity — CDN, POP, server, request id, pull zone, viewer GeoIP
//   status   — HTTP status, version, remote IP
//   cache    — cache state, age, cached-at, origin attribution (bunny only)
//   timings  — DNS / TCP / TLS / TTFB / Total
//   probes   — when --once is not set, two-line comparison
//   diagnosis— verdicts (1–7 of them, 2 lines each)
//   debug    — debug-header transparency callout

import type { ProbeResult } from './probe.ts';
import type { NormalizedReport } from './normalize.ts';
import type { Verdict } from './diagnose.ts';
import { labelCdn } from './fingerprint.ts';

const ANSI = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  gray:  '\x1b[90m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  blue:  '\x1b[34m',
  cyan:  '\x1b[36m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (color: string, s: string): string => useColor ? `${color}${s}${ANSI.reset}` : s;

export type RenderInput = {
  primary: { probe: ProbeResult; report: NormalizedReport };
  second?: { probe: ProbeResult; report: NormalizedReport; cold: boolean };
  verdicts: Verdict[];
  showRaw: boolean;
};

export function renderHuman(input: RenderInput): string {
  const { primary, second, verdicts, showRaw } = input;
  const r = primary.report;
  const p = primary.probe;
  const lines: string[] = [];

  lines.push('');
  lines.push(paint(ANSI.bold, 'is-it-the-cdn') + paint(ANSI.gray, `  →  ${p.finalUrl}`));
  lines.push(paint(ANSI.gray, '─'.repeat(72)));

  // Identity
  lines.push(`${kv('CDN')}${labelCdn(r.cdn)}`);
  if (r.pop) {
    const loc = r.pop.location ? paint(ANSI.gray, `  (${r.pop.location})`) : '';
    lines.push(`${kv('POP')}${r.pop.code}${loc}`);
  }
  if (r.serverId)    lines.push(`${kv('Server')}${paint(ANSI.gray, r.serverId)}`);
  if (r.requestId)   lines.push(`${kv('Request ID')}${paint(ANSI.gray, r.requestId)}`);
  if (r.pullZone)    lines.push(`${kv('Pull zone')}${paint(ANSI.gray, r.pullZone)}`);
  if (r.viewerCountry) lines.push(`${kv('Viewer GeoIP')}${r.viewerCountry}`);
  lines.push('');

  // Status / transport
  lines.push(`${kv('Status')}${p.status}`);
  const altSvc = p.altSvc ? paint(ANSI.gray, `   alt-svc: ${p.altSvc}`) : '';
  lines.push(`${kv('HTTP')}HTTP/${p.timings.httpVersion}${altSvc}`);
  if (p.timings.remoteAddress) {
    const fam = p.timings.remoteFamily ? paint(ANSI.gray, ` (${p.timings.remoteFamily})`) : '';
    lines.push(`${kv('Remote IP')}${p.timings.remoteAddress}${fam}`);
  }
  lines.push('');

  // Cache
  const cacheColor = r.cache === 'HIT' ? ANSI.green
    : r.cache === 'MISS' || r.cache === 'EXPIRED' || r.cache === 'STALE' ? ANSI.yellow
    : ANSI.gray;
  const rawCache = r.cacheRaw && r.cacheRaw.toUpperCase() !== r.cache ? paint(ANSI.gray, `   raw: ${r.cacheRaw}`) : '';
  lines.push(`${kv('Cache')}${paint(cacheColor, r.cache)}${rawCache}`);
  if (r.ageSeconds !== undefined) lines.push(`${kv('Age')}${r.ageSeconds}s`);
  if (r.cachedAt)                 lines.push(`${kv('Cached at')}${paint(ANSI.gray, r.cachedAt)}`);
  if (r.originStatus !== undefined) lines.push(`${kv('Origin status')}${r.originStatus}`);
  if (r.originFetchMs !== undefined) {
    lines.push(`${kv('Origin fetch')}${r.originFetchMs}ms ${paint(ANSI.gray, '(reported by edge)')}`);
  }
  lines.push('');

  // Timings
  lines.push(paint(ANSI.bold, 'Timings'));
  lines.push(`  ${paint(ANSI.gray, 'DNS         ')}${fmtMs(p.timings.dnsMs)}`);
  lines.push(`  ${paint(ANSI.gray, 'TCP         ')}${fmtMs(p.timings.tcpMs)}`);
  lines.push(`  ${paint(ANSI.gray, 'TLS         ')}${fmtMs(p.timings.tlsMs)}`);
  lines.push(`  ${paint(ANSI.gray, 'TTFB        ')}${fmtMs(p.timings.ttfbMs)}`);
  lines.push(`  ${paint(ANSI.gray, 'Total       ')}${fmtMs(p.timings.totalMs)}`);
  lines.push('');

  // Probe comparison
  if (second) {
    lines.push(paint(ANSI.bold, 'Probes'));
    lines.push(`  1: cache ${paint(cacheColor, r.cache.padEnd(7))} ttfb ${fmtMs(p.timings.ttfbMs)}`);
    const sCol = second.report.cache === 'HIT' ? ANSI.green
      : second.report.cache === 'MISS' ? ANSI.yellow
      : ANSI.gray;
    const tag = second.cold ? paint(ANSI.gray, '  (cold / cache-busted)') : '';
    lines.push(`  2: cache ${paint(sCol, second.report.cache.padEnd(7))} ttfb ${fmtMs(second.probe.timings.ttfbMs)}${tag}`);
    lines.push('');
  }

  // Diagnosis
  lines.push(paint(ANSI.bold, 'Diagnosis'));
  for (const v of verdicts) {
    const icon = v.level === 'good' ? paint(ANSI.green, '✓')
      : v.level === 'bad'  ? paint(ANSI.red, '✗')
      : v.level === 'warn' ? paint(ANSI.yellow, '!')
      :                      paint(ANSI.cyan, 'i');
    lines.push(`  ${icon} ${paint(ANSI.bold, v.title)}`);
    lines.push(`    ${paint(ANSI.gray, v.detail)}`);
  }
  lines.push('');

  // Transparency callout
  if (r.cdn !== 'unknown') {
    lines.push(paint(ANSI.bold, 'Debug headers exposed'));
    lines.push(`  ${r.exposedDebugHeaders.length} of ${r.expectedDebugHeaders} expected for ${labelCdn(r.cdn)}`);
    if (r.exposedDebugHeaders.length > 0) {
      lines.push(`  ${paint(ANSI.gray, r.exposedDebugHeaders.join(', '))}`);
    }
    lines.push('');
  }

  // Raw headers
  if (showRaw) {
    lines.push(paint(ANSI.bold, 'Raw response headers'));
    for (const [k, val] of Object.entries(p.headers)) {
      lines.push(`  ${paint(ANSI.gray, k + ':')} ${val}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function kv(label: string): string {
  // Two-column layout: 16-char label, value follows.
  const padded = label.padEnd(16);
  return paint(ANSI.bold, padded);
}

function fmtMs(n: number | null): string {
  if (n === null) return paint(ANSI.gray, '   —');
  const s = `${Math.round(n).toString().padStart(4, ' ')}ms`;
  if (n < 50)  return paint(ANSI.green, s);
  if (n < 200) return paint(ANSI.cyan, s);
  if (n < 500) return paint(ANSI.yellow, s);
  return paint(ANSI.red, s);
}
