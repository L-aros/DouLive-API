const { sm3 } = require('sm-crypto');

function hexToBytes(hex) {
  const output = [];
  for (let index = 0; index < hex.length; index += 2) {
    output.push(parseInt(hex.slice(index, index + 2), 16));
  }
  return output;
}

class StringProcessor {
  static toCharStr(bytes) {
    return Array.from(bytes)
      .map((value) => String.fromCharCode(value))
      .join('');
  }

  static toCharArray(value) {
    return Array.from(value).map((char) => char.charCodeAt(0));
  }

  static generateRandomBytes(length) {
    const values = [];

    for (let index = 0; index < length; index += 1) {
      const randomValue = Math.floor(Math.random() * 10000);
      values.push((randomValue & 255 & 170) | 1);
      values.push((randomValue & 255 & 85) | 2);
      values.push(((randomValue >> 8) & 170) | 5);
      values.push(((randomValue >> 8) & 85) | 40);
    }

    return this.toCharStr(Uint8Array.from(values));
  }
}

class CryptoUtility {
  constructor(salt, alphabets) {
    this.salt = salt;
    this.base64Alphabet = alphabets.map((value) => Array.from(value));
    this.bigArray = [
      121, 243, 55, 234, 103, 36, 47, 228, 30, 231, 106, 6, 115, 95, 78, 101, 250, 207, 198, 50,
      139, 227, 220, 105, 97, 143, 34, 28, 194, 215, 18, 100, 159, 160, 43, 8, 169, 217, 180, 120,
      247, 45, 90, 11, 27, 197, 46, 3, 84, 72, 5, 68, 62, 56, 221, 75, 144, 79, 73, 161, 178, 81,
      64, 187, 134, 117, 186, 118, 16, 241, 130, 71, 89, 147, 122, 129, 65, 40, 88, 150, 110, 219,
      199, 255, 181, 254, 48, 4, 195, 248, 208, 32, 116, 167, 69, 201, 17, 124, 125, 104, 96, 83,
      80, 127, 236, 108, 154, 126, 204, 15, 20, 135, 112, 158, 13, 1, 188, 164, 210, 237, 222, 98,
      212, 77, 253, 42, 170, 202, 26, 22, 29, 182, 251, 10, 173, 152, 58, 138, 54, 141, 185, 33,
      157, 31, 252, 132, 233, 235, 102, 196, 191, 223, 240, 148, 39, 123, 92, 82, 128, 109, 57, 24,
      38, 113, 209, 245, 2, 119, 153, 229, 189, 214, 230, 174, 232, 63, 52, 205, 86, 140, 66, 175,
      111, 171, 246, 133, 238, 193, 99, 60, 74, 91, 225, 51, 76, 37, 145, 211, 166, 151, 213, 206,
      0, 200, 244, 176, 218, 44, 184, 172, 49, 216, 93, 168, 53, 21, 183, 41, 67, 85, 224, 155, 226,
      242, 87, 177, 146, 70, 190, 12, 162, 19, 137, 114, 25, 165, 163, 192, 23, 59, 9, 94, 179, 107,
      35, 7, 142, 131, 239, 203, 149, 136, 61, 249, 14, 156
    ];
  }

  static sm3ToArray(input) {
    const normalized = typeof input === 'string' ? input : Array.from(input);
    return hexToBytes(sm3(normalized));
  }

  addSalt(value) {
    return value + this.salt;
  }

  paramsToArray(value, addSalt) {
    const processed = addSalt ? this.addSalt(value) : value;
    return CryptoUtility.sm3ToArray(processed);
  }

  transformBytes(values) {
    const result = [];
    const length = this.bigArray.length;
    let indexB = this.bigArray[1];
    let initialValue = 0;
    let valueE = 0;

    for (let index = 0; index < values.length; index += 1) {
      let sumInitial;

      if (index === 0) {
        initialValue = this.bigArray[indexB];
        sumInitial = indexB + initialValue;
        this.bigArray[1] = initialValue;
        this.bigArray[indexB] = indexB;
      } else {
        sumInitial = initialValue + valueE;
      }

      const sumIndex = sumInitial % length;
      const valueF = this.bigArray[sumIndex];
      result.push(values[index] ^ valueF);

      const nextIndex = (index + 2) % length;
      valueE = this.bigArray[nextIndex];
      const newSumIndex = (indexB + valueE) % length;
      initialValue = this.bigArray[newSumIndex];

      [this.bigArray[newSumIndex], this.bigArray[nextIndex]] = [
        this.bigArray[nextIndex],
        this.bigArray[newSumIndex]
      ];
      indexB = newSumIndex;
    }

    return result;
  }

  base64Encode(bytes, alphabetIndex) {
    const alphabet = this.base64Alphabet[alphabetIndex];
    let output = '';

    for (let index = 0; index < bytes.length; index += 3) {
      const b1 = bytes[index];
      const b2 = bytes[index + 1] || 0;
      const b3 = bytes[index + 2] || 0;
      const combined = (b1 << 16) | (b2 << 8) | b3;
      output += alphabet[(combined >> 18) & 63];
      output += alphabet[(combined >> 12) & 63];
      output += index + 1 < bytes.length ? alphabet[(combined >> 6) & 63] : '';
      output += index + 2 < bytes.length ? alphabet[combined & 63] : '';
    }

    while (output.length % 4 !== 0) {
      output += '=';
    }

    return output;
  }

  abogusEncode(values, alphabetIndex) {
    const alphabet = this.base64Alphabet[alphabetIndex];
    let output = '';

    for (let index = 0; index < values.length; index += 3) {
      const value1 = values[index];
      const value2 = values[index + 1] || 0;
      const value3 = values[index + 2] || 0;
      const combined = (value1 << 16) | (value2 << 8) | value3;
      output += alphabet[(combined & 0xfc0000) >> 18];
      output += alphabet[(combined & 0x03f000) >> 12];
      output += index + 1 < values.length ? alphabet[(combined & 0x0fc0) >> 6] : '';
      output += index + 2 < values.length ? alphabet[combined & 0x3f] : '';
    }

    while (output.length % 4 !== 0) {
      output += '=';
    }

    return output;
  }

  static rc4Encrypt(key, plainText) {
    const state = Array.from({ length: 256 }, (_, index) => index);
    let j = 0;

    for (let index = 0; index < 256; index += 1) {
      j = (j + state[index] + key[index % key.length]) & 0xff;
      [state[index], state[j]] = [state[j], state[index]];
    }

    let i = 0;
    j = 0;
    const plainBytes = StringProcessor.toCharArray(plainText);
    const output = [];

    for (const value of plainBytes) {
      i = (i + 1) & 0xff;
      j = (j + state[i]) & 0xff;
      [state[i], state[j]] = [state[j], state[i]];
      const keyStream = state[(state[i] + state[j]) & 0xff];
      output.push(value ^ keyStream);
    }

    return Uint8Array.from(output);
  }
}

class BrowserFingerprintGenerator {
  static generateFingerprint(browserType) {
    switch (browserType) {
      case 'Chrome':
      case 'Edge':
      case 'Firefox':
        return this.generatePlatformFingerprint('Win32');
      case 'Safari':
        return this.generatePlatformFingerprint('MacIntel');
      default:
        return this.generatePlatformFingerprint('Win32');
    }
  }

  static generatePlatformFingerprint(platform) {
    const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const innerWidth = randomBetween(1024, 1920);
    const innerHeight = randomBetween(768, 1080);
    const outerWidth = innerWidth + randomBetween(24, 32);
    const outerHeight = innerHeight + randomBetween(75, 90);
    const screenX = 0;
    const screenY = [0, 30][randomBetween(0, 1)];
    const sizeWidth = randomBetween(1024, 1920);
    const sizeHeight = randomBetween(768, 1080);
    const availWidth = randomBetween(1280, 1920);
    const availHeight = randomBetween(800, 1080);

    return `${innerWidth}|${innerHeight}|${outerWidth}|${outerHeight}|${screenX}|${screenY}|0|0|${sizeWidth}|${sizeHeight}|${availWidth}|${availHeight}|${innerWidth}|${innerHeight}|24|24|${platform}`;
  }
}

class ABogus {
  constructor(browserFingerprint, userAgent, options) {
    const alphabets = [
      'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe',
      'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe'
    ];

    this.cryptoUtility = new CryptoUtility('cus', alphabets);
    this.userAgent =
      userAgent && userAgent.length > 0
        ? userAgent
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
    this.browserFingerprint =
      browserFingerprint && browserFingerprint.length > 0
        ? browserFingerprint
        : BrowserFingerprintGenerator.generateFingerprint('Edge');
    this.options = options || [0, 1, 14];
    this.pageId = 0;
    this.aid = 6383;
    this.uaKey = [0x00, 0x01, 0x0e];
    this.sortIndex = [
      18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22, 28,
      32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71
    ];
    this.sortIndex2 = [
      18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33, 37,
      44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71
    ];
  }

  generateAbogus(params, body) {
    const abDir = {
      8: 3,
      18: 44,
      66: 0,
      69: 0,
      70: 0,
      71: 0
    };

    const startEncryption = Date.now();
    const paramsHash1 = this.cryptoUtility.paramsToArray(params, true);
    const array1 = CryptoUtility.sm3ToArray(paramsHash1);
    const bodyHash1 = this.cryptoUtility.paramsToArray(body, true);
    const array2 = CryptoUtility.sm3ToArray(bodyHash1);
    const rc4UserAgent = CryptoUtility.rc4Encrypt(this.uaKey, this.userAgent);
    const userAgentBase64 = this.cryptoUtility.base64Encode(rc4UserAgent, 1);
    const array3 = this.cryptoUtility.paramsToArray(userAgentBase64, false);
    const endEncryption = Date.now();

    abDir[20] = (startEncryption >> 24) & 255;
    abDir[21] = (startEncryption >> 16) & 255;
    abDir[22] = (startEncryption >> 8) & 255;
    abDir[23] = startEncryption & 255;
    abDir[24] = Math.floor(startEncryption / 0x100000000);
    abDir[25] = Math.floor(startEncryption / 0x10000000000);
    abDir[26] = (this.options[0] >> 24) & 255;
    abDir[27] = (this.options[0] >> 16) & 255;
    abDir[28] = (this.options[0] >> 8) & 255;
    abDir[29] = this.options[0] & 255;
    abDir[30] = Math.floor(this.options[1] / 256) & 255;
    abDir[31] = this.options[1] % 256;
    abDir[32] = (this.options[1] >> 24) & 255;
    abDir[33] = (this.options[1] >> 16) & 255;
    abDir[34] = (this.options[2] >> 24) & 255;
    abDir[35] = (this.options[2] >> 16) & 255;
    abDir[36] = (this.options[2] >> 8) & 255;
    abDir[37] = this.options[2] & 255;
    abDir[38] = array1[21];
    abDir[39] = array1[22];
    abDir[40] = array2[21];
    abDir[41] = array2[22];
    abDir[42] = array3[23];
    abDir[43] = array3[24];
    abDir[44] = (endEncryption >> 24) & 255;
    abDir[45] = (endEncryption >> 16) & 255;
    abDir[46] = (endEncryption >> 8) & 255;
    abDir[47] = endEncryption & 255;
    abDir[48] = abDir[8];
    abDir[49] = Math.floor(endEncryption / 0x100000000);
    abDir[50] = Math.floor(endEncryption / 0x10000000000);
    abDir[51] = (this.pageId >> 24) & 255;
    abDir[52] = (this.pageId >> 16) & 255;
    abDir[53] = (this.pageId >> 8) & 255;
    abDir[54] = this.pageId & 255;
    abDir[55] = this.pageId;
    abDir[56] = this.aid;
    abDir[57] = this.aid & 255;
    abDir[58] = (this.aid >> 8) & 255;
    abDir[59] = (this.aid >> 16) & 255;
    abDir[60] = (this.aid >> 24) & 255;
    abDir[64] = this.browserFingerprint.length;
    abDir[65] = this.browserFingerprint.length;

    const sortedValues = this.sortIndex.map((index) => abDir[index] || 0);
    const fingerprintArray = StringProcessor.toCharArray(this.browserFingerprint);

    let xorValue = 0;
    this.sortIndex2.forEach((key, index) => {
      const value = abDir[key] || 0;
      xorValue = index === 0 ? value : xorValue ^ value;
    });

    const allValues = [...sortedValues, ...fingerprintArray, xorValue];
    const transformedValues = this.cryptoUtility.transformBytes(allValues);
    const randomPrefix = StringProcessor.generateRandomBytes(3)
      .split('')
      .map((char) => char.charCodeAt(0));
    const finalValues = [...randomPrefix, ...transformedValues];
    const abogus = this.cryptoUtility.abogusEncode(finalValues, 0);

    return [`${params}&a_bogus=${abogus}`, abogus, this.userAgent, body];
  }
}

module.exports = {
  ABogus
};
