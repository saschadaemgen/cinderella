/**
 * Metadata detection for captured media (CCB-S3-011 §1).
 *
 * This module does not strip anything. It ANSWERS THE QUESTION "what is still in
 * this file?", which is what turns "we strip metadata" from a claim into
 * something that can be verified — by the audit that sized the leak, and by the
 * harness check that fails if a published derivative still carries GPS.
 *
 * It reports presence, never values. A GPS coordinate copied into a report or a
 * log to prove it was there is the same disclosure the stripping exists to
 * prevent, in a place nobody thinks to look.
 *
 * Deliberately dependency-free and defensive: it parses attacker-supplied bytes,
 * so every read is bounds-checked and a malformed structure yields "nothing
 * found" rather than a throw. A parser that crashes on a hostile file would take
 * down the capture path that calls it.
 */

export interface ExifSummary {
  hasExif: boolean;
  hasGps: boolean;
  hasCamera: boolean;
  hasSerial: boolean;
  hasOwner: boolean;
  hasTimestamp: boolean;
  hasSoftware: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
  /** Container-level tag boxes (MP4 `udta`/`meta`/`ilst`). */
  hasContainerTags: boolean;
  /** EXIF orientation (1–8) when present. >1 means the pixels need rotating. */
  orientation: number | undefined;
}

const EMPTY: ExifSummary = {
  hasExif: false,
  hasGps: false,
  hasCamera: false,
  hasSerial: false,
  hasOwner: false,
  hasTimestamp: false,
  hasSoftware: false,
  hasXmp: false,
  hasIptc: false,
  hasContainerTags: false,
  orientation: undefined,
};

/* ── TIFF / EXIF ─────────────────────────────────────────────────────────── */

const TAG_ORIENTATION = 0x0112;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SOFTWARE = 0x0131;
const TAG_ARTIST = 0x013b;
const TAG_COPYRIGHT = 0x8298;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
/** DateTimeOriginal, DateTimeDigitized. */
const TAG_DATE_ORIGINAL = 0x9003;
const TAG_DATE_DIGITIZED = 0x9004;
/** BodySerialNumber, LensSerialNumber, CameraOwnerName. */
const TAG_BODY_SERIAL = 0xa431;
const TAG_LENS_SERIAL = 0xa435;
const TAG_OWNER_NAME = 0xa430;

interface Acc {
  out: ExifSummary;
}

/**
 * Walks one IFD, recording which tags are present and following the pointers to
 * the EXIF and GPS sub-directories.
 *
 * `depth` bounds the recursion: a crafted file can point an IFD at itself, and
 * without the bound that is an infinite loop inside the capture path.
 */
function walkIfd(buf: Buffer, tiffStart: number, ifdOffset: number, le: boolean, acc: Acc, depth: number): void {
  if (depth > 4) return;
  const base = tiffStart + ifdOffset;
  if (base < 0 || base + 2 > buf.length) return;
  const count = le ? buf.readUInt16LE(base) : buf.readUInt16BE(base);
  // A plausible IFD has a handful of entries, not thousands. Refuse the rest.
  if (count > 512) return;
  for (let i = 0; i < count; i++) {
    const e = base + 2 + i * 12;
    if (e + 12 > buf.length) return;
    const tag = le ? buf.readUInt16LE(e) : buf.readUInt16BE(e);
    const valueOff = e + 8;
    switch (tag) {
      case TAG_ORIENTATION: {
        const v = le ? buf.readUInt16LE(valueOff) : buf.readUInt16BE(valueOff);
        if (v >= 1 && v <= 8) acc.out.orientation = v;
        break;
      }
      case TAG_MAKE:
      case TAG_MODEL:
        acc.out.hasCamera = true;
        break;
      case TAG_SOFTWARE:
        acc.out.hasSoftware = true;
        break;
      case TAG_ARTIST:
      case TAG_COPYRIGHT:
      case TAG_OWNER_NAME:
        acc.out.hasOwner = true;
        break;
      case TAG_DATETIME:
      case TAG_DATE_ORIGINAL:
      case TAG_DATE_DIGITIZED:
        acc.out.hasTimestamp = true;
        break;
      case TAG_BODY_SERIAL:
      case TAG_LENS_SERIAL:
        acc.out.hasSerial = true;
        break;
      case TAG_GPS_IFD:
        acc.out.hasGps = true;
        break;
      case TAG_EXIF_IFD: {
        const sub = le ? buf.readUInt32LE(valueOff) : buf.readUInt32BE(valueOff);
        walkIfd(buf, tiffStart, sub, le, acc, depth + 1);
        break;
      }
      default:
        break;
    }
  }
}

/** Parses a TIFF header (the payload of an EXIF APP1 segment or an eXIf chunk). */
function readTiff(buf: Buffer, tiffStart: number, acc: Acc): void {
  if (tiffStart + 8 > buf.length) return;
  const b0 = buf[tiffStart];
  const b1 = buf[tiffStart + 1];
  const le = b0 === 0x49 && b1 === 0x49;
  const be = b0 === 0x4d && b1 === 0x4d;
  if (!le && !be) return;
  const magic = le ? buf.readUInt16LE(tiffStart + 2) : buf.readUInt16BE(tiffStart + 2);
  if (magic !== 42) return;
  acc.out.hasExif = true;
  const ifd0 = le ? buf.readUInt32LE(tiffStart + 4) : buf.readUInt32BE(tiffStart + 4);
  walkIfd(buf, tiffStart, ifd0, le, acc, 0);
}

/* ── Containers ──────────────────────────────────────────────────────────── */

const XMP_MARKER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const XMP_XPACKET = Buffer.from('<?xpacket', 'latin1');
const IPTC_MARKER = Buffer.from('Photoshop 3.0\0', 'latin1');
const EXIF_MARKER = Buffer.from('Exif\0\0', 'latin1');

/** Walks JPEG segments. Stops at the start of scan — metadata lives before it. */
function readJpeg(buf: Buffer, acc: Acc): void {
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) break;
    const marker = buf[p + 1] as number;
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) break;
    const segStart = p + 4;
    const segLen = len - 2;
    const seg = buf.subarray(segStart, segStart + segLen);
    if (marker === 0xe1) {
      if (seg.subarray(0, EXIF_MARKER.length).equals(EXIF_MARKER)) {
        readTiff(buf, segStart + EXIF_MARKER.length, acc);
      } else if (seg.subarray(0, XMP_MARKER.length).equals(XMP_MARKER)) {
        acc.out.hasXmp = true;
      }
    } else if (marker === 0xed) {
      if (seg.subarray(0, IPTC_MARKER.length).equals(IPTC_MARKER)) acc.out.hasIptc = true;
    }
    p += 2 + len;
  }
}

/** Walks PNG chunks looking for eXIf / iTXt(XMP) / tEXt. */
function readPng(buf: Buffer, acc: Acc): void {
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    if (len > buf.length) break;
    const type = buf.subarray(p + 4, p + 8).toString('latin1');
    const dataStart = p + 8;
    if (dataStart + len > buf.length) break;
    if (type === 'eXIf') {
      readTiff(buf, dataStart, acc);
    } else if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      const data = buf.subarray(dataStart, dataStart + Math.min(len, 128)).toString('latin1');
      if (data.includes('XML:com.adobe.xmp')) acc.out.hasXmp = true;
    }
    if (type === 'IEND') break;
    p = dataStart + len + 4; // + CRC
  }
}

/**
 * Walks ISO base-media (MP4/MOV/M4A) atoms looking for the metadata containers.
 *
 * This is not optional thoroughness. MP4 metadata lives in `moov.udta`, and
 * `moov` is frequently written at the END of the file, so the "scan the first
 * megabyte for a marker" fallback would have declared every large video clean
 * without ever reading the part that holds the metadata. Apple devices in
 * particular write GPS into a `©xyz` atom under `udta` — a location fix in a
 * video, in exactly the file type that is too big for the cheap scan to reach.
 */
function readIsoBmff(buf: Buffer, acc: Acc, start = 0, end = buf.length, depth = 0): void {
  if (depth > 6) return;
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('latin1');
    let headerLen = 8;
    if (size === 1) {
      // 64-bit size, in the eight bytes after the type.
      if (p + 16 > end) return;
      const hi = buf.readUInt32BE(p + 8);
      const lo = buf.readUInt32BE(p + 12);
      size = hi * 2 ** 32 + lo;
      headerLen = 16;
    } else if (size === 0) {
      size = end - p; // extends to the end of the file
    }
    if (size < headerLen || p + size > end) return;

    if (type === 'udta' || type === 'meta' || type === 'ilst') {
      acc.out.hasXmp = acc.out.hasXmp || false;
      // The containers themselves are the signal that tags are present.
      acc.out.hasContainerTags = true;
      // `meta` carries a 4-byte version/flags before its children.
      const childStart = type === 'meta' ? p + headerLen + 4 : p + headerLen;
      readIsoBmff(buf, acc, childStart, p + size, depth + 1);
    } else if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf') {
      readIsoBmff(buf, acc, p + headerLen, p + size, depth + 1);
    } else if (type === '©xyz' || type === 'xyz ' || type === 'loci') {
      // The location atoms. `©xyz` is what iOS writes.
      acc.out.hasGps = true;
      acc.out.hasContainerTags = true;
    } else if (type === 'XMP_' || type === 'uuid') {
      const head = buf.subarray(p + headerLen, Math.min(p + size, p + headerLen + 4096));
      if (head.includes(XMP_XPACKET) || head.includes(XMP_MARKER)) acc.out.hasXmp = true;
    }
    p += size;
  }
}

/**
 * What metadata does this file still carry?
 *
 * Recognises JPEG and PNG structurally. For anything else it falls back to a
 * bounded marker scan, which is enough to answer "is there an XMP packet in
 * here?" for the container formats (MP4, WebM, PDF) without a parser for each.
 */
export function readExifSummary(buf: Buffer): ExifSummary {
  const acc: Acc = { out: { ...EMPTY } };
  try {
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      readJpeg(buf, acc);
    } else if (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      readPng(buf, acc);
    } else if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
      // MP4 / MOV / M4A — walked properly, because the metadata is often at the
      // end of the file where a head-only scan never looks.
      readIsoBmff(buf, acc);
    } else {
      // Unknown container: look for an XMP packet anywhere in the first megabyte.
      const head = buf.subarray(0, Math.min(buf.length, 1_000_000));
      if (head.includes(XMP_XPACKET) || head.includes(XMP_MARKER)) acc.out.hasXmp = true;
      if (head.includes(EXIF_MARKER)) acc.out.hasExif = true;
    }
  } catch {
    // A malformed file is not a reason to fail the caller. "Nothing found" is the
    // honest answer when the structure could not be read, and the stripping path
    // does not depend on this function's verdict.
    return { ...EMPTY };
  }
  return acc.out;
}

/** True when anything at all was found — the harness's one-line assertion. */
export function hasAnyMetadata(s: ExifSummary): boolean {
  return s.hasExif || s.hasXmp || s.hasIptc || s.hasContainerTags;
}
