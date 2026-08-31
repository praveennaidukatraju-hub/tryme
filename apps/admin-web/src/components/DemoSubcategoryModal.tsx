import { useEffect, useState } from 'react';
import { EditDrawer } from './EditDrawer';
import { SearchableSelect } from './SearchableSelect';

export interface DemoSubcategoryEditData {
  id: string;
  name: string;
  garmentSubcategoryId: string;
}

interface DemoSubcategoryModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (name: string, garmentSubcategoryId: string) => void;
  initialData?: DemoSubcategoryEditData;
  category: string;
  garmentTypes: { id: string; label: string }[];
  isSaving?: boolean;
}

export function DemoSubcategoryModal({
  open,
  onClose,
  onSave,
  initialData,
  category,
  garmentTypes,
  isSaving = false,
}: DemoSubcategoryModalProps) {
  const [name, setName] = useState('');
  const [garmentSubcategoryId, setGarmentSubcategoryId] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initialData?.name ?? '');
    setGarmentSubcategoryId(initialData?.garmentSubcategoryId ?? garmentTypes[0]?.id ?? '');
  }, [open, initialData, garmentTypes]);

  if (!open) return null;

  const handleSave = () => {
    if (name.trim() && garmentSubcategoryId && !isSaving) {
      onSave(name.trim(), garmentSubcategoryId);
    }
  };

  return (
    <EditDrawer
      onClose={onClose}
      title={initialData ? 'Edit subcategory' : 'Add subcategory'}
      width="min(480px, calc(100vw - 40px))"
      saving={isSaving}
      onSave={handleSave}
      saveLabel={isSaving ? 'Saving…' : 'Save'}
      saveDisabled={isSaving || !name.trim() || !garmentSubcategoryId}
    >
      <div className="field">
        <label>Category</label>
        <input
          className="input"
          value={category}
          disabled
          style={{ textTransform: 'capitalize' }}
        />
      </div>
      <div className="field">
        <label>Name</label>
        <input
          className="input"
          required
          maxLength={160}
          value={name}
          disabled={isSaving}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Summer Collection"
        />
      </div>
      <div className="field">
        <label>Garment type</label>
        <SearchableSelect
          options={garmentTypes}
          value={garmentSubcategoryId}
          disabled={isSaving}
          placeholder="— search garment type —"
          onChange={setGarmentSubcategoryId}
        />
      </div>
    </EditDrawer>
  );
}
