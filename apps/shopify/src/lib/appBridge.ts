declare global {
  interface Window {
    shopify?: {
      idToken(): Promise<string>;
      saveBar?: {
        show(id: string): Promise<void>;
        hide(id: string): Promise<void>;
      };
    };
  }

  // @types/react 19 (installed here despite the app running React 18 at
  // runtime) moved the JSX namespace that "jsx": "react-jsx" actually consults
  // from the bare global `JSX` to `React.JSX` — augmenting plain `JSX` is a
  // silent no-op under this setup. See @types/react's react/jsx-runtime.d.ts,
  // which re-exports `React.JSX.IntrinsicElements` under its own `JSX` export.
  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        'ui-nav-menu': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
        'ui-save-bar': React.DetailedHTMLProps<
          React.HTMLAttributes<HTMLElement> & { id: string },
          HTMLElement
        >;
      }
    }
  }
}

/**
 * Thrown when App Bridge's idToken() never settles. Distinct from a normal API
 * failure because the recovery is different: the App Bridge instance itself is
 * wedged, so retrying the call in place cannot succeed — only a fresh document
 * (and therefore a fresh App Bridge instance) can.
 */
export class AppBridgeTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for App Bridge session token');
    this.name = 'AppBridgeTimeoutError';
  }
}

// App Bridge's idToken() round-trips a postMessage to the parent Shopify admin
// frame. There is a known, still-open Shopify bug where every App Bridge call
// on a second instance within the same admin session (i.e. after the merchant
// navigates Products -> back into the app, which re-points the iframe without a
// full page load) hangs forever: never resolves, never rejects, no console
// error. See https://github.com/Shopify/shopify-app-bridge/issues/179 and
// https://community.shopify.dev/t/shopify-idtoken-does-not-resolve/28349.
// Without a timeout here the whole app sits on its boot spinner indefinitely.
const ID_TOKEN_TIMEOUT_MS = 8000;

export async function getIdToken(): Promise<string> {
  if (!window.shopify) {
    throw new Error('App Bridge not loaded — is this app running inside the Shopify admin iframe?');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      window.shopify.idToken(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new AppBridgeTimeoutError()), ID_TOKEN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Reloading the frame swaps in a fresh App Bridge instance, which is the only
// known way out of the hang above — but a reload that does not fix it must not
// become a reload loop, so we allow exactly one per tab session and fall back
// to showing the merchant an error instead.
const RECOVERY_RELOAD_MARKER = 'tryme:appbridge-recovery-reload';

export function shouldAttemptRecoveryReload(): boolean {
  try {
    if (sessionStorage.getItem(RECOVERY_RELOAD_MARKER)) return false;
    sessionStorage.setItem(RECOVERY_RELOAD_MARKER, '1');
    return true;
  } catch {
    // sessionStorage can be unavailable in a partitioned or storage-blocked
    // iframe. With no way to record the attempt there is no way to bound the
    // reloads, so don't start a loop we can't stop.
    return false;
  }
}

export function clearRecoveryReloadMarker(): void {
  try {
    sessionStorage.removeItem(RECOVERY_RELOAD_MARKER);
  } catch {
    // Best-effort: only affects whether a later hang gets its one auto-reload.
  }
}

// The FORBIDDEN → OAuth one-shot guard that used to live here is gone with the
// redirect it guarded. Under managed installation the server provisions a store
// from the session token on first contact, so "store not installed" is no
// longer a state the frontend can or should resolve by starting OAuth.
