import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Pixelify_Sans } from 'next/font/google';
import './globals.css';

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono' });
// Display face for the wordmark, hero heading, step numbers and small status labels only.
const pixel = Pixelify_Sans({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-pixel' });

export const metadata: Metadata = {
  title: 'MandateGate · Treasury authorization on GenLayer',
  description:
    'An on-chain authorization gate that adjudicates a treasury liquidity proposal against deterministic limits and a frozen natural-language mandate, with evidence fetched independently by GenLayer validators.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#fff4e6',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${pixel.variable}`}>
      <body>{children}</body>
    </html>
  );
}
