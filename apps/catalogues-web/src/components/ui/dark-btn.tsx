'use client';
import { C } from '../tokens';

export function DarkBtn({
  children,
  onClick,
  style = {},
  disabled = false,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      className="btn-hover-opacity"
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '10px 20px',
        borderRadius: 8,
        border: 'none',
        fontFamily: 'inherit',
        fontWeight: 600,
        fontSize: 14,
        background: C.dark,
        color: C.onDark,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
