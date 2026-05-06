// POP / datacenter code lookup.
//
// IATA airport codes (3 letters) are used by Cloudflare (cf-ray suffix),
// Fastly (x-served-by suffix), and CloudFront (x-amz-cf-pop prefix).
//
// bunny.net uses 2-letter ISO country codes plus a digit (e.g. "HU1"). When a
// code doesn't match either table, we return the raw code so the user can
// look it up. We deliberately keep this list small and visible — it's a
// developer convenience, not a geographic authority.

const IATA: Record<string, string> = {
  AMS: 'Amsterdam, NL',
  ATL: 'Atlanta, US',
  ARN: 'Stockholm, SE',
  BOM: 'Mumbai, IN',
  BOS: 'Boston, US',
  BUD: 'Budapest, HU',
  CDG: 'Paris, FR',
  DEN: 'Denver, US',
  DEL: 'Delhi, IN',
  DFW: 'Dallas, US',
  DUB: 'Dublin, IE',
  EWR: 'Newark, US',
  FRA: 'Frankfurt, DE',
  GRU: 'São Paulo, BR',
  HEL: 'Helsinki, FI',
  HKG: 'Hong Kong',
  HND: 'Tokyo, JP',
  IAD: 'Ashburn, US',
  ICN: 'Seoul, KR',
  JFK: 'New York, US',
  KIX: 'Osaka, JP',
  LAX: 'Los Angeles, US',
  LHR: 'London, UK',
  MAD: 'Madrid, ES',
  MAN: 'Manchester, UK',
  MEL: 'Melbourne, AU',
  MIA: 'Miami, US',
  MRS: 'Marseille, FR',
  MUC: 'Munich, DE',
  NRT: 'Tokyo, JP',
  ORD: 'Chicago, US',
  OSL: 'Oslo, NO',
  PRG: 'Prague, CZ',
  SEA: 'Seattle, US',
  SFO: 'San Francisco, US',
  SIN: 'Singapore',
  SJC: 'San Jose, US',
  SOF: 'Sofia, BG',
  STO: 'Stockholm, SE',
  SYD: 'Sydney, AU',
  TPE: 'Taipei, TW',
  VIE: 'Vienna, AT',
  WAW: 'Warsaw, PL',
  YUL: 'Montréal, CA',
  YVR: 'Vancouver, CA',
  YYZ: 'Toronto, CA',
  ZRH: 'Zurich, CH',
};

const ISO_COUNTRY: Record<string, string> = {
  AT: 'Austria', AU: 'Australia', BE: 'Belgium', BG: 'Bulgaria',
  BR: 'Brazil', CA: 'Canada', CH: 'Switzerland', CL: 'Chile',
  CN: 'China', CZ: 'Czech Republic', DE: 'Germany', DK: 'Denmark',
  EE: 'Estonia', ES: 'Spain', FI: 'Finland', FR: 'France',
  GB: 'United Kingdom', UK: 'United Kingdom', GR: 'Greece', HK: 'Hong Kong',
  HR: 'Croatia', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland',
  IL: 'Israel', IN: 'India', IT: 'Italy', JP: 'Japan',
  KR: 'South Korea', LT: 'Lithuania', LV: 'Latvia', MX: 'Mexico',
  MY: 'Malaysia', NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand',
  PH: 'Philippines', PL: 'Poland', PT: 'Portugal', RO: 'Romania',
  RS: 'Serbia', SE: 'Sweden', SG: 'Singapore', SK: 'Slovakia',
  TH: 'Thailand', TR: 'Türkiye', TW: 'Taiwan', UA: 'Ukraine',
  US: 'United States', ZA: 'South Africa',
};

export function lookupPop(rawCode: string | undefined): string | undefined {
  if (!rawCode) return undefined;
  const code = rawCode.toUpperCase();

  // 3-letter IATA airport code (Cloudflare, Fastly, CloudFront).
  if (IATA[code]) return IATA[code];

  // CloudFront POPs are like "BUD50-P3" — first 3 chars are IATA.
  if (code.length > 3 && IATA[code.slice(0, 3)]) return IATA[code.slice(0, 3)];

  // bunny.net pattern: 2-letter ISO country + digit (e.g. "HU1", "DE2").
  const m = code.match(/^([A-Z]{2})(\d+)?$/);
  if (m && ISO_COUNTRY[m[1]]) {
    return m[2] ? `${ISO_COUNTRY[m[1]]} (POP ${m[2]})` : ISO_COUNTRY[m[1]];
  }

  return undefined;
}
