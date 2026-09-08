import type { Metadata, Viewport } from 'next'
import './globals.css'
import { AppProvider } from '@/components/app-context'
import AppShell from '@/components/AppShell'
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister'

export const metadata: Metadata = {
  title: 'Bethel Starlight Check-in',
  description: 'Children’s ministry check-in for Bethel Starlight',
  applicationName: 'Starlight Check-in',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Check-in',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // A kiosk that a child can pinch-zoom is a kiosk that needs resetting.
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#8459a8',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <AppProvider>
          <AppShell>{children}</AppShell>
        </AppProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  )
}
