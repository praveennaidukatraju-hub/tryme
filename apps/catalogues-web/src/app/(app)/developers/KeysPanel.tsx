'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiKey } from '@tryme/types';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { TrashIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { GradBtn } from '@/components/ui/grad-btn';
import { type CreatedApiKey, createApiKey, listApiKeys, revokeApiKey } from './api';

// "not a merchant account" / "merchant account inactive" — thrown by requireMerchant
// (apps/api/src/plugins/portal-auth.ts) when the logged-in user has no merchants row.
function isMerchantGateError(err: unknown): boolean {
  return err instanceof Error && /merchant account/i.test(err.message);
}

const fmtDate = (s: string | null) =>
  s
    ? new Date(s).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Never';

function RevealedKeyBox({ created, onDismiss }: { created: CreatedApiKey; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — the key is still
      // visible for manual selection, so this is a soft failure.
    }
  }

  return (
    <div
      style={{
        border: `1px solid ${C.pink}`,
        background: 'rgba(245, 92, 122, 0.05)',
        borderRadius: 12,
        padding: 20,
        marginBottom: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: C.pink }}>
        Copy this key now — you will not be able to see it again.
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: C.white,
          border: `1px solid ${C.border2}`,
          borderRadius: 8,
          padding: '10px 14px',
        }}
      >
        <code
          style={{
            flex: 1,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 12.5,
            color: C.text,
            wordBreak: 'break-all',
          }}
        >
          {created.key}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            borderRadius: 8,
            border: `1px solid ${C.border2}`,
            background: C.card,
            color: copied ? C.mint : C.text,
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: C.dark,
            color: C.white,
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          I've saved it — dismiss
        </button>
      </div>
    </div>
  );
}

export function KeysPanel() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [keyKind, setKeyKind] = useState<'wordpress_widget' | undefined>(undefined);
  const [label, setLabel] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  // Holds the plaintext key ONLY between creation and dismissal. Never
  // persisted, never logged, cleared the moment the user dismisses it.
  const [revealedKey, setRevealedKey] = useState<CreatedApiKey | null>(null);
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKey | null>(null);

  const keysQuery = useQuery({ queryKey: ['dev-api-keys'], queryFn: listApiKeys });
  const keys = keysQuery.data?.keys ?? [];
  const merchantGated = isMerchantGateError(keysQuery.error);

  const createMutation = useMutation({
    mutationFn: (vars: { label: string; kind?: 'wordpress_widget'; siteUrl?: string }) =>
      createApiKey(vars.label, vars.kind, vars.siteUrl),
    onSuccess: (created) => {
      setRevealedKey(created);
      setCreateOpen(false);
      setLabel('');
      setSiteUrl('');
      setKeyKind(undefined);
      void qc.invalidateQueries({ queryKey: ['dev-api-keys'] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => {
      setKeyToRevoke(null);
      void qc.invalidateQueries({ queryKey: ['dev-api-keys'] });
    },
  });

  if (merchantGated) {
    return (
      <div
        style={{
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: '48px 24px',
          textAlign: 'center',
          color: C.light,
          fontSize: 14,
        }}
      >
        This account isn't enabled as a merchant yet. Contact support to get API access activated.
      </div>
    );
  }

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: 0 }}>API Keys</h3>
          <p style={{ fontSize: 13, color: C.mid, margin: '4px 0 0' }}>
            Keys authenticate requests to the <code>/v1/dev/*</code> API.
          </p>
        </div>
        {!createOpen && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => {
                setKeyKind('wordpress_widget');
                setCreateOpen(true);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 14px',
                height: 38,
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                background: C.white,
                color: C.text,
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Plus size={15} /> Create WordPress Widget Key
            </button>
            <GradBtn
              onClick={() => {
                setKeyKind(undefined);
                setCreateOpen(true);
              }}
            >
              <Plus size={16} /> Create key
            </GradBtn>
          </div>
        )}
      </div>

      {revealedKey && (
        <RevealedKeyBox created={revealedKey} onDismiss={() => setRevealedKey(null)} />
      )}

      {createOpen && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            border: `1px solid ${C.border2}`,
            borderRadius: 10,
            padding: 16,
            marginBottom: 20,
            background: C.field,
            width: '100%',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="new-key-label" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
              {keyKind === 'wordpress_widget' ? 'WordPress Widget Key Label' : 'API Key Label'}
            </label>
            <p style={{ fontSize: 12, color: C.mid, margin: '0 0 4px' }}>
              {keyKind === 'wordpress_widget'
                ? 'Scoped specifically for the WordPress / WooCommerce plugin. Rate-limited for storefront usage.'
                : 'Full-access API key for server-side integrations.'}
            </p>
            <input
              id="new-key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={
                keyKind === 'wordpress_widget' ? 'e.g. My WooCommerce Store' : 'e.g. production key'
              }
              maxLength={64}
              style={{
                height: 40,
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                background: C.white,
                padding: '0 12px',
                fontFamily: 'inherit',
                fontSize: 13.5,
                color: C.text,
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
            {createMutation.isError && (
              <p style={{ fontSize: 12, color: C.pink, margin: '4px 0 0' }}>
                {(createMutation.error as Error).message}
              </p>
            )}
          </div>
          {keyKind === 'wordpress_widget' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label
                htmlFor="new-key-site-url"
                style={{ fontSize: 13, fontWeight: 600, color: C.text }}
              >
                Store URL
              </label>
              <p style={{ fontSize: 12, color: C.mid, margin: '0 0 4px' }}>
                The exact address shoppers use for your store. The try-on widget on this site is the
                only one allowed to use this key.
              </p>
              <input
                id="new-key-site-url"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="https://mystore.com"
                style={{
                  height: 40,
                  borderRadius: 8,
                  border: `1px solid ${C.border2}`,
                  background: C.white,
                  padding: '0 12px',
                  fontFamily: 'inherit',
                  fontSize: 13.5,
                  color: C.text,
                  outline: 'none',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}
          <div
            style={{
              display: 'flex',
              gap: 10,
              justifyContent: 'flex-end',
              alignItems: 'center',
            }}
          >
            <button
              type="button"
              onClick={() => {
                setCreateOpen(false);
                setLabel('');
                setSiteUrl('');
                setKeyKind(undefined);
                createMutation.reset();
              }}
              disabled={createMutation.isPending}
              style={{
                height: 38,
                padding: '0 18px',
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                background: C.white,
                color: C.text,
                fontFamily: 'inherit',
                fontSize: 13.5,
                fontWeight: 600,
                cursor: createMutation.isPending ? 'not-allowed' : 'pointer',
                boxSizing: 'border-box',
              }}
            >
              Cancel
            </button>
            <GradBtn
              onClick={() =>
                createMutation.mutate({
                  label: label.trim(),
                  kind: keyKind,
                  siteUrl: keyKind === 'wordpress_widget' ? siteUrl.trim() : undefined,
                })
              }
              disabled={
                createMutation.isPending ||
                !label.trim() ||
                (keyKind === 'wordpress_widget' && !siteUrl.trim())
              }
              style={{ height: 38, fontSize: 13.5, padding: '0 18px' }}
            >
              {createMutation.isPending
                ? 'Creating…'
                : keyKind === 'wordpress_widget'
                  ? 'Create Widget Key'
                  : 'Create Key'}
            </GradBtn>
          </div>
        </div>
      )}

      {keysQuery.isLoading ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: C.light, fontSize: 14 }}>
          Loading keys...
        </div>
      ) : keysQuery.isError && !merchantGated ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: C.pink, fontSize: 14 }}>
          {(keysQuery.error as Error).message}
        </div>
      ) : keys.length === 0 ? (
        <div
          style={{
            padding: '40px 0',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ color: C.pink, opacity: 0.8 }}>
            <KeyRound size={36} />
          </div>
          <p style={{ fontSize: 14, color: C.light, margin: 0 }}>
            No API keys yet. Create one to start calling the API.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto', width: '100%', borderRadius: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 600 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.2fr 1fr 1fr 1.1fr 1.1fr 0.6fr',
                padding: '10px 14px',
                borderBottom: `1px solid ${C.border}`,
                fontSize: 12,
                fontWeight: 600,
                color: C.mid,
                textTransform: 'uppercase',
                letterSpacing: '0.4px',
              }}
            >
              <span>Label</span>
              <span>Key</span>
              <span>Type</span>
              <span>Created</span>
              <span>Last used</span>
              <span />
            </div>
            {keys.map((k) => (
              <div
                key={k.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.2fr 1fr 1fr 1.1fr 1.1fr 0.6fr',
                  padding: '12px 14px',
                  borderBottom: `1px solid ${C.border}`,
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: C.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {k.label}
                  </span>
                  {k.allowedOrigin && (
                    <span
                      style={{
                        fontSize: 11.5,
                        color: C.mid,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {k.allowedOrigin}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    color: C.mid,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {k.keyPrefix}…
                </span>
                <span>
                  {k.scope === 'widget' || k.integration === 'wordpress' ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        fontSize: 11.5,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 6,
                        background: 'rgba(99, 102, 241, 0.1)',
                        color: '#6366f1',
                      }}
                    >
                      WP Widget
                    </span>
                  ) : (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        fontSize: 11.5,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 6,
                        background: 'rgba(100, 116, 139, 0.1)',
                        color: C.mid,
                      }}
                    >
                      Full Access
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    color: C.mid,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {fmtDate(k.createdAt)}
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    color: C.mid,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {fmtDate(k.lastUsedAt)}
                </span>
                <button
                  type="button"
                  onClick={() => setKeyToRevoke(k)}
                  title="Revoke key"
                  style={{
                    justifySelf: 'end',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: `1px solid ${C.border2}`,
                    background: C.white,
                    color: C.pink,
                    fontFamily: 'inherit',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  <TrashIcon /> Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!keyToRevoke}
        title="Revoke API key"
        message={`Are you sure you want to revoke "${keyToRevoke?.label}"? Any integration using it will stop working immediately.`}
        confirmLabel="Revoke"
        danger
        busy={revokeMutation.isPending}
        error={revokeMutation.isError ? (revokeMutation.error as Error).message : null}
        onConfirm={() => {
          if (keyToRevoke) revokeMutation.mutate(keyToRevoke.id);
        }}
        onCancel={() => {
          setKeyToRevoke(null);
          revokeMutation.reset();
        }}
      />
    </div>
  );
}
