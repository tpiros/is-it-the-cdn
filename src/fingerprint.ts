// CDN identification by response-header fingerprinting.
//
// The fingerprint is heuristic — customers can white-label, chain CDNs, or
// strip headers — so we always return the evidence that drove the decision
// and let the caller surface it. An "unknown" result is a valid outcome,
// not an error.

import type { ProbeResult } from './probe.ts';

export type CdnId =
  | 'bunny'
  | 'cloudflare'
  | 'fastly'
  | 'cloudfront'
  | 'akamai'
  | 'vercel'
  | 'netlify'
  | 'unknown';

export type Fingerprint = {
  cdn: CdnId;
  evidence: string[];
};

export function fingerprint(result: ProbeResult): Fingerprint {
  const h = result.headers;
  const server = (h.server ?? '').toLowerCase();
  const evidence: string[] = [];

  // Order matters when multiple CDNs could plausibly match. Most-specific
  // signature first.

  if (server.startsWith('bunnycdn-') || h['cdn-pullzone'] || h['cdn-cache']) {
    if (h.server) evidence.push(`server: ${h.server}`);
    if (h['cdn-pullzone']) evidence.push(`cdn-pullzone: ${h['cdn-pullzone']}`);
    if (h['cdn-cache']) evidence.push(`cdn-cache: ${h['cdn-cache']}`);
    return { cdn: 'bunny', evidence };
  }

  if (h['cf-ray'] || (server === 'cloudflare')) {
    if (h.server) evidence.push(`server: ${h.server}`);
    if (h['cf-ray']) evidence.push(`cf-ray: ${h['cf-ray']}`);
    if (h['cf-cache-status']) evidence.push(`cf-cache-status: ${h['cf-cache-status']}`);
    return { cdn: 'cloudflare', evidence };
  }

  if (h['x-vercel-id'] || h['x-vercel-cache']) {
    if (h['x-vercel-id']) evidence.push(`x-vercel-id: ${h['x-vercel-id']}`);
    if (h['x-vercel-cache']) evidence.push(`x-vercel-cache: ${h['x-vercel-cache']}`);
    return { cdn: 'vercel', evidence };
  }

  if (h['x-nf-request-id'] || server === 'netlify') {
    if (h.server) evidence.push(`server: ${h.server}`);
    if (h['x-nf-request-id']) evidence.push(`x-nf-request-id: ${h['x-nf-request-id']}`);
    if (h['cache-status']) evidence.push(`cache-status: ${h['cache-status']}`);
    return { cdn: 'netlify', evidence };
  }

  // Fastly: x-served-by has a specific cache-NAME-POP pattern.
  if (/cache-[a-z]+\d+-[A-Z]+/.test(h['x-served-by'] ?? '')) {
    evidence.push(`x-served-by: ${h['x-served-by']}`);
    if (h['x-cache']) evidence.push(`x-cache: ${h['x-cache']}`);
    return { cdn: 'fastly', evidence };
  }

  // CloudFront: via header always contains "(CloudFront)".
  if ((h.via ?? '').toLowerCase().includes('cloudfront') || h['x-amz-cf-id']) {
    if (h.via) evidence.push(`via: ${h.via}`);
    if (h['x-amz-cf-pop']) evidence.push(`x-amz-cf-pop: ${h['x-amz-cf-pop']}`);
    if (h['x-amz-cf-id']) evidence.push(`x-amz-cf-id: ${h['x-amz-cf-id']}`);
    return { cdn: 'cloudfront', evidence };
  }

  // Akamai: dedicated headers, plus Akamai-style server-timing.
  if (h['x-akam-sw-version'] || h['akamai-grn'] || h['x-akamai-transformed']
      || (h['server-timing'] ?? '').includes('ak_p')) {
    if (h['x-akam-sw-version']) evidence.push(`x-akam-sw-version: ${h['x-akam-sw-version']}`);
    if (h['akamai-grn']) evidence.push(`akamai-grn: ${h['akamai-grn']}`);
    if (h['x-akamai-transformed']) evidence.push(`x-akamai-transformed: ${h['x-akamai-transformed']}`);
    return { cdn: 'akamai', evidence };
  }

  return { cdn: 'unknown', evidence };
}

export function labelCdn(cdn: CdnId): string {
  const labels: Record<CdnId, string> = {
    bunny: 'bunny.net',
    cloudflare: 'Cloudflare',
    fastly: 'Fastly',
    cloudfront: 'AWS CloudFront',
    akamai: 'Akamai',
    vercel: 'Vercel',
    netlify: 'Netlify',
    unknown: 'Unknown / no CDN signature found',
  };
  return labels[cdn];
}
