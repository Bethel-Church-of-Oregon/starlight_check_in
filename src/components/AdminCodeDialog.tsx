'use client'

import { useCallback, useEffect, useState } from 'react'
import { XIcon } from './icons'

const MAX_LENGTH = 12

/**
 * The gear icon opens this. A keypad rather than a text field: it is faster on
 * a wall-mounted iPad and it never brings up the software keyboard over the
 * dialog.
 */
export default function AdminCodeDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void
  onSuccess: () => void | Promise<void>
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(
    async (value: string) => {
      if (value.length === 0 || busy) return
      setBusy(true)
      setError(null)
      try {
        const response = await fetch('/api/admin/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: value }),
        })
        if (response.ok) {
          await onSuccess()
          return
        }
        const data = await response.json().catch(() => ({}))
        setError(data.error ?? '코드가 올바르지 않습니다.')
        setCode('')
      } catch {
        setError('네트워크 오류입니다. 다시 시도해 주세요.')
      } finally {
        setBusy(false)
      }
    },
    [busy, onSuccess]
  )

  // Physical keyboards (and barcode scanners in keyboard mode) work too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose()
      if (event.key === 'Enter') return void submit(code)
      if (event.key === 'Backspace') return setCode((c) => c.slice(0, -1))
      if (/^[0-9]$/.test(event.key)) {
        setCode((c) => (c.length >= MAX_LENGTH ? c : c + event.key))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [code, onClose, submit])

  const press = (digit: string) => {
    setError(null)
    setCode((c) => (c.length >= MAX_LENGTH ? c : c + digit))
  }

  return (
    <div
      className="modalBackdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings access code"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal">
        <div className="cardHeader">
          <span>관리자 코드</span>
          <button type="button" className="iconBtn" onClick={onClose} aria-label="Close">
            <XIcon size={18} />
          </button>
        </div>

        <div className="cardBody">
          <div className="codeDisplay" aria-hidden="true">
            {Array.from({ length: Math.max(4, code.length) }).map((_, index) => (
              <span
                key={index}
                className={`codeDot ${index < code.length ? 'codeDotFilled' : ''}`}
              />
            ))}
          </div>

          {error && (
            <div className="banner bannerError" style={{ marginBottom: 14 }} role="alert">
              {error}
            </div>
          )}

          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button key={digit} type="button" onClick={() => press(digit)}>
                {digit}
              </button>
            ))}
            <button
              type="button"
              className="keyWide"
              onClick={() => setCode((c) => c.slice(0, -1))}
            >
              지우기
            </button>
            <button type="button" onClick={() => press('0')}>
              0
            </button>
            <button
              type="button"
              className="keyWide"
              style={{ background: 'var(--blue)', borderColor: 'var(--blue)', color: '#fff' }}
              onClick={() => void submit(code)}
              disabled={busy || code.length === 0}
            >
              {busy ? <span className="spinner" /> : '확인'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
