// HTTP probe with socket-event timing. Stdlib-only.
//
// Returns DNS, TCP, TLS, TTFB, and total in milliseconds, plus the response
// status, headers, and the remote address we reached. No streaming abstraction
// — we read the body to /dev/null only to release the connection.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage } from 'node:http';

export type ProbeTimings = {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  ttfbMs: number;
  totalMs: number;
  remoteAddress: string | null;
  remoteFamily: 'IPv4' | 'IPv6' | null;
  httpVersion: string;
};

export type ProbeResult = {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  timings: ProbeTimings;
  bodyBytesRead: number;
  altSvc?: string;
};

export type ProbeOptions = {
  cacheBuster?: boolean;
  followRedirects?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

export async function probe(targetUrl: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const followRedirects = opts.followRedirects ?? true;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  let currentUrl = opts.cacheBuster ? appendCacheBuster(targetUrl) : targetUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const u = new URL(currentUrl);
    const result = await probeOnce(u, timeoutMs);
    const isRedirect = [301, 302, 303, 307, 308].includes(result.status);
    if (followRedirects && isRedirect && result.headers.location) {
      currentUrl = new URL(result.headers.location, currentUrl).toString();
      continue;
    }
    return { ...result, url: targetUrl, finalUrl: u.toString() };
  }
  throw new Error(`Too many redirects (>${maxRedirects})`);
}

function appendCacheBuster(url: string): string {
  const u = new URL(url);
  const token = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  u.searchParams.set('_iitc', token);
  return u.toString();
}

function probeOnce(u: URL, timeoutMs: number): Promise<Omit<ProbeResult, 'url' | 'finalUrl'>> {
  const isHttps = u.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const t = {
      start: performance.now(),
      dnsStart: 0,
      dnsEnd: 0,
      connectEnd: 0,
      tlsEnd: 0,
      firstByte: 0,
      end: 0,
    };
    let bodyBytesRead = 0;

    const req = requestFn({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        // Browser-like UA so vendor sites don't refuse the request and we get
        // the same headers a real visitor would see.
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'accept-encoding': 'identity',
        'host': u.host,
      },
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    req.on('socket', (socket) => {
      t.dnsStart = performance.now();
      socket.on('lookup', () => {
        t.dnsEnd = performance.now();
      });
      socket.on('connect', () => {
        t.connectEnd = performance.now();
      });
      socket.on('secureConnect', () => {
        t.tlsEnd = performance.now();
      });
    });

    req.on('response', (res: IncomingMessage) => {
      t.firstByte = performance.now();

      res.on('data', (chunk: Buffer) => {
        bodyBytesRead += chunk.length;
      });

      res.on('end', () => {
        t.end = performance.now();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
        }
        const sock = req.socket;
        const remoteAddress = sock?.remoteAddress ?? null;
        const remoteFamily = sock?.remoteFamily === 'IPv6' ? 'IPv6'
          : sock?.remoteFamily === 'IPv4' ? 'IPv4' : null;

        const dnsMs = t.dnsEnd > 0 ? round(t.dnsEnd - t.dnsStart) : null;
        const tcpStart = t.dnsEnd > 0 ? t.dnsEnd : t.dnsStart;
        const tcpMs = t.connectEnd > 0 ? round(t.connectEnd - tcpStart) : null;
        const tlsMs = isHttps && t.tlsEnd > 0 && t.connectEnd > 0
          ? round(t.tlsEnd - t.connectEnd)
          : null;

        resolve({
          status: res.statusCode ?? 0,
          headers,
          timings: {
            dnsMs,
            tcpMs,
            tlsMs,
            ttfbMs: round(t.firstByte - t.start),
            totalMs: round(t.end - t.start),
            remoteAddress,
            remoteFamily,
            httpVersion: res.httpVersion,
          },
          bodyBytesRead,
          altSvc: headers['alt-svc'],
        });
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
