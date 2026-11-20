/**
 * The dashboard's styles are generated at build time from the classes in its one page, so the
 * page loads nothing from another host (audit D-07). `npm run build:css` writes
 * src/ui/public/dashboard.css, which is committed and shipped next to index.html.
 */
module.exports = {
  content: ['./src/ui/public/index.html'],
  theme: { extend: {} },
  plugins: [],
};
