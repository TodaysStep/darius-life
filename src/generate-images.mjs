// Generates the link-preview image and icons at build time, in the site's own
// two colours (#F6F3EE / #111111) and its own font (Courier Prime) — no photo,
// no illustration, no other colour. resvg (via ttf-parser) cannot read WOFF2
// directly, so each font is decompressed to raw TTF once per build with wawoff2
// and handed to resvg as a file path (its only supported font-loading form).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { decompress } from "wawoff2";
import { imagesToIco } from "png-to-ico";
import { PNG } from "pngjs";

const BG = "#F6F3EE";
const FG = "#111111";
const FAMILY = "Courier Prime";

async function decodeFonts(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "darius-life-fonts-"));
  const files = [];
  for (const name of ["CourierPrime-Regular", "CourierPrime-Bold"]) {
    const woff2 = fs.readFileSync(path.join(root, `assets/fonts/courier-prime/${name}.woff2`));
    const ttf = await decompress(woff2);
    const p = path.join(dir, `${name}.ttf`);
    fs.writeFileSync(p, ttf);
    files.push(p);
  }
  return files;
}

function rasterize(svg, fontFiles) {
  const resvg = new Resvg(svg, {
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: FAMILY },
  });
  return resvg.render().asPng();
}

function markSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<rect width="${size}" height="${size}" fill="${BG}"/>
<text x="50%" y="53%" text-anchor="middle" dominant-baseline="central" font-family="${FAMILY}" font-weight="700" font-size="${Math.round(size * 0.6)}" fill="${FG}">M</text>
</svg>`;
}

export async function generateImages(root) {
  const fontFiles = await decodeFonts(root);

  const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
<rect width="1200" height="630" fill="${BG}"/>
<text x="100" y="310" font-family="${FAMILY}" font-weight="700" font-size="80" fill="${FG}">Michael Darius</text>
<text x="100" y="380" font-family="${FAMILY}" font-weight="400" font-size="44" fill="${FG}">darius.life</text>
</svg>`;

  const og = rasterize(ogSvg, fontFiles);
  const appleTouchIcon = rasterize(markSvg(180), fontFiles);

  // Only the small raster sizes a favicon actually needs (16/32/48) — pngToIco's
  // own default export always adds a 256px layer too, which alone would blow the
  // page-weight budget (check 15) for what's just a tab icon.
  const favicon = imagesToIco([16, 32, 48].map((size) => PNG.sync.read(rasterize(markSvg(size), fontFiles))));

  const boldWoff2B64 = fs.readFileSync(path.join(root, "assets/fonts/courier-prime/CourierPrime-Bold.woff2")).toString("base64");
  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<style>@font-face{font-family:'CP';src:url(data:font/woff2;base64,${boldWoff2B64}) format('woff2');}</style>
<rect width="32" height="32" fill="${BG}"/>
<text x="50%" y="53%" text-anchor="middle" dominant-baseline="central" font-family="CP" font-weight="700" font-size="20" fill="${FG}">M</text>
</svg>`;

  return { og, appleTouchIcon, favicon, faviconSvg };
}
