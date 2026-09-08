/**
 * Planning Center shows photos here. We do not collect them, so the next best
 * thing that still reads as "a person" at a glance is an initial in a colour
 * derived from the name — same child, same colour, every week.
 */
const PALETTE = [
  '#7b5ea7',
  '#3f7fbf',
  '#2f9e78',
  '#c9803f',
  '#c25f7a',
  '#5b7fa6',
  '#8a7a3f',
  '#4f8f8a',
]

function hash(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function displayName(korean?: string | null, english?: string | null): string {
  return korean?.trim() || english?.trim() || '?'
}

export function initialOf(korean?: string | null, english?: string | null): string {
  const source = displayName(korean, english)
  // A Hangul syllable is already a whole "initial"; Latin names get one letter.
  return source.slice(0, 1).toUpperCase()
}

export default function Avatar({
  korean,
  english,
  size = 'md',
}: {
  korean?: string | null
  english?: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const name = displayName(korean, english)
  const color = PALETTE[hash(name) % PALETTE.length]
  const cls = size === 'sm' ? 'avatar avatarSm' : size === 'lg' ? 'avatar avatarLg' : 'avatar'
  return (
    <span className={cls} style={{ background: color }} aria-hidden="true">
      {initialOf(korean, english)}
    </span>
  )
}
