#!/usr/bin/env -S node --experimental-strip-types
// is-it-the-cdn — read the headers your CDN already publishes about itself,
// turn them into a plain-English diagnosis. Vendor-agnostic. No telemetry.

import { probe } from './probe.ts';
import { fingerprint } from './fingerprint.ts';
import { normalize } from './normalize.ts';
import { diagnose } from './diagnose.ts';
import { renderHuman } from './render.ts';
import type { ProbeResult } from './probe.ts';
import type { NormalizedReport } from './normalize.ts';

const HELP = `is-it-the-cdn — turn the headers your CDN publishes into a plain-English
                diagnosis of what just happened to your request.

Usage:
  is-it-the-cdn <url> [options]

Options:
  --once             One probe instead of two (skip the warm-comparison probe).
  --cold             Make the second probe a cache-buster (forces MISS).
                     Implies the default two-probe behavior.
  --json             Emit machine-readable JSON instead of the report.
  --raw              Include all raw response headers in the human report.
  --help             Show this help text.

Examples:
  is-it-the-cdn https://yoursite.com
  is-it-the-cdn https://yoursite.com --cold     # warm vs. cold comparison
  is-it-the-cdn https://yoursite.com --once     # single probe, fastest
  is-it-the-cdn https://yoursite.com --json | jq

Sources of the headers we know how to read:
  bunny.net   https://support.bunny.net/hc/en-us/articles/6683961155090
  Cloudflare  https://developers.cloudflare.com/fundamentals/reference/http-headers/
  Fastly      https://www.fastly.com/documentation/reference/http/http-headers/
`;

type Args = {
  url?: string;
  once: boolean;
  cold: boolean;
  json: boolean;
  raw: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { once: false, cold: false, json: false, raw: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--once') args.once = true;
    else if (a === '--cold') args.cold = true;
    else if (a === '--json') args.json = true;
    else if (a === '--raw') args.raw = true;
    else if (!a.startsWith('-') && !args.url) args.url = a;
    else if (a.startsWith('-')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function runProbe(url: string, cacheBuster: boolean) {
  const result = await probe(url, { cacheBuster });
  const fp = fingerprint(result);
  const report = normalize(result, fp.cdn);
  return { probe: result, fp, report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.url) {
    console.error(HELP);
    process.exit(2);
  }
  try {
    new URL(args.url);
  } catch {
    console.error(`Not a valid URL: ${args.url}`);
    process.exit(2);
  }

  // --once disables the second probe. --cold implies a second probe with
  // cache-buster. Default is two identical probes.
  const wantSecond = !args.once;
  const secondIsCold = args.cold;

  let primary;
  let second: { probe: ProbeResult; report: NormalizedReport; cold: boolean } | undefined;

  try {
    primary = await runProbe(args.url, false);
  } catch (err) {
    console.error(`is-it-the-cdn: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (wantSecond) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const sec = await runProbe(args.url, secondIsCold);
      second = { probe: sec.probe, report: sec.report, cold: secondIsCold };
    } catch (err) {
      // Second probe is best-effort. Note the failure but don't crash.
      console.error(`is-it-the-cdn: second probe failed (${err instanceof Error ? err.message : err}); continuing with one.`);
    }
  }

  const verdicts = diagnose({
    primary: { probe: primary.probe, report: primary.report },
    second,
  });

  if (args.json) {
    const payload = {
      url: args.url,
      probes: [
        toJsonProbe(primary.probe, primary.report, primary.fp.evidence, args.raw),
        ...(second ? [{ ...toJsonProbe(second.probe, second.report, [], args.raw), cold: second.cold }] : []),
      ],
      verdicts,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  process.stdout.write(renderHuman({
    primary: { probe: primary.probe, report: primary.report },
    second,
    verdicts,
    showRaw: args.raw,
  }));
}

function toJsonProbe(p: ProbeResult, r: NormalizedReport, evidence: string[], includeHeaders: boolean) {
  return {
    finalUrl: p.finalUrl,
    status: p.status,
    timings: p.timings,
    cdn: r.cdn,
    cdnEvidence: evidence,
    cache: r.cache,
    cacheRaw: r.cacheRaw,
    pop: r.pop,
    serverId: r.serverId,
    requestId: r.requestId,
    pullZone: r.pullZone,
    cachedAt: r.cachedAt,
    ageSeconds: r.ageSeconds,
    originStatus: r.originStatus,
    originFetchMs: r.originFetchMs,
    viewerCountry: r.viewerCountry,
    exposedDebugHeaders: r.exposedDebugHeaders,
    expectedDebugHeaders: r.expectedDebugHeaders,
    bodyBytesRead: p.bodyBytesRead,
    altSvc: p.altSvc,
    headers: includeHeaders ? p.headers : undefined,
  };
}

main().catch((err) => {
  console.error(`is-it-the-cdn: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
