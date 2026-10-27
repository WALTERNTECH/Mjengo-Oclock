// Renders the PNG icons and the share image from the SVGs in this folder: node brand/build-icons.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "frontend", "public");
const icon = fs.readFileSync(path.join(here, "mjengo-app-icon.svg"));
for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
  await sharp(icon, { density: 400 }).resize(size, size).png().toFile(path.join(pub, name));
}
const mark = fs.readFileSync(path.join(here, "mjengo-mark.svg"), "utf8").replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#FFFFFF"/>
<rect y="618" width="1200" height="12" fill="#0B7A3B"/>
<svg x="120" y="215" width="160" height="160" viewBox="0 0 64 64">${mark}</svg>
<text x="320" y="318" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="76" fill="#0B0F0C">Mjengo <tspan fill="#0B7A3B">O'clock</tspan></text>
<text x="324" y="376" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#4A524D">Construction workers on demand in Nairobi</text>
</svg>`;
fs.writeFileSync(path.join(here, "mjengo-og.svg"), og);
await sharp(Buffer.from(og)).png().toFile(path.join(pub, "og.png"));
console.log("icons written");
