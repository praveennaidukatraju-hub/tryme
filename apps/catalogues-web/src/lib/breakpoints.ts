// Single source of truth for this app's responsive breakpoints — everywhere a
// component needs a raw pixel value (inline <style> template literals,
// useMediaQuery() calls). Mirrors tailwind.config.ts's `theme.screens`
// (Tailwind's own defaults, made explicit there) — keep both in sync if either
// changes. CSS files that go through the Tailwind/PostCSS pipeline (globals.css)
// should use Tailwind's `@screen` at-rule against that config instead of this
// file; this file exists because CSS custom properties cannot be referenced
// inside an `@media` feature value (`@media (min-width: var(--x))` is invalid
// CSS — evaluated before the cascade resolves custom properties), and
// styled-jsx / dangerouslySetInnerHTML <style> blocks never go through
// PostCSS, so `@screen` isn't available inside them either.
export const BREAKPOINTS = {
  xs: 480,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;
