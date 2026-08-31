/**
 * Unsaved-changes guard for in-app navigation.
 *
 * react-router's useBlocker needs a data router; main.tsx mounts a plain
 * <BrowserRouter>. Both places that navigate programmatically (App.tsx's dev
 * Navigation and AppNavMenu's <ui-nav-menu> links) call runNavGuard() first and
 * abandon the navigation if it returns false.
 *
 * Only one guard can be registered at a time — only one page has a form.
 */
let guard: (() => boolean) | null = null;

export function setNavGuard(fn: (() => boolean) | null): void {
  guard = fn;
}

/** @returns true when navigation may proceed. */
export function runNavGuard(): boolean {
  return guard ? guard() : true;
}
