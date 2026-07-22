/**
 * Hand-built metadata fixtures (CCB-S3-011 §1.5).
 *
 * A check that "the stripped file has no GPS" is worthless unless something can
 * demonstrate the detector finds GPS when it IS there. `sharp` cannot help:
 * asked to write a GPS block it silently produces an EXIF segment with no GPS
 * IFD at all (verified — IFD0 comes back without tag 0x8825), so a fixture built
 * with it would make the harness pass by detecting nothing, which is exactly the
 * failure it is meant to catch.
 *
 * So the bytes are assembled here by hand, to the TIFF spec, and the harness
 * asserts BOTH directions: this file has GPS, and its stripped derivative does
 * not.
 */

/** Little-endian 16-bit. */
function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

/** Little-endian 32-bit. */
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

/** One 12-byte IFD entry: tag, type, count, and an inline value or an offset. */
function entry(tag: number, type: number, count: number, value: Buffer): Buffer {
  const v = Buffer.alloc(4);
  value.copy(v, 0, 0, Math.min(4, value.length));
  return Buffer.concat([u16(tag), u16(type), u32(count), v]);
}

/**
 * A TIFF block whose IFD0 points at a GPS sub-directory holding a latitude
 * reference — the minimum that makes a file "carries GPS" true.
 */
export function buildExifWithGps(): Buffer {
  const TYPE_ASCII = 2;
  const TYPE_LONG = 4;
  const TAG_GPS_IFD = 0x8825;
  const TAG_GPS_LAT_REF = 0x0001;

  // header(8) + ifd0 count(2) + one entry(12) + next(4) = 26 → the GPS IFD.
  const gpsIfdOffset = 26;
  const header = Buffer.concat([Buffer.from('II', 'latin1'), u16(42), u32(8)]);
  const ifd0 = Buffer.concat([
    u16(1),
    entry(TAG_GPS_IFD, TYPE_LONG, 1, u32(gpsIfdOffset)),
    u32(0),
  ]);
  const gpsIfd = Buffer.concat([
    u16(1),
    entry(TAG_GPS_LAT_REF, TYPE_ASCII, 2, Buffer.from('N\0', 'latin1')),
    u32(0),
  ]);
  return Buffer.concat([header, ifd0, gpsIfd]);
}

/**
 * Wraps a TIFF block into a JPEG as an EXIF APP1 segment, immediately after SOI.
 * `jpeg` must be a real JPEG — the segment is spliced in, the image data is not
 * touched, so the result decodes normally.
 */
export function injectExifIntoJpeg(jpeg: Buffer, tiff: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(payload.length + 2);
      return b;
    })(),
    payload,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
