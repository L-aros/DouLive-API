function calculateHash(value, initial) {
  let result = initial;

  for (let index = 0; index < value.length; index += 1) {
    result = ((result ^ value.charCodeAt(index)) * 65599) >>> 0;
  }

  return result;
}

function calculateTailHash(value, initial) {
  let result = initial;

  for (let index = 0; index < value.length; index += 1) {
    result = (result * 65599 + value.charCodeAt(index)) >>> 0;
  }

  return result;
}

function encodeCharacter(code) {
  if (code < 26) {
    return String.fromCharCode(code + 65);
  }
  if (code < 52) {
    return String.fromCharCode(code + 71);
  }
  if (code < 62) {
    return String.fromCharCode(code - 4);
  }
  return String.fromCharCode(code - 17);
}

function encodeNumber(value) {
  let output = '';

  for (let shift = 24; shift >= 0; shift -= 6) {
    output += encodeCharacter((value >> shift) & 63);
  }

  return output;
}

function generateNonce() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let output = '';

  for (let index = 0; index < 21; index += 1) {
    output += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return output;
}

function extractCookieValue(setCookieHeaders, key) {
  const prefix = `${key}=`;

  for (const header of setCookieHeaders) {
    const firstPart = String(header).split(';')[0].trim();
    if (firstPart.startsWith(prefix)) {
      return firstPart.slice(prefix.length);
    }
  }

  return '';
}

function getAcSignature(timestamp, siteUrl, nonce, userAgent) {
  const signatureHead = '_02B4Z6wo00f01';
  const timestampText = String(timestamp);
  const a = calculateHash(siteUrl, calculateHash(timestampText, 0)) % 65521;
  const binary = `10000000110000${((timestamp ^ (a * 65521)) >>> 0).toString(2).padStart(32, '0')}`;
  const b = parseInt(binary, 2);
  const bText = String(b);
  const c = calculateHash(bText, 0);
  const d = encodeNumber(b >> 2);
  const e = (b / 4294967296) >>> 0;
  const f = encodeNumber((b << 28) | (e >>> 4));
  const g = 582085784 ^ b;
  const h = encodeNumber((e << 26) | (g >>> 6));
  const i = encodeCharacter(g & 63);
  const j = ((calculateHash(userAgent, c) % 65521) << 16) | (calculateHash(nonce, c) % 65521);
  const k = encodeNumber(j >> 2);
  const l = encodeNumber((j << 28) | ((524576 ^ b) >>> 4));
  const m = encodeNumber(a);
  const rawSignature = signatureHead + d + f + h + i + k + l + m;
  const suffix = String(parseInt(calculateTailHash(rawSignature, 0), 10).toString(16)).slice(-2);
  return rawSignature + suffix;
}

module.exports = {
  extractCookieValue,
  generateNonce,
  getAcSignature,
};
