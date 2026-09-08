import { redirect } from 'next/navigation'
import { hasAdminSession } from '@/lib/admin'
import SettingsClient from '@/components/settings/SettingsClient'

export const dynamic = 'force-dynamic'

/**
 * Server-side gate. The gear icon in the footer collects the code and sets the
 * session cookie; anyone who lands here without it goes back to the kiosk.
 */
export default async function SettingsPage() {
  if (!(await hasAdminSession())) redirect('/')
  return <SettingsClient />
}
