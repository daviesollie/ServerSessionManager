'use strict';

// Windows DPAPI wrapper (CryptProtectData / CryptUnprotectData) via koffi.
// CurrentUser scope: the ciphertext can only be decrypted by the same Windows
// user account on the same machine. Used for the optional "remember master
// password on this device" feature.
const koffi = require('koffi');

const crypt32 = koffi.load('crypt32.dll');
const kernel32 = koffi.load('kernel32.dll');

const DATA_BLOB = koffi.struct('DATA_BLOB', {
  cbData: 'uint32',
  pbData: koffi.pointer('uint8'),
});

// BOOL CryptProtectData(DATA_BLOB*, LPCWSTR, DATA_BLOB*, PVOID, CRYPTPROTECT_PROMPTSTRUCT*, DWORD, DATA_BLOB*)
const CryptProtectData = crypt32.func('__stdcall', 'CryptProtectData', 'bool', [
  koffi.pointer(DATA_BLOB), 'void*', 'void*', 'void*', 'void*', 'uint32', koffi.out(koffi.pointer(DATA_BLOB)),
]);
const CryptUnprotectData = crypt32.func('__stdcall', 'CryptUnprotectData', 'bool', [
  koffi.pointer(DATA_BLOB), 'void*', 'void*', 'void*', 'void*', 'uint32', koffi.out(koffi.pointer(DATA_BLOB)),
]);
const LocalFree = kernel32.func('__stdcall', 'LocalFree', 'void*', ['void*']);

function call(fn, buf) {
  const input = { cbData: buf.length, pbData: buf };
  const output = {};
  const ok = fn(input, null, null, null, null, 0, output);
  if (!ok) throw new Error('DPAPI operation failed');
  const bytes = koffi.decode(output.pbData, 'uint8', output.cbData);
  const result = Buffer.from(bytes);
  LocalFree(output.pbData);
  return result;
}

function protect(buffer) {
  return call(CryptProtectData, buffer);
}

function unprotect(buffer) {
  return call(CryptUnprotectData, buffer);
}

module.exports = { protect, unprotect };
