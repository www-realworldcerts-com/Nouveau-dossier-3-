import { describe, expect, test } from 'bun:test';
import { createPrivacyMasker } from '../jarvis/src/lib/privacy';

describe('JARVIS privacy masking', () => {
  test('masks high-confidence secrets and personal identifiers', () => {
    const masker = createPrivacyMasker();
    const raw = [
      'key sk-abcdefghijklmnop1234',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456',
      'mail fatima@example.ma',
      'iban MA64011519000001205000534921',
      'card 4111 1111 1111 1111',
      'phone +212612345678',
    ].join('\n');
    const masked = masker.mask(raw);

    expect(masked).not.toContain('sk-abcdefghijklmnop1234');
    expect(masked).not.toContain('fatima@example.ma');
    expect(masked).not.toContain('MA64011519000001205000534921');
    expect(masked).not.toContain('4111 1111 1111 1111');
    expect(masked).not.toContain('+212612345678');
    expect(masked).toContain('{{API_KEY_');
    expect(masked).toContain('{{EMAIL_');
    expect(masked).toContain('{{IBAN_');
    expect(masked).toContain('{{CARD_');
    expect(masked).toContain('{{PHONE_');
    expect(masker.summary().masked_values).toBe(6);
  });

  test('uses stable placeholders and restores only on demand', () => {
    const masker = createPrivacyMasker();
    const first = masker.mask('mail sami@example.ma');
    const second = masker.mask('again sami@example.ma');
    const token = first.match(/\{\{EMAIL_[a-f0-9]+\}\}/)?.[0];
    expect(token).toBeTruthy();
    expect(second).toContain(token as string);
    expect(masker.unmask(`${first} / ${second}`)).toBe('mail sami@example.ma / again sami@example.ma');
    expect(masker.summary()).toEqual({ masked_values: 1, by_kind: { EMAIL: 1 } });
  });

  test('leaves ordinary business text alone', () => {
    const masker = createPrivacyMasker();
    const text = [
      'Order PO-2026-0042 for SKU ABC-123 at https://example.com/item?id=42',
      'Contact demo@example.com or test@service.invalid',
      'IBAN validation failed in the log',
    ].join('\n');
    expect(masker.mask(text)).toBe(text);
    expect(masker.summary().masked_values).toBe(0);
  });

  test('masks private key blocks', () => {
    const masker = createPrivacyMasker();
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(masker.mask(`before\n${key}\nafter`)).not.toContain('MIIEowIBAAKCAQEA');
    expect(masker.summary().by_kind.PRIVATE_KEY).toBe(1);
  });
});
