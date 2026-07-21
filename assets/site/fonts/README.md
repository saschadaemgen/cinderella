# Self-hosted webfonts (CCB-S3-001)

Subsetted woff2 files as served by Google Fonts, vendored so the public site
stays fully self-contained under its strict CSP (`font-src 'self'`, no CDN).

- **Source Sans 3** — © Adobe, SIL Open Font License 1.1
  (https://fonts.google.com/specimen/Source+Sans+3)
- **JetBrains Mono** — © JetBrains, SIL Open Font License 1.1
  (https://fonts.google.com/specimen/JetBrains+Mono)

Both licenses permit redistribution and self-hosting. The files are variable
instances shared across weights (400–700 normal / 400 italic for Source Sans 3;
400–500 for JetBrains Mono), one file per unicode subset — the `@font-face`
declarations with matching `unicode-range` live in `src/web/site/css.ts`.
