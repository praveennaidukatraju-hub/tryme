'use client';

// The shared PlusIcon (@/components/icons) renders at strokeWidth 1.5, which
// reads as too thin/light against this section's gradient CTA buttons. Local
// to tryon-library-app rather than changing the shared icon, which is reused
// app-wide well past this section's "Add Category"/"Add Product" buttons.
export function BoldPlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
