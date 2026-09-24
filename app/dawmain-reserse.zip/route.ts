import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The dawmain-reserse skill packed the way both Claude and ChatGPT upload
 * skills: a zip holding dawmain-reserse/SKILL.md. Built from the same file
 * the .md route serves, at build time (force-static), so the two downloads
 * can never disagree.
 */
export const dynamic = "force-static";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A one-file zip, stored uncompressed - a skill is small enough that
 * deflate would buy nothing worth a dependency. */
function zipOne(name: string, data: Buffer): Buffer {
  const fileName = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const utf8Flag = 0x0800;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(utf8Flag, 6);
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(0, 10); // time, date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(utf8Flag, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  // extra, comment, disk, internal attrs, external attrs, local offset: all 0

  const localSize = local.length + fileName.length + data.length;
  const centralSize = central.length + fileName.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);

  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

export async function GET(): Promise<Response> {
  const file = path.join(process.cwd(), "skills", "dawmain-reserse", "SKILL.md");
  const zip = zipOne("dawmain-reserse/SKILL.md", await fs.readFile(file));
  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="dawmain-reserse.zip"',
    },
  });
}
