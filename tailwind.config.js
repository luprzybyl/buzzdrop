/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './templates/**/*.html',
    './static/js/**/*.js',
    './static/js/**/*.mjs',
  ],
  theme: {
    extend: {
      colors: {
        // Dark "hive" shell.
        hive: {
          950: '#07080B',
          900: '#0B0D12',
          850: '#101319',
          800: '#151922',
          700: '#1C2029',
          600: '#2A303C',
          500: '#3C4352',
        },
        // Honey accent ramp.
        honey: {
          50: '#FFFBEB',
          100: '#FFF3C9',
          200: '#FFE49B',
          300: '#FFD166',
          400: '#FFB627',
          500: '#F59E0B',
          600: '#D97706',
          700: '#A55A05',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"Apple Color Emoji"',
          'sans-serif',
        ],
      },
      maxWidth: {
        shell: '78rem',
      },
      boxShadow: {
        buzz: '0 40px 100px -60px rgba(0, 0, 0, 0.95)',
        honey: '0 10px 30px -12px rgba(255, 182, 39, 0.45)',
        'honey-lg': '0 24px 70px -24px rgba(255, 182, 39, 0.5)',
        hairline: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.07)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'zoom-in': {
          '0%': { opacity: '0', transform: 'scale(0.94)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        bob: {
          '0%, 100%': { transform: 'translateY(-5px)' },
          '50%': { transform: 'translateY(5px)' },
        },
        drift: {
          '0%': { transform: 'translate3d(0, 0, 0)' },
          '100%': { transform: 'translate3d(-48px, -83.14px, 0)' },
        },
        'cell-pulse': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.95' },
        },
        stripes: {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '32px 0' },
        },
        'bee-fly': {
          '0%': { offsetDistance: '0%', opacity: '0' },
          '8%': { opacity: '1' },
          '92%': { opacity: '1' },
          '100%': { offsetDistance: '100%', opacity: '0' },
        },
        'draw-in': {
          '0%': { strokeDashoffset: '48' },
          '100%': { strokeDashoffset: '0' },
        },
        'halo-pulse': {
          '0%, 100%': { opacity: '0.35', transform: 'scale(1)' },
          '50%': { opacity: '0.7', transform: 'scale(1.06)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) both',
        'zoom-in': 'zoom-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        bob: 'bob 7s ease-in-out infinite',
        drift: 'drift 70s linear infinite',
        'cell-pulse': 'cell-pulse 4s ease-in-out infinite',
        stripes: 'stripes 0.9s linear infinite',
        'bee-fly': 'bee-fly 14s cubic-bezier(0.45, 0, 0.55, 1) infinite',
        'draw-in': 'draw-in 0.8s ease-out 0.25s both',
        'halo-pulse': 'halo-pulse 5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
