import { Icon } from './Icons';

interface ToastItem {
  id: number;
  kind?: string;
  title: string;
  body?: string;
}

interface ToastStackProps {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}

export function ToastStack({ items, onDismiss }: ToastStackProps) {
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind === 'error' ? 'error' : t.kind === 'warning' ? 'warning' : ''}`}
        >
          <div className="ic">
            {t.kind === 'error' || t.kind === 'warning' ? <Icon.Alert /> : <Icon.Check />}
          </div>
          <div className="body">
            <b>{t.title}</b>
            {t.body && <p>{t.body}</p>}
          </div>
          <button className="close" onClick={() => onDismiss(t.id)}>
            <Icon.Close />
          </button>
        </div>
      ))}
    </div>
  );
}
