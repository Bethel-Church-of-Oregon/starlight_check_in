'use client'

import { useEffect } from 'react'

/**
 * Registers the offline shell. The service worker never caches API responses —
 * a stale roster or a stale check-in would be worse than an error message.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((error) => console.error('service worker registration failed', error))
    }

    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }, [])

  return null
}
