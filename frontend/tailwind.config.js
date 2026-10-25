/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "../dist/**/*.{html,js}"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        slate: {
          850: '#172033',
          950: '#020617',
        },
        sport: {
          run: '#10b981',
          cycle: '#06b6d4',
          strength: '#f59e0b',
        }
      }
    },
  },
  plugins: [],
}
