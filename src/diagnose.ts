// Plain-English verdicts. Each verdict is ≤2 lines: a one-line title and a
// one-line detail citing the evidence behind the call. We never name the
// vendor in a verdict — the CDN is shown once at the top of the report.

import type { ProbeResult } from './probe.ts';
import type { NormalizedReport } from './normalize.ts';

export type VerdictLevel = 'good' | 'warn' | 'bad' | 'info';

export type Verdict = {
  level: VerdictLevel;
  title: string;
  detail: string;
};

export type DiagnoseInput = {
  primary: { probe: ProbeResult; report: NormalizedReport };
  second?: { probe: ProbeResult; report: NormalizedReport; cold: boolean };
};

const SLOW_DNS_MS = 100;
const SLOW_TLS_MS = 200;
const SLOW_TTFB_MS = 800;
const FAST_TTFB_MS = 100;
const SLOW_ORIGIN_MS = 500;

export function diagnose(input: DiagnoseInput): Verdict[] {
  const { primary, second } = input;
  const v: Verdict[] = [];
  const r = primary.report;
  const t = primary.probe.timings;

  // 1. CDN identification.
  if (r.cdn === 'unknown') {
    v.push({
      level: 'info',
      title: 'No major CDN signature found',
      detail: 'Headers do not match a known fingerprint. Could be a custom CDN, white-label, or no CDN at all.',
    });
  } else {
    const exposed = r.exposedDebugHeaders.length;
    v.push({
      level: 'info',
      title: 'CDN identified',
      detail: `${exposed} of ${r.expectedDebugHeaders} expected debug headers exposed.`,
    });
  }

  // 2. Cache verdict.
  if (r.cache === 'HIT') {
    v.push({
      level: 'good',
      title: 'Cache HIT',
      detail: 'Edge served from cache. Origin not contacted.',
    });
  } else if (r.cache === 'MISS') {
    if (r.originFetchMs !== undefined) {
      v.push({
        level: 'warn',
        title: 'Cache MISS',
        detail: `Origin returned ${r.originStatus ?? '?'} in ${r.originFetchMs}ms (per cdn-requesttime).`,
      });
    } else {
      v.push({
        level: 'warn',
        title: 'Cache MISS',
        detail: 'Edge had to consult origin. Re-run to confirm cache warms (or use --cold to compare).',
      });
    }
  } else if (r.cache === 'EXPIRED' || r.cache === 'REVALIDATED' || r.cache === 'STALE') {
    v.push({
      level: 'warn',
      title: `Cache ${r.cache}`,
      detail: 'Edge had a stale copy and consulted origin to refresh.',
    });
  } else if (r.cache === 'BYPASS' || r.cache === 'DYNAMIC' || r.cache === 'PASS') {
    v.push({
      level: 'info',
      title: `Cache ${r.cache}`,
      detail: 'This response was not cached. Check Cache-Control / response status if that\'s unexpected.',
    });
  } else if (r.cdn !== 'unknown' && r.cache === 'UNKNOWN') {
    v.push({
      level: 'info',
      title: 'Cache status not exposed',
      detail: 'CDN did not include a cache-status header on this response.',
    });
  }

  // 3. Latency verdicts.
  if (t.dnsMs !== null && t.dnsMs > SLOW_DNS_MS) {
    v.push({
      level: 'warn',
      title: `DNS slow: ${fmtMs(t.dnsMs)}`,
      detail: 'Faster DNS provider or longer client TTLs would help.',
    });
  }
  if (t.tlsMs !== null && t.tlsMs > SLOW_TLS_MS) {
    v.push({
      level: 'warn',
      title: `TLS handshake slow: ${fmtMs(t.tlsMs)}`,
      detail: 'Distance to nearest POP, or session resumption / HTTP/3 not negotiated.',
    });
  }

  // 4. TTFB verdict (paired with cache state for context).
  if (t.ttfbMs > SLOW_TTFB_MS && r.cache === 'HIT') {
    v.push({
      level: 'bad',
      title: `TTFB ${fmtMs(t.ttfbMs)} despite cache HIT`,
      detail: 'Edge served from cache but slowly. Likely network distance to your nearest POP.',
    });
  } else if (t.ttfbMs > SLOW_TTFB_MS) {
    v.push({
      level: 'bad',
      title: `TTFB ${fmtMs(t.ttfbMs)}`,
      detail: 'Slow first byte. Re-run to compare warm vs. cold; origin is the prime suspect.',
    });
  } else if (t.ttfbMs < FAST_TTFB_MS && r.cache === 'HIT') {
    v.push({
      level: 'good',
      title: `TTFB ${fmtMs(t.ttfbMs)}`,
      detail: 'Excellent first-byte latency. Edge is doing its job.',
    });
  }

  // 5. Origin attribution (bunny-only data).
  if (r.originFetchMs !== undefined && r.originFetchMs > SLOW_ORIGIN_MS) {
    v.push({
      level: 'bad',
      title: `Origin fetch took ${r.originFetchMs}ms`,
      detail: r.originStatus
        ? `Origin returned ${r.originStatus}. The slow is at your origin, not the edge.`
        : 'The slow is at your origin, not the edge.',
    });
  }

  // 6. Two-probe comparison.
  if (second) {
    const delta = primary.probe.timings.ttfbMs - second.probe.timings.ttfbMs;
    const firstCache = primary.report.cache;
    const secondCache = second.report.cache;
    const label = second.cold ? 'cold (cache-busted)' : 'second probe';

    if (firstCache === 'MISS' && secondCache === 'HIT' && delta > 50) {
      v.push({
        level: 'good',
        title: `Cache warmed: ${fmtMs(delta)} faster on second probe`,
        detail: `First probe MISS at ${fmtMs(primary.probe.timings.ttfbMs)}; second probe HIT at ${fmtMs(second.probe.timings.ttfbMs)}.`,
      });
    } else if (firstCache === 'MISS' && secondCache === 'MISS') {
      v.push({
        level: 'bad',
        title: 'Cache did not warm',
        detail: 'Second probe also MISS. Either uncacheable or cache configuration has issues.',
      });
    } else if (firstCache === 'HIT' && secondCache === 'HIT') {
      const detail = second.cold
        ? `Both probes HIT — cold probe also HIT (perma-cache or pre-warmed). TTFB: ${fmtMs(second.probe.timings.ttfbMs)}.`
        : `Both probes HIT. Second TTFB: ${fmtMs(second.probe.timings.ttfbMs)}.`;
      v.push({ level: 'info', title: 'Cache stayed warm', detail });
    } else if (second.cold && firstCache === 'HIT' && secondCache === 'MISS' && delta < 0) {
      v.push({
        level: 'info',
        title: `Cache effect: ${fmtMs(Math.abs(delta))} saved`,
        detail: `Warm probe: ${fmtMs(primary.probe.timings.ttfbMs)}. Cold probe: ${fmtMs(second.probe.timings.ttfbMs)}.`,
      });
    }
  }

  // 7. HTTP/3 advertised but not negotiated.
  if (primary.probe.altSvc?.includes('h3=') && primary.probe.timings.httpVersion !== '3') {
    v.push({
      level: 'info',
      title: 'HTTP/3 available, not used',
      detail: 'alt-svc advertises h3. This tool used HTTP/1.1 (Node\'s https module does not speak HTTP/3 yet).',
    });
  }

  return v;
}

function fmtMs(n: number): string {
  return `${Math.round(n)}ms`;
}
