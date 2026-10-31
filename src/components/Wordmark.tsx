import { SIGNATURE } from '../lib/signature'

/** "Snapnote" in the brand's handwritten lettering (same outlines the loading screen draws). */
export function Wordmark({ className = 'w-[230px]' }: { className?: string }) {
  return (
    <>
      <h1 className="sr-only">Snapnote</h1>
      <svg viewBox={SIGNATURE.viewBox} className={`overflow-visible ${className}`} fill="rgb(var(--ink))" aria-hidden>
        {SIGNATURE.glyphs.map((g, i) => <path key={i} d={g.d} />)}
      </svg>
    </>
  )
}
