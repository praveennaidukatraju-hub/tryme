import { useEffect, useState } from 'react';
import { EditDrawer } from './EditDrawer';

export interface DemoSetEditData {
  id: string;
  name: string;
  description: string | null;
}

interface DemoSetModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (name: string, description: string) => void;
  initialData?: DemoSetEditData;
  isSaving?: boolean;
}

export function DemoSetModal({
  open,
  onClose,
  onSave,
  initialData,
  isSaving = false,
}: DemoSetModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initialData?.name ?? '');
    setDescription(initialData?.description ?? '');
  }, [open, initialData]);

  if (!open) return null;

  const handleSave = () => {
    if (name.trim() && !isSaving) onSave(name.trim(), description.trim());
  };

  return (
    <EditDrawer
      onClose={onClose}
      title={initialData ? 'Edit demo set' : 'Add demo set'}
      width="min(480px, calc(100vw - 40px))"
      saving={isSaving}
      onSave={handleSave}
      saveLabel={isSaving ? 'Saving…' : 'Save'}
      saveDisabled={isSaving || !name.trim()}
    >
      <div className="field">
        <label>Name</label>
        <input
          className="input"
          required
          maxLength={160}
          value={name}
          disabled={isSaving}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Summer Demo Set"
        />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea
          className="input"
          maxLength={500}
          value={description}
          disabled={isSaving}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional"
        />
      </div>
    </EditDrawer>
  );
}
