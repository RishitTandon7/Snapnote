/** @type {import('tailwindcss').Config} */
// All colours come from CSS variables (see :root in src/index.css) so the whole palette can be tweaked in one place.
// Variables hold "R G B" channels so opacity modifiers (bg-ink/50, text-mute/80 …) keep working.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
      colors: {
        ink: v('ink'),           // navy/black: text + dark buttons
        paper: v('paper'),       // page lavender
        card: v('card'),
        card2: v('card2'),
        line: v('line'),
        mute: v('mute'),         // muted grey text
        accent: v('coral'),
        coral: v('coral'),       // highlighted words, "View All"
        pink: v('pink'),
        danger: v('danger'),     // end call / destructive
        violet: v('violet'),
        online: v('online'),
        tint: { pink: v('tint-pink'), blue: v('tint-blue'), green: v('tint-green'), amber: v('tint-amber') },
      },
      borderRadius: { '2xl': '1.25rem', '3xl': '1.75rem', '4xl': '2rem' },
      backgroundImage: { brand: 'linear-gradient(135deg,#7c5cff,#ff7ac6)' },
      boxShadow: { soft: '0 8px 30px -12px rgba(40,44,80,.25)', glass: '0 10px 40px -10px rgba(30,34,70,.35)' },
    },
  },
  plugins: [],
}
