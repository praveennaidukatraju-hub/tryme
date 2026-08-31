interface NameAvatarProps {
  name: string;
  email?: string;
  size?: number;
}

export function NameAvatar({ name, email, size = 32 }: NameAvatarProps) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

  let h = 0;
  for (const c of name) {
    h = (h * 31 + c.charCodeAt(0)) % 360;
  }

  return (
    <span
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: `oklch(0.82 0.06 ${h})`,
        color: `oklch(0.32 0.10 ${h})`,
        fontSize: size * 0.4,
        fontWeight: 500,
        flexShrink: 0,
      }}
      title={email}
    >
      {initials}
    </span>
  );
}
