// Cloudflare Workers entry for the public synthetic fixture (same handler as the local Node server).
import { handle } from './app.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const res = await handle(request, { hangSignal: request.signal });
    const headers = new Headers(res.headers);
    headers.set('x-robots-tag', 'noindex, nofollow');
    headers.set('x-marketcart-fixture', 'synthetic');
    return new Response(res.body, { status: res.status, headers });
  },
};
