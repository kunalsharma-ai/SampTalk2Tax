/**
 * Phone photos of receipts are often 4 to 12 MB, over the 5 MB attachment limit. Before upload, a
 * photo larger than it needs to be is redrawn at most `maxEdge` pixels on its long side as a JPEG,
 * which keeps a receipt legible at a fraction of the size. PDFs, small images and anything the
 * browser cannot decode are returned unchanged; the server still checks every file.
 */
export const PHOTO_MAX_EDGE = 2000;
export const PHOTO_SHRINK_ABOVE_BYTES = 1_500_000;

/** The size to draw a `w`×`h` image at so its long side is at most `maxEdge` (never enlarged). */
export function fitWithin(w: number, h: number, maxEdge = PHOTO_MAX_EDGE): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** `receipt.png` → `receipt.jpg`; a camera's generic `image.jpg` gets a dated name. */
export function photoName(name: string, now = new Date()): string {
  const base = name.replace(/\.[^.]+$/, '');
  if (!base || /^image$/i.test(base)) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `receipt-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.jpg`;
  }
  return `${base}.jpg`;
}

const SHRINKABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function shrinkPhoto(file: File, maxEdge = PHOTO_MAX_EDGE, quality = 0.85): Promise<File> {
  if (!SHRINKABLE.has(file.type) || typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    if (file.size <= PHOTO_SHRINK_ABOVE_BYTES && width === bitmap.width) return file;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff'; // transparent PNG areas become white, not black
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], photoName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}
