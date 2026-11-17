// Turns assets/tray-icon.svg into the menu bar icon at 1x and 2x (Retina): the drawing as it
// is for when DesktopJarvis is idle, and one frame per step of the fire's flicker for when it
// is working. The "Template" in the file names tells macOS to recolour them for light and
// dark menu bars.
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = fs.readFileSync("assets/tray-icon.svg", "utf8");
fs.rmSync("dist/tray", { recursive: true, force: true });
fs.mkdirSync("dist/tray", { recursive: true });

function render(source, name) {
  for (const [scale, suffix] of [
    [1, ""],
    [2, "@2x"],
  ]) {
    const png = new Resvg(source, { fitTo: { mode: "width", value: 18 * scale } }).render().asPng();
    fs.writeFileSync(`dist/tray/${name}${suffix}.png`, png);
  }
}

// The flicker is an <animateTransform> on the #flicker group. Each frame replaces the
// animation with one of its values, held still.
const animation = svg.match(/<animateTransform[\s\S]*?\/>/);
if (!animation) throw new Error("assets/tray-icon.svg has no <animateTransform> for the fire");
const values = animation[0]
  .match(/values="([^"]+)"/)[1]
  .split(";")
  .map((value) => value.trim());
const duration = parseFloat(animation[0].match(/dur="([\d.]+)s"/)[1]);
const still = (transform) =>
  svg.replace(animation[0], "").replace('<g id="flicker">', `<g id="flicker" transform="${transform}">`);

render(still(""), "trayTemplate");
values.forEach((value, frame) => render(still(`scale(${value})`), `trayFire${frame}Template`));
fs.writeFileSync(
  "dist/tray/frames.json",
  JSON.stringify({ frames: values.length, intervalMs: Math.round((duration * 1000) / values.length) }),
);
console.log(`Wrote the menu bar icon and ${values.length} fire frames`);
