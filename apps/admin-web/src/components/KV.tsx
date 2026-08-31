interface KVProps {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
}

export function KV({ k, v, mono }: KVProps) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={mono ? 'mono' : ''}>{v}</dd>
    </>
  );
}
