#!/usr/bin/env -S node --experimental-strip-types
// Reproduces the header-count table in README.md.
//
// Probes each target twice with `accept-encoding: identity` and counts the
// debug headers each CDN exposes on a HIT response. Prints a markdown table
// to stdout.
//
// Run:   node --experimental-strip-types scripts/measure-headers.ts
// Or:    npm run measure
//
// The set of "debug headers" per CDN is the union of:
//   1. Headers documented by the CDN as identity / cache / debug signals.
//   2. Headers we observed live during build.
// We do NOT count generic web headers (date, content-type, vary, etc.) toward
// this number — only the CDN-specific ones a developer would consult to
// reason about what the edge just did.

import { request as httpsRequest } from 'node:https';

type Target = { cdn: string; url: string };

// Each target is the CDN's own canonical site (or a known-cached static asset
// served by that CDN). We measure DEFAULT exposure on what each vendor ships
// for itself — customer sites may be configured to strip these headers.
const TARGETS: Target[] = [
  { cdn: 'bunny.net',   url: 'https://bunny.net/' },
  { cdn: 'Fastly',      url: 'https://docs.fastly.com/' },
  { cdn: 'Cloudflare',  url: 'https://developers.cloudflare.com/' },
  { cdn: 'CloudFront',  url: 'https://d0.awsstatic.com/logos/powered-by-aws.png' },
  { cdn: 'Vercel',      url: 'https://vercel.com/' },
  { cdn: 'Netlify',     url: 'https://www.netlify.com/' },
  { cdn: 'Akamai',      url: 'https://www.akamai.com/' },
];

// Debug-header allowlist per CDN. Generic HTTP headers (date, content-type,
// vary, etag, content-length, set-cookie, security headers, etc.) are
// intentionally excluded so the count means "what the CDN tells you about
// itself, not what every web response carries."
const DEBUG_HEADERS: Record<string, string[]> = {
  'bunny.net': [
    'cdn-cache', 'cdn-pullzone', 'cdn-requestcountrycode', 'cdn-storageserver',
    'cdn-fileserver', 'cdn-proxyver', 'cdn-requestpullsuccess', 'cdn-requestpullcode',
    'cdn-cachedat', 'cdn-edgestorageid', 'cdn-requestid', 'cdn-status',
    'cdn-requesttime', 'server',
  ],
  'Cloudflare': ['cf-ray', 'cf-cache-status', 'cf-apo-via', 'speculation-rules', 'server'],
  'Fastly': ['x-served-by', 'x-cache', 'x-cache-hits', 'x-timer', 'server-timing', 'via', 'fastly-debug-path', 'server'],
  'CloudFront': ['via', 'x-amz-cf-pop', 'x-amz-cf-id', 'x-cache'],
  'Akamai': ['x-akam-sw-version', 'akamai-grn', 'server-timing', 'server', 'x-akamai-transformed', 'x-akamai-request-id'],
  'Vercel': ['x-vercel-cache', 'x-vercel-id', 'server', 'x-matched-path', 'age'],
  'Netlify': ['x-nf-request-id', 'server', 'cache-status', 'server-timing', 'age', 'x-nf-cache'],
};

type Probe = { status: number; headers: Record<string, string> };

function fetchHead(url: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        // Browser-like UA so vendor sites don't refuse the request outright
        // (akamai.com 403s on scripted UAs, for example). The point of this
        // measurement is to see what each CDN exposes on a normal page view.
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'accept-encoding': 'identity',
      },
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('response', (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      }
      // Drain body so the connection releases cleanly.
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function countDebugHeaders(cdn: string, headers: Record<string, string>): { count: number; matched: string[] } {
  const allowed = DEBUG_HEADERS[cdn] ?? [];
  const matched = allowed.filter((h) => h in headers);
  return { count: matched.length, matched };
}

async function probeTarget(t: Target): Promise<{ cdn: string; url: string; status: number; debugCount: number; matched: string[]; allHeaders: string[] }> {
  // First probe warms the cache; we read numbers from the second probe.
  await fetchHead(t.url).catch(() => null);
  await new Promise((r) => setTimeout(r, 250));
  const second = await fetchHead(t.url);
  const { count, matched } = countDebugHeaders(t.cdn, second.headers);
  return {
    cdn: t.cdn,
    url: t.url,
    status: second.status,
    debugCount: count,
    matched,
    allHeaders: Object.keys(second.headers).sort(),
  };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.error(`# is-it-the-cdn — header-count measurement (${today})\n`);

  const results = [];
  for (const t of TARGETS) {
    process.stderr.write(`probing ${t.cdn.padEnd(12)} ${t.url} … `);
    try {
      const r = await probeTarget(t);
      results.push(r);
      process.stderr.write(`status ${r.status}, ${r.debugCount} debug headers\n`);
    } catch (err) {
      process.stderr.write(`FAIL: ${err instanceof Error ? err.message : err}\n`);
      results.push({ cdn: t.cdn, url: t.url, status: 0, debugCount: 0, matched: [], allHeaders: [] });
    }
  }

  results.sort((a, b) => b.debugCount - a.debugCount);

  console.log('| CDN          | Debug headers exposed | Probe target |');
  console.log('|--------------|----------------------:|--------------|');
  for (const r of results) {
    const url = new URL(r.url);
    console.log(`| ${r.cdn.padEnd(12)} | ${String(r.debugCount).padStart(21)} | \`${url.hostname}${url.pathname}\` |`);
  }
  console.log(`\n_Measured on ${today}. Reproduce with \`npm run measure\`._`);

  console.error('\n--- Detail (matched debug headers per CDN) ---');
  for (const r of results) {
    console.error(`\n## ${r.cdn} (status ${r.status})`);
    console.error(`url:      ${r.url}`);
    console.error(`matched:  ${r.matched.join(', ') || '(none)'}`);
    console.error(`all keys: ${r.allHeaders.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
