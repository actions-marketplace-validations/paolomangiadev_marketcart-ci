// Node adapter for the fetch-style fixture. Binds to 127.0.0.1 only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handle } from './app.ts';

async function toRequest(req: IncomingMessage, base: string, signal: AbortSignal): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
  return new Request(new URL(req.url ?? '/', base), { method: req.method, headers, body, signal });
}

export async function startFixture(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
      const request = await toRequest(req, `http://127.0.0.1`, ac.signal);
      const response = await handle(request, { hangSignal: ac.signal });
      if (res.destroyed) return;
      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((v, k) => {
        if (k === 'set-cookie') return;
        headers[k] = v;
      });
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length) headers['set-cookie'] = setCookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`fixture error: ${(e as Error).message}`);
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if ((process.argv[1] ?? '').replace(/\\/g, '/').endsWith('storefront/server.ts')) {
  const port = Number(process.env.PORT ?? 8787);
  startFixture(port).then((f) => console.log(`fixture listening on ${f.url}`));
}
