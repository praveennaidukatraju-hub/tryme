import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, initAuthFailureHandler, setToken } from '../lib/data';

export type AdminRole = 'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT' | 'ADMIN';

interface AuthState {
  token: string | null;
  role: AdminRole | null;
  email: string | null;
  permissions: string[];
  hasPermission: (permission: string) => boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [role, setRole] = useState<AdminRole | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const handleAuthFailure = useCallback(() => {
    setTokenState(null);
    setRole(null);
    setPermissions([]);
  }, []);

  useEffect(() => {
    initAuthFailureHandler(handleAuthFailure);
  }, [handleAuthFailure]);

  const hasPermission = useCallback(
    (permission: string) => {
      if (role === 'SUPER_ADMIN') return true;
      return permissions.includes(permission);
    },
    [role, permissions],
  );

  const fetchRole = useCallback(async () => {
    const me = await apiFetch<{
      userId: string;
      email: string;
      role: AdminRole;
      permissions?: string[];
    }>('/admin/me');
    setRole(me.role);
    setEmail(me.email);
    setPermissions(me.permissions ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      if (!sessionStorage.getItem('admin_hasSession')) {
        setIsLoading(false);
        return;
      }
      try {
        const res = await fetch('/admin/auth/refresh', { method: 'POST', credentials: 'include' });
        if (res.ok) {
          const { accessToken } = (await res.json()) as { accessToken: string };
          setToken(accessToken);
          setTokenState(accessToken);
          await fetchRole();
        } else {
          sessionStorage.removeItem('admin_hasSession');
        }
      } catch {
        // not logged in
      } finally {
        setIsLoading(false);
      }
    })();
  }, [fetchRole]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { accessToken } = await apiFetch<{ accessToken: string }>('/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setToken(accessToken);
      try {
        await fetchRole();
        setTokenState(accessToken);
        sessionStorage.setItem('admin_hasSession', '1');
      } catch (err) {
        setToken(null);
        throw err;
      }
    },
    [fetchRole],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch('/admin/auth/logout', { method: 'POST' });
    } catch {
      // best-effort
    }
    sessionStorage.removeItem('admin_hasSession');
    setToken(null);
    setTokenState(null);
    setRole(null);
    setEmail(null);
    setPermissions([]);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        token,
        role,
        email,
        permissions,
        hasPermission,
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
