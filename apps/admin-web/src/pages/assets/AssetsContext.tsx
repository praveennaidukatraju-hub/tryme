import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../lib/data';
import type {
  CatalogItem,
  GarmentType,
  GenderSlug,
  ModelBackground,
  ModelFace,
  WorkflowOption,
} from '../../types';

export type AssetTab =
  | 'garment-types'
  | 'faces'
  | 'backgrounds'
  | 'lower'
  | 'shoe'
  | 'pose-assets'
  | 'catalogue-templates'
  | 'saree-styles'
  | 'sample-videos';
export type GenderFilter = 'all' | GenderSlug;

const VALID_TABS: AssetTab[] = [
  'garment-types',
  'faces',
  'backgrounds',
  'lower',
  'shoe',
  'pose-assets',
  'catalogue-templates',
  'saree-styles',
  'sample-videos',
];

export type Toast = (t: { kind?: 'error'; title: string; body?: string }) => void;

interface AssetsContextValue {
  activeTab: AssetTab;
  setActiveTab: (tab: AssetTab) => void;
  genderFilter: GenderFilter;
  setGenderFilter: (f: GenderFilter) => void;
  faces: ModelFace[];
  setFaces: React.Dispatch<React.SetStateAction<ModelFace[]>>;
  loadFaces: () => void;
  allBackgrounds: ModelBackground[];
  setAllBackgrounds: React.Dispatch<React.SetStateAction<ModelBackground[]>>;
  loadAllBackgrounds: () => void;
  garmentTypes: GarmentType[];
  setGarmentTypes: React.Dispatch<React.SetStateAction<GarmentType[]>>;
  loadGarmentTypes: () => Promise<void>;
  workflows: WorkflowOption[];
  setWorkflows: React.Dispatch<React.SetStateAction<WorkflowOption[]>>;
  catalogItems: CatalogItem[];
  setCatalogItems: React.Dispatch<React.SetStateAction<CatalogItem[]>>;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  previewUrl: string | null;
  setPreviewUrl: React.Dispatch<React.SetStateAction<string | null>>;
  toast: Toast;
}

const AssetsContext = createContext<AssetsContextValue | null>(null);

export function useAssetsContext() {
  const ctx = useContext(AssetsContext);
  if (!ctx) throw new Error('useAssetsContext must be used inside AssetsProvider');
  return ctx;
}

export function AssetsProvider({ toast, children }: { toast: Toast; children: React.ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') as AssetTab | null;
  const activeTab: AssetTab = rawTab && VALID_TABS.includes(rawTab) ? rawTab : 'garment-types';
  const setActiveTab = useCallback(
    (tab: AssetTab) => setSearchParams({ tab }, { replace: true }),
    [setSearchParams],
  );

  const [genderFilter, setGenderFilter] = useState<GenderFilter>('all');
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [faces, setFaces] = useState<ModelFace[]>([]);
  const [allBackgrounds, setAllBackgrounds] = useState<ModelBackground[]>([]);
  const [garmentTypes, setGarmentTypes] = useState<GarmentType[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);

  const loadFaces = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ModelFace[] }>('/admin/assets/faces');
      setFaces(res.items);
    } catch (_e) {
      setFaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAllBackgrounds = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ModelBackground[] }>('/admin/assets/backgrounds');
      setAllBackgrounds(res.items);
    } catch (_e) {
      setAllBackgrounds([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGarmentTypes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: GarmentType[] }>('/admin/assets/garment-types');
      setGarmentTypes(res.items);
    } catch (_e) {
      setGarmentTypes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Preload shared data on mount so filters/dropdowns are populated immediately
  useEffect(() => {
    apiFetch<{ items: ModelFace[] }>('/admin/assets/faces')
      .then((r) => setFaces(r.items))
      .catch(() => setFaces([]));
    apiFetch<{ items: ModelBackground[] }>('/admin/assets/backgrounds')
      .then((r) => setAllBackgrounds(r.items))
      .catch(() => setAllBackgrounds([]));
    apiFetch<CatalogItem[]>('/admin/catalog/items')
      .then((items) => setCatalogItems(items))
      .catch(() => {});
    apiFetch<{ items: GarmentType[] }>('/admin/assets/garment-types')
      .then((r) => setGarmentTypes(r.items))
      .catch(() => setGarmentTypes([]));
  }, []);

  const value = useMemo<AssetsContextValue>(
    () => ({
      activeTab,
      setActiveTab,
      genderFilter,
      setGenderFilter,
      faces,
      setFaces,
      loadFaces,
      allBackgrounds,
      setAllBackgrounds,
      loadAllBackgrounds,
      garmentTypes,
      setGarmentTypes,
      loadGarmentTypes,
      workflows,
      setWorkflows,
      catalogItems,
      setCatalogItems,
      loading,
      setLoading,
      previewUrl,
      setPreviewUrl,
      toast,
    }),
    [
      activeTab,
      setActiveTab,
      genderFilter,
      faces,
      loadFaces,
      allBackgrounds,
      loadAllBackgrounds,
      garmentTypes,
      loadGarmentTypes,
      workflows,
      catalogItems,
      loading,
      previewUrl,
      toast,
    ],
  );

  return <AssetsContext.Provider value={value}>{children}</AssetsContext.Provider>;
}
