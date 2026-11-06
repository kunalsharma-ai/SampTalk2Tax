import type { MetadataRoute } from 'next';

/** Lets people add Talk2Tax to a phone or desktop home screen with the brand icon. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Talk2Tax by Sampledge',
    short_name: 'Talk2Tax',
    description: 'Accounting, tax and finance workspace. Talk. File. Relax.',
    start_url: '/',
    display: 'standalone',
    background_color: '#050a18',
    theme_color: '#050a18',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
