/**
 * Address classification for outbound requests the server makes on a customer's
 * behalf (webhook deliveries, inbound attachment downloads). Pure string logic with no
 * Node imports, so the same rules back both the form schema and the server-side fetch
 * guard — the guard is the authoritative check, since only it sees resolved addresses.
 */

function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return octets;
}

/** Eight 16-bit groups, or null when the value is not an IPv6 literal. */
function parseIPv6(value: string): number[] | null {
  let text = value.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) {
    text = text.slice(0, zone);
  }
  if (!text.includes(':')) {
    return null;
  }

  // A trailing dotted quad (`::ffff:10.0.0.1`) stands for the last two groups.
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIPv4(last);
    if (!v4) {
      return null;
    }
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const toGroups = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null;
      }
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !rest) {
    return null;
  }
  const explicit = head.length + rest.length;
  if (halves.length === 1) {
    return explicit === 8 ? head : null;
  }
  if (explicit > 7) {
    return null;
  }
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest];
}

function inV4(octets: number[], base: [number, number, number, number], bits: number): boolean {
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const net = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (net & mask);
}

const BLOCKED_V4: [[number, number, number, number], number][] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], // link-local, including cloud metadata endpoints
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved and broadcast
];

function isBlockedV4(octets: number[]): boolean {
  return BLOCKED_V4.some(([base, bits]) => inV4(octets, base, bits));
}

function isBlockedV6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];

  // ::, ::1 and the deprecated IPv4-compatible block (::a.b.c.d).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return true;
  }
  // IPv4-mapped (::ffff:a.b.c.d): judged by the IPv4 address it carries.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedV4(embedded);
  }
  // NAT64 (64:ff9b::/96) likewise; its local-use sibling 64:ff9b:1::/48 is private.
  if (g0 === 0x64 && g1 === 0xff9b) {
    return g2 === 1 || isBlockedV4(embedded);
  }
  // 6to4 (2002::/16) embeds the IPv4 address in the second and third groups.
  if (g0 === 0x2002) {
    return isBlockedV4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  }
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True for an IP literal (v4 or v6, brackets allowed). */
export function isIpLiteral(value: string): boolean {
  const bare = value.replace(/^\[|\]$/g, '');
  return parseIPv4(bare) !== null || parseIPv6(bare) !== null;
}

/**
 * True when an IP address is not a public unicast address: loopback, private,
 * link-local (cloud metadata), CGNAT, multicast, documentation and reserved ranges.
 * Anything that is not an IP literal at all is reported as blocked, so a caller can
 * never mistake an unparsed value for a safe one.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(bare);
  if (v4) {
    return isBlockedV4(v4);
  }
  const v6 = parseIPv6(bare);
  if (v6) {
    return isBlockedV6(v6);
  }
  return true;
}

// A runtime global wherever this package runs (Node and browsers); declared here because
// the package compiles without DOM or Node typings.
declare const URL: new (input: string) => { protocol: string; hostname: string };

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

/**
 * Cheap, resolution-free check for a URL hostname that obviously points inside the
 * network: `localhost`, internal suffixes, or a private IP literal. A public-looking
 * name can still resolve to a private address, which only the server-side guard sees.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost') {
    return true;
  }
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  return isIpLiteral(host) ? isPrivateAddress(host) : false;
}

/** Only http(s) URLs whose host is not an obvious internal target. */
export function isPublicHttpUrl(value: string): boolean {
  let url: { protocol: string; hostname: string };
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  return !isBlockedHostname(url.hostname);
}
