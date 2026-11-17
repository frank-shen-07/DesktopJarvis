// Draws the app icon (a ring core on a dark tile) as a 1024px PNG, with no dependencies.
import fs from "node:fs";
import zlib from "node:zlib";

const SIZE = 1024;
const pixels = Buffer.alloc(SIZE * SIZE * 4);
const clamp = (value) => Math.max(0, Math.min(1, value));
const mix = (a, b, t) => a.map((channel, i) => channel + (b[i] - channel) * t);

const VOID = [2, 8, 18];
const DEEP = [8, 38, 78];
const BLUE = [30, 167, 255];
const BRIGHT = [200, 238, 255];

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const dx = x + 0.5 - SIZE / 2;
    const dy = y + 0.5 - SIZE / 2;
    // Rounded tile with the margin macOS icons keep.
    const half = 412;
    const corner = 185;
    const qx = Math.abs(dx) - (half - corner);
    const qy = Math.abs(dy) - (half - corner);
    const tile = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
    const alpha = clamp(0.5 - tile);
    const distance = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);

    let colour = mix(DEEP, VOID, clamp(distance / 520));
    const ring = (radius, width, tint, strength = 1) => {
      const edge = clamp(width / 2 + 0.5 - Math.abs(distance - radius));
      const glow = Math.exp(-((distance - radius) ** 2) / (2 * (width * 2.2) ** 2)) * 0.35;
      colour = mix(colour, tint, clamp((edge + glow) * strength));
    };
    const segment = (from, to) => angle >= from && angle <= to;

    ring(330, 6, BLUE, 0.9);
    if (segment(0.25, 1.9) || segment(2.4, 3.9) || segment(4.4, 5.9)) ring(278, 22, BLUE);
    if (segment(1.0, 2.6) || segment(4.1, 5.6)) ring(215, 34, BLUE, 0.7);
    ring(140, 12, BRIGHT);
    colour = mix(colour, BRIGHT, clamp(1 - distance / 120) * 0.85);

    const offset = (y * SIZE + x) * 4;
    pixels[offset] = colour[0];
    pixels[offset + 1] = colour[1];
    pixels[offset + 2] = colour[2];
    pixels[offset + 3] = Math.round(alpha * 255);
  }
}

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
};

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 6, 0, 0, 0], 8);

const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

fs.mkdirSync("build", { recursive: true });
fs.writeFileSync(
  "build/icon.png",
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log("Wrote build/icon.png");
