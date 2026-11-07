// Payhip integration, per the official docs read 2026-11-06:
//   License keys (new system): https://help.payhip.com/article/317-software-license-keys-new
//     GET https://payhip.com/api/v2/license/verify?license_key=KEY  header product-secret-key: SECRET
//     -> { data: { enabled, product_link, license_key, buyer_email, uses, date } }; failure -> empty response.
//   Webhooks: https://help.payhip.com/article/115-webhooks
//     events paid / refunded; amounts in cents; "signature" == sha256(API key); refunded items carry license_key;
//     non-200 responses are retried hourly for up to 3 hours.
// Payhip disables a license automatically when its transaction is refunded.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface LicenseInfo {
  enabled: boolean;
  product_link: string;
  uses: number;
  date: string;
}

export interface LicenseVerifier {
  readonly kind: 'payhip-live' | 'MOCK';
  verify(licenseKey: string): Promise<LicenseInfo | null>;
}

export function payhipVerifier(productSecretKey: string, fetchImpl: typeof fetch = fetch): LicenseVerifier {
  return {
    kind: 'payhip-live',
    async verify(licenseKey: string) {
      const url = `https://payhip.com/api/v2/license/verify?license_key=${encodeURIComponent(licenseKey)}`;
      const r = await fetchImpl(url, { method: 'GET', headers: { 'product-secret-key': productSecretKey, Accept: 'application/json' } });
      if (!r.ok) {
        if (r.status >= 500 || r.status === 429) throw new Error(`payhip verify unavailable (HTTP ${r.status})`);
        return null;
      }
      const text = await r.text();
      if (!text.trim()) return null; // documented failure shape: empty response
      const body = JSON.parse(text) as { data?: Partial<LicenseInfo> & { license_key?: string } };
      const d = body.data;
      if (!d || typeof d.enabled !== 'boolean' || typeof d.product_link !== 'string') return null;
      if (d.license_key && d.license_key !== licenseKey) return null;
      return { enabled: d.enabled, product_link: d.product_link, uses: Number(d.uses ?? 0), date: String(d.date ?? '') };
    },
  };
}

// MOCK provider for tests only. Every result it produces is labeled kind=MOCK.
export function mockVerifier(db: Map<string, LicenseInfo>): LicenseVerifier & { calls: number } {
  const v = {
    kind: 'MOCK' as const,
    calls: 0,
    async verify(licenseKey: string) {
      v.calls++;
      return db.get(licenseKey) ?? null;
    },
  };
  return v;
}

export function licenseHash(pepper: string, licenseKey: string): string {
  return createHmac('sha256', pepper).update(licenseKey.trim().toUpperCase()).digest('hex');
}

export function expectedSignature(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export function signatureValid(signature: unknown, apiKey: string): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const a = Buffer.from(signature.toLowerCase(), 'hex');
  const b = Buffer.from(expectedSignature(apiKey), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PayhipWebhook {
  id: string;
  type: 'paid' | 'refunded' | string;
  currency: string;
  price: number;
  stripe_fee?: number;
  payhip_fee?: number;
  amount_refunded?: number;
  date?: number;
  date_created?: number;
  date_refunded?: number;
  items: { product_key: string; license_key?: string }[];
  signature: string;
}
