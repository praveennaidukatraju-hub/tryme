'use client';
import { C, grad } from '../tokens';

export function GradBtn({
  children,
  onClick,
  style = {},
  outline = false,
  disabled = false,
  type = 'button',
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
  outline?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      className={className ? `btn-hover-opacity ${className}` : 'btn-hover-opacity'}
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        height: 38,
        padding: '0 20px',
        boxSizing: 'border-box',
        borderRadius: 8,
        fontFamily: 'inherit',
        fontWeight: 600,
        fontSize: 14,
        whiteSpace: 'nowrap',
        background: outline ? C.white : grad,
        color: outline ? C.text : C.white,
        border: outline ? `1px solid ${C.border2}` : 'none',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
