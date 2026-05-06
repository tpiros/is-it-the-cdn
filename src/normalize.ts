// Normalize each CDN's debug headers into a single shape so the diagnosis
// and renderer don't have to know which vendor served the response.
//
// The full debug-header allowlist for each CDN is duplicated from
// scripts/measure-headers.ts so the count shown in the tool's output matches
// the count in the README's table — verifiable side-by-side.

import type { ProbeResult } from './probe.ts';
import type { CdnId } from './fingerprint.ts';
import { lookupPop } from './pops.ts';

export type CacheState =
  | 'HIT' | 'MISS' | 'EXPIRED' | 'STALE'
  | 'BYPASS' | 'DYNAMIC' | 'PASS' | 'REVALIDATED'
  | 'UNKNOWN';

export type NormalizedReport = {
  cdn: CdnId;
  cache: CacheState;
  cacheRaw?: string;
  pop?: { code: string; location?: string };
  serverId?: string;
  requestId?: string;
  pullZone?: string;
  cachedAt?: string;
  ageSeconds?: number;
  originStatus?: number;       // bunny exclusive (cdn-requestpullcode)
  originFetchMs?: number;      // bunny exclusive (cdn-requesttime)
  viewerCountry?: string;      // bunny exclusive (cdn-requestcountrycode)
  exposedDebugHeaders: string[];
  expectedDebugHeaders: number;
};

const DEBUG_HEADERS: Record<CdnId, string[]> = {
  bunny: [
    'cdn-cache', 'cdn-pullzone', 'cdn-requestcountrycode', 'cdn-storageserver',
    'cdn-fileserver', 'cdn-proxyver', 'cdn-requestpullsuccess', 'cdn-requestpullcode',
    'cdn-cachedat', 'cdn-edgestorageid', 'cdn-requestid', 'cdn-status',
    'cdn-requesttime', 'server',
  ],
  cloudflare: ['cf-ray', 'cf-cache-status', 'cf-apo-via', 'speculation-rules', 'server'],
  fastly: ['x-served-by', 'x-cache', 'x-cache-hits', 'x-timer', 'server-timing', 'via', 'fastly-debug-path', 'server'],
  cloudfront: ['via', 'x-amz-cf-pop', 'x-amz-cf-id', 'x-cache'],
  akamai: ['x-akam-sw-version', 'akamai-grn', 'server-timing', 'server', 'x-akamai-transformed', 'x-akamai-request-id'],
  vercel: ['x-vercel-cache', 'x-vercel-id', 'server', 'x-matched-path', 'age'],
  netlify: ['x-nf-request-id', 'server', 'cache-status', 'server-timing', 'age', 'x-nf-cache'],
  unknown: [],
};

export function normalize(result: ProbeResult, cdn: CdnId): NormalizedReport {
  const h = result.headers;
  const exposed = DEBUG_HEADERS[cdn].filter((k) => k in h);

  const r: NormalizedReport = {
    cdn,
    cache: 'UNKNOWN',
    exposedDebugHeaders: exposed,
    expectedDebugHeaders: DEBUG_HEADERS[cdn].length,
  };

  switch (cdn) {
    case 'bunny': {
      r.cache = parseCache(h['cdn-cache']);
      r.cacheRaw = h['cdn-cache'];
      const sp = parseBunnyServer(h.server);
      if (sp) {
        r.pop = { code: sp.popCode, location: lookupPop(sp.popCode) };
        r.serverId = sp.serverId;
      }
      r.requestId = h['cdn-requestid'];
      r.pullZone = h['cdn-pullzone'];
      r.cachedAt = h['cdn-cachedat'];
      r.viewerCountry = h['cdn-requestcountrycode'];
      const pull = parseInt(h['cdn-requestpullcode'] ?? '', 10);
      r.originStatus = Number.isFinite(pull) && pull > 0 ? pull : undefined;
      const fetched = parseInt(h['cdn-requesttime'] ?? '', 10);
      r.originFetchMs = Number.isFinite(fetched) ? fetched : undefined;
      break;
    }

    case 'cloudflare': {
      r.cache = parseCache(h['cf-cache-status']);
      r.cacheRaw = h['cf-cache-status'];
      const cf = parseCfRay(h['cf-ray']);
      if (cf) {
        r.pop = { code: cf.pop, location: lookupPop(cf.pop) };
        r.requestId = cf.rayId;
      }
      break;
    }

    case 'fastly': {
      // Fastly's x-cache may be a chain, e.g. "MISS, HIT, HIT" — the last
      // entry is what the edge serving the user did.
      const xc = h['x-cache'];
      r.cacheRaw = xc;
      if (xc) {
        const last = xc.split(',').map((s) => s.trim()).pop()?.toUpperCase();
        if (last) r.cache = parseCache(last);
      }
      const xs = h['x-served-by'];
      if (xs) {
        const lastNode = xs.split(',').map((s) => s.trim()).pop() ?? '';
        const m = lastNode.match(/^cache-([a-z]+)\d+/);
        if (m) {
          const code = m[1].toUpperCase();
          r.pop = { code, location: lookupPop(code) };
          r.serverId = lastNode;
        }
      }
      break;
    }

    case 'cloudfront': {
      r.cache = parseCloudFrontCache(h['x-cache']);
      r.cacheRaw = h['x-cache'];
      const popHdr = h['x-amz-cf-pop'];
      if (popHdr) {
        const code = popHdr.slice(0, 3).toUpperCase();
        r.pop = { code, location: lookupPop(code) };
        r.serverId = popHdr;
      }
      r.requestId = h['x-amz-cf-id'];
      break;
    }

    case 'vercel': {
      r.cache = parseCache(h['x-vercel-cache']);
      r.cacheRaw = h['x-vercel-cache'];
      // x-vercel-id format: "cdg1::iad1::abc-1234567890123-deadbeef"
      const id = h['x-vercel-id'];
      if (id) {
        r.requestId = id;
        const code = id.split('::')[0]?.slice(0, 3).toUpperCase();
        if (code) r.pop = { code, location: lookupPop(code) };
      }
      break;
    }

    case 'netlify': {
      // cache-status format: '"Netlify Edge"; hit' or '; miss'
      const cs = h['cache-status'];
      r.cacheRaw = cs;
      if (cs) {
        if (/;\s*hit/i.test(cs)) r.cache = 'HIT';
        else if (/;\s*miss/i.test(cs)) r.cache = 'MISS';
        else if (/;\s*bypass/i.test(cs)) r.cache = 'BYPASS';
      }
      r.requestId = h['x-nf-request-id'];
      // server-timing on Netlify often contains "dc;desc=\"aws-fra\"" etc.
      const dc = (h['server-timing'] ?? '').match(/dc;desc="([^"]+)"/);
      if (dc) r.serverId = dc[1];
      break;
    }

    case 'akamai':
    case 'unknown':
      // No vendor-specific cache normalization. We may still pick up Age.
      break;
  }

  if (h.age) {
    const age = parseInt(h.age, 10);
    if (Number.isFinite(age)) r.ageSeconds = age;
  }

  return r;
}

function parseCache(raw: string | undefined): CacheState {
  if (!raw) return 'UNKNOWN';
  const v = raw.toUpperCase().trim();
  if (v === 'HIT' || v.startsWith('HIT-') || v.startsWith('HIT,') || v === 'PRERENDER') return 'HIT';
  if (v === 'MISS' || v.startsWith('MISS,')) return 'MISS';
  if (v === 'EXPIRED') return 'EXPIRED';
  if (v === 'STALE') return 'STALE';
  if (v === 'BYPASS') return 'BYPASS';
  if (v === 'DYNAMIC') return 'DYNAMIC';
  if (v === 'PASS') return 'PASS';
  if (v === 'REVALIDATED' || v === 'UPDATING') return 'REVALIDATED';
  return 'UNKNOWN';
}

function parseCloudFrontCache(raw: string | undefined): CacheState {
  if (!raw) return 'UNKNOWN';
  const v = raw.toLowerCase();
  if (v.includes('hit from cloudfront')) return 'HIT';
  if (v.includes('miss from cloudfront')) return 'MISS';
  if (v.includes('refreshhit')) return 'REVALIDATED';
  if (v.includes('error')) return 'UNKNOWN';
  return 'UNKNOWN';
}

function parseBunnyServer(s: string | undefined): { popCode: string; serverId: string } | undefined {
  // Format: "BunnyCDN-HU1-1127"
  if (!s) return undefined;
  const m = s.match(/^BunnyCDN-([A-Z0-9]+)-(\d+)/i);
  if (!m) return undefined;
  return { popCode: m[1].toUpperCase(), serverId: m[2] };
}

function parseCfRay(s: string | undefined): { rayId: string; pop: string } | undefined {
  // Format: "9f774d382c2d6c45-VIE"
  if (!s) return undefined;
  const m = s.match(/^([a-f0-9]+)-([A-Z]+)$/i);
  if (!m) return undefined;
  return { rayId: m[1], pop: m[2].toUpperCase() };
}
