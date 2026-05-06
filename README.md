# is-it-the-cdn

Read the headers your CDN already publishes about itself. Get a plain-English diagnosis of what just happened to your request.

```bash
node --experimental-strip-types src/cli.ts https://yoursite.com
```

Zero runtime dependencies. Vendor-agnostic. Two HTTP requests per run. No sign-up, no telemetry, no daemon.

---

## Example output

```
is-it-the-cdn  →  https://bunny.net/
────────────────────────────────────────────────────────────────────────
CDN             bunny.net
POP             HU1  (Hungary (POP 1))
Server          1127
Request ID      08c09e1aef1eecc851e37a922cfbfa4a
Pull zone       876725
Viewer GeoIP    HU

Status          200
HTTP            HTTP/1.1
Remote IP       2a01:6ee0:30:c::1127:1 (IPv6)

Cache           HIT
Cached at       05/05/2026 14:42:56
Origin status   200
Origin fetch    0ms (reported by edge)

Timings
  DNS           36ms
  TCP           14ms
  TLS           20ms
  TTFB          93ms
  Total        164ms

Probes
  1: cache HIT     ttfb   93ms
  2: cache HIT     ttfb   59ms

Diagnosis
  i CDN identified
    14 of 14 expected debug headers exposed.
  ✓ Cache HIT
    Edge served from cache. Origin not contacted.
  ✓ TTFB 93ms
    Excellent first-byte latency. Edge is doing its job.
  i Cache stayed warm
    Both probes HIT. Second TTFB: 59ms.

Debug headers exposed
  14 of 14 expected for bunny.net
  cdn-cache, cdn-pullzone, cdn-requestcountrycode, cdn-storageserver,
  cdn-fileserver, cdn-proxyver, cdn-requestpullsuccess, cdn-requestpullcode,
  cdn-cachedat, cdn-edgestorageid, cdn-requestid, cdn-status, cdn-requesttime,
  server
```

Pre-recorded outputs for all 7 supported CDNs are in [`samples/`](./samples).

---

## Why we measured this

CDN slowness is hard to debug. The signals you need are in response headers, named differently by every vendor. The tool reads them so you don't have to.

While building it, the gap fell out by accident. The 7 CDNs publish wildly different amounts of debug detail, ranging from 4 to 14. Here's what each one exposes on its own canonical site, measured the same way (`GET` with a browser User-Agent, `Accept-Encoding: identity`, second of two probes counted):

| CDN          | Debug headers exposed | Probe target |
|--------------|----------------------:|--------------|
| bunny.net    |                    14 | `bunny.net/` |
| Fastly       |                     6 | `docs.fastly.com/` |
| Vercel       |                     5 | `vercel.com/` |
| Netlify      |                     5 | `www.netlify.com/` |
| Cloudflare   |                     4 | `developers.cloudflare.com/` |
| CloudFront   |                     4 | `d0.awsstatic.com/logos/powered-by-aws.png` |
| Akamai       |                     4 | `www.akamai.com/` |

_Measured 2026-05-06. Reproduce with `npm run measure`._

The raw count matters less than the gap. The CDN at the top of the table tells you the origin response code (`cdn-requestpullcode`), milliseconds spent fetching from origin (`cdn-requesttime`), the exact server that handled you (`server: BunnyCDN-HU1-1127`), the GeoIP it resolved you to (`cdn-requestcountrycode`), and the timestamp the resource was cached (`cdn-cachedat`). The CDN at the bottom of the table tells you a request ID and a server name.

If you've ever spent an afternoon arguing with a vendor about whether a slow page was their edge or your origin, you know which of those is more useful.

The header allowlist used to compute the table is in [`scripts/measure-headers.ts`](./scripts/measure-headers.ts). Generic headers (`date`, `content-type`, `vary`, security headers) are excluded. The count is only "what the CDN tells you about itself."

---

## Install

Requires Node 22.6+ (for `--experimental-strip-types`; type-stripping is on by default in Node 23.6+, but the flag is harmless either way).

```bash
git clone https://github.com/tpiros/is-it-the-cdn
cd is-it-the-cdn
node --experimental-strip-types src/cli.ts https://example.com
```

Or via the npm script:

```bash
npm run probe -- https://example.com
```

No runtime dependencies. To get type-checking in your editor, run `npm install` to fetch `@types/node`.

---

## Flags

```
--once             One probe instead of two (skip the warm-comparison probe).
--cold             Make the second probe a cache-buster (forces MISS) so
                   you can see the warm-vs-cold delta. Implies two probes.
--json             Emit machine-readable JSON instead of the report.
--raw              Include all raw response headers in the human report.
--help             Show help.
```

Useful combinations:

```bash
# Default. Two identical probes, see if the cache warms.
node --experimental-strip-types src/cli.ts https://yoursite.com

# Warm vs. cold. Shows how many ms your cache saves on this URL.
node --experimental-strip-types src/cli.ts https://yoursite.com --cold

# Pipe to jq for a script-friendly report.
node --experimental-strip-types src/cli.ts https://yoursite.com --json --once | jq .
```

Sample `--cold` output:
```
Probes
  1: cache HIT     ttfb  186ms
  2: cache MISS    ttfb  444ms  (cold / cache-busted)

Diagnosis
  i Cache effect: 257ms saved
    Warm probe: 186ms. Cold probe: 444ms.
```

---

## What it can tell you

For all 7 supported CDNs:
- **Which CDN is in front**, with the evidence the call was based on.
- **Cache state** (HIT / MISS / EXPIRED / BYPASS / DYNAMIC / etc.), normalized across vendors. The raw vendor value is shown alongside.
- **Edge POP** that served you, with a city/country lookup for IATA-coded POPs.
- **DNS, TCP, TLS, TTFB, total** timings from socket-level events.

For bunny.net specifically (the only CDN that exposes them):
- **Origin response code** (`cdn-requestpullcode`). Was the slow your origin or the edge?
- **Origin fetch time** (`cdn-requesttime`). How long the edge spent waiting on origin.
- **Viewer GeoIP** (`cdn-requestcountrycode`). What country the edge thinks you're in.
- **Cache timestamp** (`cdn-cachedat`). When the cached copy was stored.

---

## Known limits

- **Single vantage point.** TTFB and latency numbers are local to wherever you run the tool. A 60ms cache hit from your laptop in Berlin doesn't equal a 60ms cache hit globally. Header counts and cache state are invariant across vantages; latency is not. To see globally, you'd need to run this from multiple locations.

- **CDN detection is heuristic.** People white-label, chain CDNs, or strip headers. The tool prints the evidence behind the call (`cdnEvidence` in `--json`); trust but verify.

- **Cache semantics differ by vendor.** Cloudflare's `BYPASS`/`DYNAMIC`/`EXPIRED`, Fastly's per-tier `MISS, HIT, HIT` chain, CloudFront's `Hit from cloudfront` string. These don't map 1:1. The tool normalizes to a common set, and the raw vendor value is always shown so you can audit the call.

- **Origin attribution is bunny-only.** No other CDN exposes origin response code or origin fetch time as headers. For non-bunny CDNs, use `--cold` to compare warm vs. cold and infer the rest.

- **Header counts depend on configuration.** Customers can strip CDN debug headers (apple.com strips Akamai's, for example). The methodology table measures defaults on each vendor's own canonical site, which is what each CDN ships out of the box.

- **HTTP/3 is not used.** Node's `https` module only speaks HTTP/1.1 and HTTP/2. When `alt-svc` advertises h3, the diagnosis says so.

- **The tool will tell you bunny.net is slow if it's slow.** It has no vendor preference. Every measurement is local and mechanical. That's the whole point.

---

## Sources of the headers we know how to read

- bunny.net: [CDN-Cache and Perma-Cache headers](https://support.bunny.net/hc/en-us/articles/6683961155090-CDN-Cache-and-Perma-Cache-Headers-Explained), [How to find which PoP](https://support.bunny.net/hc/en-us/articles/360000238192-How-to-find-out-which-PoP-I-am-being-routed-to), [`CDN-RequestCountryCode`](https://bunny.net/blog/introducing-the-requestcountrycode-geoip-header/)
- Cloudflare: [HTTP headers reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/), [Cache responses](https://developers.cloudflare.com/cache/concepts/cache-responses/)
- Fastly: [`X-Served-By`](https://www.fastly.com/documentation/reference/http/http-headers/X-Served-By/), [`X-Cache`](https://www.fastly.com/documentation/reference/http/http-headers/X-Cache/), [Header reference](https://www.fastly.com/documentation/reference/http/http-headers/)
- AWS CloudFront: [Response headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/response-and-error-headers.html)
- Vercel: [`x-vercel-id`, `x-vercel-cache`](https://vercel.com/docs/edge-network/headers)
- Netlify: [`Cache-Status`](https://docs.netlify.com/platform/caching/), [Server-Timing](https://docs.netlify.com/build/edge-functions/api/#server-timing)

---

## File layout

```
src/
  cli.ts          argument parsing, glue
  probe.ts        HTTP request with socket-event timing
  fingerprint.ts  CDN identification by header pattern
  normalize.ts    cache + POP normalization across vendors
  pops.ts         IATA airport + ISO country lookup
  diagnose.ts     verdict catalog (plain English, vendor-neutral)
  render.ts       terminal output (ANSI, no deps)
scripts/
  measure-headers.ts   reproduces the header-count table above
samples/          captured outputs for all 7 CDNs (regenerate any time)
```

---

## License

MIT. See [LICENSE](./LICENSE).

Built by Tamas Piros.
