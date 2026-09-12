/* The arithmetic from the original AS2 __netHashText, on identical UTF-16 input. */
(() => {
  'use strict';
  function finishState(result) {
    if (!result || !Array.isArray(result.chunks)) throw new Error('netCheckState did not return its complete hash stream');
    let checksum = 1;
    for (const text of result.chunks) {
      if (typeof text !== 'string') throw new Error('Invalid full-state hash chunk');
      for (let i = 0; i < text.length; i++) checksum = (checksum * 131 + text.charCodeAt(i)) % 2147483647;
    }
    // Do not use Math.imul or a bitwise integer conversion here: the AS2 formula
    // uses exact double arithmetic for a product that can exceed uint32.
    result.checksum = checksum;
    delete result.chunks;
    return result;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { finishState };
  else globalThis.GunMayhemCheckState = Object.freeze({ finishState });
})();
