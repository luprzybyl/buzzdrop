/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './templates/**/*.html',
    './static/js/**/*.js',
  ],
  theme: {
    extend: {
      boxShadow: {
        buzz: '0 24px 80px -40px rgba(15, 23, 42, 0.45)',
      },
    },
  },
  plugins: [],
};
