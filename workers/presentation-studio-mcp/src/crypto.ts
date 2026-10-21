const encoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Bytes(value: string | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const input =
    typeof value === "string"
      ? encoder.encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  const owned = new Uint8Array(input.byteLength);
  owned.set(input);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = await sha256Bytes(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(await sha256Bytes(value));
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error("invalid_hex");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const actual = await sha256Bytes(codeVerifier);
  const expected = base64UrlToBytes(codeChallenge);
  return constantTimeEqual(actual, expected);
}

export function decodeBase64(value: string): Uint8Array {
  return base64UrlToBytes(value);
}

export function safePathSegment(value: string, fallback = "source"): string {
  const cleaned = value
    .normalize("NFKC")
    .replaceAll(/[^A-Za-z0-9._-]/g, "_")
    .replaceAll(/\.{2,}/g, "_")
    .replace(/^[-.]+/, "")
    .slice(0, 160);
  return cleaned || fallback;
}

export function randomHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
