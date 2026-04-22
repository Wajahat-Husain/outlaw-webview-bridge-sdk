/**
 * Jest setup — polyfills for jsdom environment.
 * TextEncoder/TextDecoder and crypto are not available in older jsdom versions.
 */

import { TextEncoder, TextDecoder } from "util";
import { webcrypto } from "crypto";

// Polyfill TextEncoder / TextDecoder
Object.assign(global, { TextEncoder, TextDecoder });

// Polyfill WebCrypto (needed by HKDF key derivation in crypto.ts)
Object.defineProperty(global, "crypto", {
  value: webcrypto,
  writable: false,
});
