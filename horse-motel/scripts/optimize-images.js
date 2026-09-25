// Turns the original listing photos into responsive WebP files (plus one JPEG for link
// previews). Run after adding or replacing a photo: `npm run images`.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOTOS, IMAGE_WIDTHS } from '../src/photos.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'public', 'img');
fs.mkdirSync(out, { recursive: true });

for (const p of PHOTOS) {
  const input = path.join(root, 'photos-src', p.src);
  for (const w of IMAGE_WIDTHS) {
    // .rotate() applies EXIF orientation; metadata (incl. GPS) is dropped by default.
    await sharp(input).rotate().resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 72 }).toFile(path.join(out, `${p.slug}-${w}.webp`));
  }
  const meta = await sharp(input).rotate().metadata();
  p.ratio = +(meta.width / meta.height).toFixed(4);
}
await sharp(path.join(root, 'photos-src', PHOTOS[0].src)).rotate()
  .resize({ width: 1200, height: 630, fit: 'cover' }).jpeg({ quality: 78 })
  .toFile(path.join(out, 'og.jpg'));
fs.writeFileSync(path.join(out, 'manifest.json'),
  JSON.stringify(PHOTOS.map(({ slug, alt, group, ratio }) => ({ slug, alt, group, ratio }))));
console.log(`wrote ${PHOTOS.length * IMAGE_WIDTHS.length} images to public/img`);
