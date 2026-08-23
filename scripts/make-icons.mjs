/* Renders the PWA icon PNGs from their SVG sources.

   The PNGs are committed — a home-screen install has to work without a build
   step having run anything extra — so this only needs running when the artwork
   in public/app-icon*.svg changes:  node scripts/make-icons.mjs
   Uses @resvg/resvg-js, already a dependency for the portfolio-snapshot email. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const OUTPUTS = [
  { src: 'public/app-icon.svg', out: 'public/icon-192.png', size: 192 },
  { src: 'public/app-icon.svg', out: 'public/icon-512.png', size: 512 },
  { src: 'public/app-icon.svg', out: 'public/apple-touch-icon.png', size: 180 },
  { src: 'public/app-icon-maskable.svg', out: 'public/icon-maskable-512.png', size: 512 },
];

for (const { src, out, size } of OUTPUTS) {
  const svg = readFileSync(src, 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(out, png);
  console.log(`${out}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`);
}
