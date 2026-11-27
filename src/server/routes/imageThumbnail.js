import { getPublicImageThumbnail } from '../../services/public-image-thumbnail.js';
import { writeHead } from '../../http/response.js';

// Invoked only after the regular session, enterprise and subscription gates.
export async function sendPublicImageThumbnail(req, res, url, { read = getPublicImageThumbnail } = {}) {
  req._sensitiveResponse = true;
  const payload = await read(String(url.searchParams.get('url') || ''), {
    width: Number(url.searchParams.get('w') || 180),
    force: /(?:no-cache|max-age\s*=\s*0)/i.test(String(req.headers?.['cache-control'] || ''))
  });
  writeHead(res, 200, {
    'Content-Type': payload.contentType,
    'Content-Length': payload.buffer.length,
    'Cache-Control': payload.cacheControl,
    'X-Image-Thumbnail-Cache': payload.cacheState,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  });
  res.end(payload.buffer);
}
