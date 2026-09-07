'use strict';

const { packIp, countryFromIp } = require('../../utils/geo');

describe('packIp', () => {
  it('packs IPv4 into four bytes', () => {
    expect(packIp('192.168.1.1')).toEqual(Buffer.from([192, 168, 1, 1]));
  });

  it('unwraps the IPv4-mapped IPv6 form Express reports behind a proxy', () => {
    expect(packIp('::ffff:10.0.0.1')).toEqual(Buffer.from([10, 0, 0, 1]));
  });

  it('packs IPv6 into sixteen bytes', () => {
    const packed = packIp('2001:db8::1');
    expect(packed).toHaveLength(16);
    expect(packed.readUInt16BE(0)).toBe(0x2001);
    expect(packed.readUInt16BE(14)).toBe(1);
  });

  it('returns null for anything unparseable', () => {
    expect(packIp('not-an-ip')).toBeNull();
    expect(packIp('999.1.1.1')).toBeNull();
    expect(packIp('')).toBeNull();
    expect(packIp(null)).toBeNull();
  });
});

describe('countryFromIp', () => {
  it('returns null for loopback and empty input, never a guess', () => {
    expect(countryFromIp('127.0.0.1')).toBeNull();
    expect(countryFromIp('::1')).toBeNull();
    expect(countryFromIp(null)).toBeNull();
    expect(countryFromIp('')).toBeNull();
  });

  it('returns a two-letter code or null, never anything else', () => {
    const result = countryFromIp('8.8.8.8');
    expect(result === null || /^[A-Z]{2}$/.test(result)).toBe(true);
  });
});
