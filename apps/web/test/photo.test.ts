import { describe, expect, it } from 'vitest';
import { fitWithin, photoName } from '../src/lib/photo';

describe('shrinking receipt photos', () => {
  it('fits the long side within the limit, keeping the shape, and never enlarges', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1500, height: 2000 });
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900 });
    expect(fitWithin(9000, 3, 2000)).toEqual({ width: 2000, height: 1 });
  });
  it('names the shrunk file as a JPEG, dating a camera\'s generic name', () => {
    expect(photoName('fuel-bill.png')).toBe('fuel-bill.jpg');
    expect(photoName('IMG_2041.HEIC.jpeg')).toBe('IMG_2041.HEIC.jpg');
    expect(photoName('image.jpg', new Date(2026, 10, 19, 9, 5, 7))).toBe('receipt-20261119-090507.jpg');
  });
});
