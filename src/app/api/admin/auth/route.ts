import { NextRequest, NextResponse } from 'next/server'
import { ADMIN_COOKIE, hasAdminSession, issueAdminSession, verifyAdminCode } from '@/lib/admin'

export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json({ authenticated: await hasAdminSession() })
}

/** Gear icon → code dialog → this. */
export async function POST(request: NextRequest) {
  let body: { code?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const code = (body.code ?? '').trim()
  if (code === '') {
    return Response.json({ error: '코드를 입력해 주세요.' }, { status: 400 })
  }

  if (!(await verifyAdminCode(code))) {
    // Small delay so the dialog cannot be brute-forced at full speed from a
    // kiosk that someone walked away from.
    await new Promise((resolve) => setTimeout(resolve, 600))
    return Response.json({ error: '코드가 올바르지 않습니다.' }, { status: 401 })
  }

  const { token, maxAge } = issueAdminSession()
  const response = NextResponse.json({ ok: true })
  response.cookies.set({
    name: ADMIN_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  })
  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.set({ name: ADMIN_COOKIE, value: '', path: '/', maxAge: 0 })
  return response
}
