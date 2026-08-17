/**
 * Just enough DER to read an X.509 certificate.
 *
 * Web Crypto can import a public key and check a signature, and cannot parse a
 * certificate at all. Verifying Apple's signed payloads means walking the
 * certificate chain in the JWS header, and that means reading DER.
 *
 * This is a reader, not a parser: it walks the structure and hands back byte
 * ranges. Nothing here decodes a value it does not need, and nothing here is
 * general-purpose. The alternative was a dependency, and the obvious candidates
 * are Node-only or have documented failures under Deno, which is the whole
 * reason this file exists.
 */

/** One DER element: its tag, its contents, and where the next one starts. */
export interface DerElement {
  tag: number;
  /** The contents, without the tag and length. */
  content: Uint8Array;
  /** The element including its tag and length, which is what gets signed. */
  raw: Uint8Array;
  /** Offset just past this element, for reading a sibling. */
  end: number;
}

export const DER = {
  SEQUENCE: 0x30,
  SET: 0x31,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OID: 0x06,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
} as const;

/**
 * Read the element starting at [offset].
 *
 * Rejects the indefinite-length form outright. DER forbids it, only BER allows
 * it, and accepting it would mean guessing where an element ends inside data
 * whose whole purpose is to be signed.
 */
export function readElement(bytes: Uint8Array, offset = 0): DerElement {
  if (offset + 2 > bytes.length) {
    throw new Error('DER: truncated element.');
  }
  const tag = bytes[offset];
  const first = bytes[offset + 1];
  let length: number;
  let headerLength: number;

  if (first < 0x80) {
    length = first;
    headerLength = 2;
  } else if (first === 0x80) {
    throw new Error('DER: indefinite length is not valid DER.');
  } else {
    const count = first & 0x7f;
    if (count > 4) throw new Error('DER: length too large.');
    if (offset + 2 + count > bytes.length) {
      throw new Error('DER: truncated length.');
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = (length << 8) | bytes[offset + 2 + i];
    }
    headerLength = 2 + count;
  }

  const start = offset + headerLength;
  const end = start + length;
  if (end > bytes.length) throw new Error('DER: element runs past the end.');

  return {
    tag,
    content: bytes.subarray(start, end),
    raw: bytes.subarray(offset, end),
    end,
  };
}

/** Every element directly inside a constructed one. */
export function readSequence(bytes: Uint8Array): DerElement[] {
  const out: DerElement[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const element = readElement(bytes, offset);
    out.push(element);
    offset = element.end;
  }
  return out;
}

/** The dotted form of an OID, for comparing against a known one. */
export function readOid(content: Uint8Array): string {
  if (content.length === 0) return '';
  const parts: number[] = [Math.floor(content[0] / 40), content[0] % 40];
  let value = 0;
  for (let i = 1; i < content.length; i++) {
    value = (value << 7) | (content[i] & 0x7f);
    if ((content[i] & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

/**
 * A DER time, as an ISO string.
 *
 * UTCTime carries a two-digit year, and the pivot below is the one X.509
 * specifies: 50 and above is 19xx, otherwise 20xx.
 */
export function readTime(element: DerElement): Date {
  const text = new TextDecoder().decode(element.content);
  if (element.tag === DER.UTC_TIME) {
    const yy = Number(text.slice(0, 2));
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(
      `${year}-${text.slice(2, 4)}-${text.slice(4, 6)}T` +
        `${text.slice(6, 8)}:${text.slice(8, 10)}:${text.slice(10, 12)}Z`,
    );
  }
  return new Date(
    `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T` +
      `${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}Z`,
  );
}

/**
 * An ECDSA signature converted from DER to the raw `r || s` Web Crypto wants.
 *
 * X.509 and JWS disagree about this. A certificate signs with a DER SEQUENCE of
 * two INTEGERs; `crypto.subtle.verify` expects the two values concatenated and
 * left-padded to the curve size. Getting the padding wrong produces a
 * verification failure indistinguishable from a forged signature.
 */
export function ecdsaDerToRaw(der: Uint8Array, size: number): Uint8Array {
  const [r, s] = readSequence(readElement(der).content);
  const out = new Uint8Array(size * 2);
  place(r.content, out, 0, size);
  place(s.content, out, size, size);
  return out;
}

function place(value: Uint8Array, out: Uint8Array, at: number, size: number) {
  // DER integers are signed, so a value whose top bit is set carries a leading
  // zero byte that is not part of the number.
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const bytes = value.subarray(start);
  if (bytes.length > size) throw new Error('DER: ECDSA value too large.');
  out.set(bytes, at + size - bytes.length);
}
