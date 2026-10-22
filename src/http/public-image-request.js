import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPublicImageAddress(value) {
  const address = String(value || '').toLowerCase();
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
      || (a === 198 && [18, 19].includes(b)));
  }
  // Only global unicast IPv6. IPv4-mapped, local, multicast and transition
  // addresses are rejected rather than interpreted through a second IP family.
  const second = Number.parseInt(address.split(':')[1], 16);
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/.test(address)
    && !(address.startsWith('2001:') && (second <= 0x1ff || second === 0xdb8)) && !address.startsWith('2002:');
}

export async function resolvePublicImageTarget(value, resolve = lookup) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port))) throw new Error('Image URL must use a public HTTP service');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
    : await resolve(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(row => !isPublicImageAddress(row.address))) throw new Error('Image URL resolves to a private network');
  return { url, address: addresses[0] };
}

// Pin the validated DNS result to the actual connection, including redirects.
// A second DNS lookup by fetch must not turn a public name into an internal host.
export async function requestPublicImage(value, { signal, headers, maxBytes, resolve = lookup, redirects = 4 } = {}) {
  const { url, address } = await resolvePublicImageTarget(value, resolve);
  return new Promise((resolveResult, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      signal, headers, agent: false,
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [address]) : callback(null, address.address, address.family)
    }, async response => {
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (redirects <= 0 || !response.headers.location) throw new Error('Image redirect limit exceeded');
          resolveResult(await requestPublicImage(new URL(response.headers.location, url).href, { signal, headers, maxBytes, resolve, redirects: redirects - 1 }));
          return;
        }
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (response.statusCode < 200 || response.statusCode >= 300 || !contentType.startsWith('image/')
          || Number(response.headers['content-length'] || 0) > maxBytes) {
          response.destroy(); resolveResult(null); return;
        }
        let received = 0;
        const chunks = [];
        for await (const chunk of response) {
          received += chunk.length;
          if (received > maxBytes) { response.destroy(); resolveResult(null); return; }
          chunks.push(chunk);
        }
        resolveResult({ buffer: Buffer.concat(chunks, received), contentType });
      } catch (error) { response.destroy(); reject(error); }
    });
    req.on('error', reject);
  });
}
