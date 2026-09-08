'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Avatar, { displayName } from '@/components/Avatar'
import { useApp } from '@/components/app-context'
import { AlertIcon, PlusIcon, SearchIcon, XIcon } from '@/components/icons'

interface SearchResult {
  id: string
  korean_name: string | null
  english_name: string | null
  grade: string
  code: string | null
  guardian_name: string | null
  guardian_phone: string | null
  allergies: string | null
  medical_notes: string | null
  today_code: string | null
  today_service: string | null
  today_checked_in_at: string | null
}

const DEBOUNCE_MS = 180

/**
 * The default screen: one big search box, live results underneath, and an
 * "Add person" affordance when nothing matches.
 */
export default function SearchScreen() {
  const router = useRouter()
  const { degraded } = useApp()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchedFor, setSearchedFor] = useState('')

  // "Start over" in the header while already on this screen just resets it.
  useEffect(() => {
    const reset = () => {
      setQuery('')
      setResults([])
      setSearchedFor('')
      setError(null)
      inputRef.current?.focus()
    }
    window.addEventListener('starlight:start-over', reset)
    return () => window.removeEventListener('starlight:start-over', reset)
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // --- debounced live search ---------------------------------------------
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setResults([])
      setSearchedFor('')
      setLoading(false)
      return
    }

    setLoading(true)
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/students/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
          cache: 'no-store',
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? 'search failed')
        setResults(data.students ?? [])
        setError(null)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setError('검색에 실패했습니다. 네트워크를 확인해 주세요.')
        setResults([])
      } finally {
        setSearchedFor(trimmed)
        setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query])

  const goToCheckIn = useCallback((id: string) => router.push(`/checkin/${id}`), [router])

  const addPerson = useCallback(() => {
    const trimmed = query.trim()
    router.push(trimmed ? `/new?name=${encodeURIComponent(trimmed)}` : '/new')
  }, [query, router])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    // A barcode scanner in keyboard mode ends with Enter: jump straight in when
    // the scan resolved to exactly one child.
    if (results.length === 1) goToCheckIn(results[0].id)
  }

  const showEmpty = useMemo(
    () => !loading && searchedFor !== '' && results.length === 0,
    [loading, searchedFor, results.length]
  )

  return (
    <div className="stack">
      <div className="searchCard">
        <div className="searchField">
          <input
            ref={inputRef}
            type="search"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            placeholder="이름, 전화번호, 바코드로 검색하거나 새로 등록"
            aria-label="Search or add new by name, phone number, or barcode"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {query !== '' && (
            <button
              type="button"
              className="searchClear"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              aria-label="Clear search"
            >
              <XIcon size={20} />
            </button>
          )}
          <span className="searchIcon">
            {loading ? <span className="spinner" /> : <SearchIcon size={24} />}
          </span>
        </div>
      </div>

      {degraded && (
        <div className="card">
          <div className="cardBody">
            <div className="banner bannerWarn" role="alert">
              <AlertIcon size={18} />
              <span>
                데이터베이스에 연결할 수 없어 기본 설정으로 표시하고 있습니다. 검색과 체크인이
                동작하지 않을 수 있습니다.
              </span>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="card">
          <div className="cardBody">
            <div className="banner bannerError" role="alert">
              <AlertIcon size={18} />
              <span>{error}</span>
            </div>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="card">
          <div className="resultList">
            {results.map((student) => (
              <button
                key={student.id}
                type="button"
                className="resultRow"
                onClick={() => goToCheckIn(student.id)}
              >
                <Avatar korean={student.korean_name} english={student.english_name} />
                <span className="resultMain">
                  <span className="resultName">
                    {displayName(student.korean_name, student.english_name)}
                    {student.korean_name && student.english_name && (
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 15 }}>
                        {student.english_name}
                      </span>
                    )}
                  </span>
                  <span className="resultSub">
                    <span className="chip">{student.grade}</span>
                    {student.today_checked_in_at && (
                      <span className="chip chipGreen">
                        오늘 체크인됨 · {student.today_code}
                      </span>
                    )}
                    {student.allergies && <span className="chip chipWarn">알레르기</span>}
                    {student.guardian_phone && <span>{student.guardian_phone}</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {showEmpty && (
        <div className="card">
          <div className="emptyState">
            <div style={{ marginBottom: 16 }}>
              “{searchedFor}”와 일치하는 학생이 없습니다.
            </div>
            <button type="button" className="btn btnPrimary btnLarge" onClick={addPerson}>
              <PlusIcon size={18} />
              Add person
            </button>
          </div>
        </div>
      )}

      {!loading && searchedFor === '' && results.length === 0 && (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 15 }}>
          이름을 입력하면 바로 찾아드려요
        </div>
      )}
    </div>
  )
}
