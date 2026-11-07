// Node-only browser launcher (local CLI, tests, self-hosted runner). The hosted runner uses Cloudflare Browser
// Rendering instead (runner/worker.ts); runner.ts itself never imports a browser runtime.

import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

export class BrowserSetupError extends Error {}

export async function launchBrowser(headless = true): Promise<Browser> {
  const explicit = process.env.MARKETCART_CHROMIUM_PATH || undefined;
  if (explicit && !existsSync(explicit)) throw new BrowserSetupError(`MARKETCART_CHROMIUM_PATH does not exist: ${explicit}`);
  try {
    return await chromium.launch({ headless, executablePath: explicit });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/Executable doesn't exist|executable.*not found|ENOENT/i.test(msg)) {
      throw new BrowserSetupError('Chromium is not installed for playwright-core. Run `npm run setup:browser` (installs chromium-headless-shell) or set MARKETCART_CHROMIUM_PATH.');
    }
    throw e;
  }
}
