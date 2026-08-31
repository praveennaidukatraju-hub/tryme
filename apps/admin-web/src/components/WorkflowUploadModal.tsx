import { useRef, useState } from 'react';
import { apiErrorMessage, apiFetch } from '../lib/data';
import type { WorkflowOption } from '../types';
import { EditDrawer } from './EditDrawer';
import { Icon } from './Icons';
import { SearchableSelect } from './SearchableSelect';

interface ParsedNode {
  id: string;
  class_type: string;
  title: string;
  category: 'image' | 'prompt' | 'latent' | 'other';
}

interface DetectedMappings {
  faceNodeId?: string;
  poseNodeId?: string;
  bgNodeId?: string;
  upperNodeIds: string[];
  lowerNodeId?: string;
  shoeNodeId?: string;
  thirdNodeId?: string;
  sizeNodeIds: string[];
  positivePromptNode?: string;
  negativePromptNode?: string;
  latentSizeNodeIds: string[];
  outputSizeNodeIds: string[];
  resultNodeId?: string;
}

interface ParseResult {
  detected: DetectedMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
  allLatentNodes: ParsedNode[];
}

interface Props {
  onCreated: (wf: WorkflowOption) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

function NodeBadge({ node }: { node: ParsedNode }) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 12,
        fontFamily: 'monospace',
        background: 'var(--accent-soft, #eff6ff)',
        color: 'var(--accent, #2563eb)',
        border: '1px solid var(--accent-border, #bfdbfe)',
        borderRadius: 4,
        padding: '2px 8px',
      }}
    >
      [{node.id}] {node.title}
    </span>
  );
}

function NodeSelect({
  label,
  nodes,
  value,
  onChange,
  required,
  disabled,
  hint,
}: {
  label: string;
  nodes: ParsedNode[];
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="field" style={{ margin: 0 }}>
      <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        {label}
        {required && <span style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      {hint && (
        <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
          {hint}
        </span>
      )}
      <SearchableSelect
        options={nodes.map((n) => ({ id: n.id, label: `[${n.id}] ${n.title} (${n.class_type})` }))}
        value={value}
        onChange={onChange}
        disabled={disabled}
        emptyLabel="— select node —"
        placeholder="— search node —"
      />
    </div>
  );
}

const CONVENTION_DOCS = `Required _meta.title values in ComfyUI:
  face            → face LoadImage node
  pose            → pose/template LoadImage node
  background      → background LoadImage node
  upper_garment   → upper garment LoadImage node (multiple: upper_garment_1, upper_garment_2 …)
  positive_prompt → positive TextEncode node
  negative_prompt → negative TextEncode node
Optional:
  lower_garment   → lower garment LoadImage node
  shoes           → shoes LoadImage node
  size            → EmptyLatentImage node for dynamic aspect ratio`;

export function WorkflowUploadModal({ onCreated, onClose, toast }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [showConvention, setShowConvention] = useState(false);

  const [workflowType, setWorkflowType] = useState<
    'regular' | 'tryon' | 'saree_step1' | 'saree_step1_two_input' | 'two_stage'
  >('regular');
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');

  // Regular workflow mappings — initialised from auto-detection, overridable by admin
  const [faceNodeId, setFaceNodeId] = useState('');
  const [poseNodeId, setPoseNodeId] = useState('');
  const [bgNodeId, setBgNodeId] = useState('');
  const [upperNodeIds, setUpperNodeIds] = useState<string[]>(['']);
  const [lowerNodeId, setLowerNodeId] = useState('');
  const [shoeNodeId, setShoeNodeId] = useState('');
  const [thirdNodeId, setThirdNodeId] = useState('');
  const [sizeNodeIds, setSizeNodeIds] = useState<string[]>([]);
  const [positivePromptNode, setPositivePromptNode] = useState('');
  const [negativePromptNode, setNegativePromptNode] = useState('');

  // Dual-size-group + result-node — auto-detected only, no manual UI exposure
  const [latentSizeNodeIds, setLatentSizeNodeIds] = useState<string[]>([]);
  const [outputSizeNodeIds, setOutputSizeNodeIds] = useState<string[]>([]);
  const [resultNodeId, setResultNodeId] = useState('');

  // Tryon workflow node IDs + prompts (auto-detected, overridable)
  const [tryonPersonNodeId, setTryonPersonNodeId] = useState('');
  const [tryonGarmentNodeId, setTryonGarmentNodeId] = useState('');
  const [tryonGarmentNodeId2, setTryonGarmentNodeId2] = useState('');
  const [tryonOutputNodeId, setTryonOutputNodeId] = useState('');
  const [tryonPositivePrompt, setTryonPositivePrompt] = useState('');
  const [tryonNegativePrompt, setTryonNegativePrompt] = useState('');

  // Two-stage workflow node IDs (auto-detected via graph structure, not titles).
  // faceNodeId/poseNodeId/bgNodeId above are reused; stage 2's prompt pair reuses
  // positivePromptNode/negativePromptNode above too (same "the patched prompt" role
  // as regular/tryon) — only stage 1 needs its own dedicated fields.
  const [twoStageGarmentNodeId, setTwoStageGarmentNodeId] = useState('');
  const [stage1PositivePromptNode, setStage1PositivePromptNode] = useState('');
  const [stage1NegativePromptNode, setStage1NegativePromptNode] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setJsonFile(f);
    setParsed(null);
    setError(null);
    if (f) {
      const name = f.name
        .replace(/\.json$/i, '')
        .replace(/[^a-z0-9]+/gi, '_')
        .toLowerCase();
      setSlug(name);
      setLabel(f.name.replace(/\.json$/i, ''));
    }
  };

  const handleParse = async () => {
    if (!jsonFile) return;
    setParsing(true);
    setError(null);
    try {
      const text = await jsonFile.text();
      let jsonContent: Record<string, unknown>;
      try {
        jsonContent = JSON.parse(text) as Record<string, unknown>;
      } catch {
        setError('Invalid JSON — file could not be parsed');
        return;
      }

      const result = await apiFetch<ParseResult & { detected: Record<string, unknown> }>(
        '/admin/workflows/parse',
        { method: 'POST', body: JSON.stringify({ jsonContent, workflowType }) },
      );
      setParsed(result);

      if (workflowType === 'tryon' || workflowType === 'saree_step1') {
        const d = result.detected as {
          personNodeId?: string;
          garmentNodeId?: string;
          outputNodeId?: string;
          positivePromptNode?: string;
          negativePromptNode?: string;
          defaultPositivePrompt?: string;
          defaultNegativePrompt?: string;
        };
        setTryonPersonNodeId(d.personNodeId ?? '');
        setTryonGarmentNodeId(d.garmentNodeId ?? '');
        setTryonGarmentNodeId2('');
        setTryonOutputNodeId(d.outputNodeId ?? '');
        setPositivePromptNode(d.positivePromptNode ?? '');
        setNegativePromptNode(d.negativePromptNode ?? '');
        setTryonPositivePrompt(d.defaultPositivePrompt ?? '');
        setTryonNegativePrompt(d.defaultNegativePrompt ?? '');
        return;
      }

      if (workflowType === 'saree_step1_two_input') {
        const d = result.detected as {
          personNodeId?: string;
          bodyNodeId?: string;
          palluNodeId?: string;
          outputNodeId?: string;
          positivePromptNode?: string;
          negativePromptNode?: string;
          defaultPositivePrompt?: string;
          defaultNegativePrompt?: string;
        };
        setTryonPersonNodeId(d.personNodeId ?? '');
        setTryonGarmentNodeId(d.bodyNodeId ?? '');
        setTryonGarmentNodeId2(d.palluNodeId ?? '');
        setTryonOutputNodeId(d.outputNodeId ?? '');
        setPositivePromptNode(d.positivePromptNode ?? '');
        setNegativePromptNode(d.negativePromptNode ?? '');
        setTryonPositivePrompt(d.defaultPositivePrompt ?? '');
        setTryonNegativePrompt(d.defaultNegativePrompt ?? '');
        return;
      }

      if (workflowType === 'two_stage') {
        const d = result.detected as {
          faceNodeId?: string;
          poseNodeId?: string;
          bgNodeId?: string;
          garmentNodeId?: string;
          stage1PositivePromptNode?: string;
          stage1NegativePromptNode?: string;
          stage2PositivePromptNode?: string;
          stage2NegativePromptNode?: string;
          sizeNodeIds?: string[];
        };
        setFaceNodeId(d.faceNodeId ?? '');
        setPoseNodeId(d.poseNodeId ?? '');
        setBgNodeId(d.bgNodeId ?? '');
        setTwoStageGarmentNodeId(d.garmentNodeId ?? '');
        setStage1PositivePromptNode(d.stage1PositivePromptNode ?? '');
        setStage1NegativePromptNode(d.stage1NegativePromptNode ?? '');
        setPositivePromptNode(d.stage2PositivePromptNode ?? '');
        setNegativePromptNode(d.stage2NegativePromptNode ?? '');
        setSizeNodeIds(d.sizeNodeIds ?? []);
        return;
      }

      const d = result.detected as DetectedMappings;
      setFaceNodeId(d.faceNodeId ?? '');
      setPoseNodeId(d.poseNodeId ?? '');
      setBgNodeId(d.bgNodeId ?? '');
      setUpperNodeIds(d.upperNodeIds.length > 0 ? d.upperNodeIds : ['']);
      setLowerNodeId(d.lowerNodeId ?? '');
      setShoeNodeId(d.shoeNodeId ?? '');
      setThirdNodeId(d.thirdNodeId ?? '');
      setSizeNodeIds(d.sizeNodeIds ?? []);
      setPositivePromptNode(d.positivePromptNode ?? '');
      setNegativePromptNode(d.negativePromptNode ?? '');
      setLatentSizeNodeIds(d.latentSizeNodeIds ?? []);
      setOutputSizeNodeIds(d.outputSizeNodeIds ?? []);
      setResultNodeId(d.resultNodeId ?? '');
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to parse workflow'));
    } finally {
      setParsing(false);
    }
  };

  const handleSubmit = async () => {
    if (!jsonFile) return;
    if (!slug.trim() || !label.trim()) {
      setError('Slug and label are required');
      return;
    }

    if (workflowType === 'tryon' || workflowType === 'saree_step1') {
      if (!tryonGarmentNodeId.trim() || !tryonOutputNodeId.trim()) {
        setError('Garment and output node IDs are required');
        return;
      }
      if (!positivePromptNode || !negativePromptNode) {
        setError('Positive and negative prompt nodes are required');
        return;
      }
    } else if (workflowType === 'saree_step1_two_input') {
      if (!tryonGarmentNodeId.trim() || !tryonGarmentNodeId2.trim() || !tryonOutputNodeId.trim()) {
        setError('Body, pallu, and output node IDs are required');
        return;
      }
      if (!positivePromptNode || !negativePromptNode) {
        setError('Positive and negative prompt nodes are required');
        return;
      }
    } else if (workflowType === 'two_stage') {
      if (!faceNodeId || !poseNodeId || !bgNodeId || !twoStageGarmentNodeId) {
        setError('Face, pose, background, and garment nodes are all required');
        return;
      }
      if (!stage1PositivePromptNode || !stage1NegativePromptNode) {
        setError('Stage 1 positive and negative prompt nodes are required');
        return;
      }
      if (!positivePromptNode || !negativePromptNode) {
        setError('Stage 2 positive and negative prompt nodes are required');
        return;
      }
    } else {
      if (!parsed) return;
      if (!poseNodeId || !positivePromptNode) {
        setError('Pose and positive prompt nodes are required');
        return;
      }
      if (faceNodeId && !negativePromptNode) {
        setError('Negative prompt node is required when a face node is set');
        return;
      }
      const validUpperIds = upperNodeIds.filter(Boolean);
      if (validUpperIds.length === 0 && !lowerNodeId) {
        setError(
          'At least one garment role is required - set an upper garment node or a lower garment node',
        );
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const text = await jsonFile.text();
      const jsonContent = JSON.parse(text) as Record<string, unknown>;

      let payload: Record<string, unknown>;
      if (
        workflowType === 'tryon' ||
        workflowType === 'saree_step1' ||
        workflowType === 'saree_step1_two_input'
      ) {
        payload = {
          slug: slug.trim(),
          label: label.trim(),
          jsonContent,
          workflowType,
          tryonPersonNodeId: tryonPersonNodeId.trim() || undefined,
          tryonGarmentNodeId: tryonGarmentNodeId.trim(),
          ...(workflowType === 'saree_step1_two_input'
            ? { tryonGarmentNodeId2: tryonGarmentNodeId2.trim() }
            : {}),
          tryonOutputNodeId: tryonOutputNodeId.trim(),
          facePhasePromptNode: negativePromptNode,
          garmentPhasePromptNode: positivePromptNode,
        };
      } else if (workflowType === 'two_stage') {
        payload = {
          slug: slug.trim(),
          label: label.trim(),
          jsonContent,
          workflowType: 'two_stage',
          faceNodeId,
          poseNodeId,
          bgNodeId,
          upperNodeIds: [twoStageGarmentNodeId],
          sizeNodeIds: sizeNodeIds.filter(Boolean),
          // positive → garmentPhasePromptNode, negative → facePhasePromptNode — same
          // "stage 2 / the patched prompt" convention regular and tryon both use.
          facePhasePromptNode: negativePromptNode,
          garmentPhasePromptNode: positivePromptNode,
          stage1PositivePromptNode,
          stage1NegativePromptNode,
        };
      } else {
        const validUpperIds = upperNodeIds.filter(Boolean);
        payload = {
          slug: slug.trim(),
          label: label.trim(),
          jsonContent,
          workflowType: 'regular',
          faceNodeId: faceNodeId || undefined,
          poseNodeId,
          bgNodeId: bgNodeId || undefined,
          upperNodeIds: validUpperIds,
          lowerNodeId: lowerNodeId || undefined,
          shoeNodeId: shoeNodeId || undefined,
          thirdNodeId: thirdNodeId || undefined,
          sizeNodeIds: sizeNodeIds.filter(Boolean),
          ...(latentSizeNodeIds.length === 2 ? { latentSizeNodeIds } : {}),
          ...(outputSizeNodeIds.length === 2 ? { outputSizeNodeIds } : {}),
          ...(resultNodeId ? { resultNodeId } : {}),
          // positive → garmentPhasePromptNode (DB field name)
          // negative → facePhasePromptNode    (DB field name)
          facePhasePromptNode: negativePromptNode || undefined,
          garmentPhasePromptNode: positivePromptNode,
        };
      }

      const created = await apiFetch<WorkflowOption>('/admin/workflows', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast({ title: `Workflow "${created.label}" created` });
      onCreated(created);
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to create workflow'));
    } finally {
      setSaving(false);
    }
  };

  const nodes = parsed
    ? {
        image: parsed.allImageNodes,
        prompt: parsed.allPromptNodes,
        latent: parsed.allLatentNodes ?? [],
      }
    : null;

  // Count of auto-filled fields, for the "Auto-detected" summary box below —
  // purely informational, not a required/optional judgment (see requiredMissing).
  const detectedCount =
    parsed && workflowType === 'regular'
      ? [
          (parsed.detected as DetectedMappings).faceNodeId,
          (parsed.detected as DetectedMappings).poseNodeId,
          (parsed.detected as DetectedMappings).bgNodeId,
          ((parsed.detected as DetectedMappings).upperNodeIds?.length ?? 0) > 0,
          (parsed.detected as DetectedMappings).positivePromptNode,
          (parsed.detected as DetectedMappings).negativePromptNode,
        ].filter(Boolean).length
      : 0;

  // What canSubmit (below) actually treats as required for a regular workflow:
  // pose + positive prompt always; a garment role (upper OR lower, not
  // specifically upper); negative prompt only if a face node is present. face
  // and background are otherwise fully optional. Evaluated against the raw
  // auto-detect result, not the live (possibly hand-edited) form state.
  const requiredMissing =
    parsed && workflowType === 'regular'
      ? [
          !(parsed.detected as DetectedMappings).poseNodeId && 'pose',
          !(parsed.detected as DetectedMappings).positivePromptNode && 'positive prompt',
          ((parsed.detected as DetectedMappings).upperNodeIds?.length ?? 0) === 0 &&
            !(parsed.detected as DetectedMappings).lowerNodeId &&
            'a garment role (upper or lower)',
          (parsed.detected as DetectedMappings).faceNodeId &&
            !(parsed.detected as DetectedMappings).negativePromptNode &&
            'negative prompt (a face node was detected)',
        ].filter((x): x is string => typeof x === 'string')
      : [];

  const canSubmit =
    !saving &&
    jsonFile &&
    slug.trim() &&
    label.trim() &&
    (workflowType === 'tryon' || workflowType === 'saree_step1'
      ? parsed &&
        tryonGarmentNodeId &&
        tryonOutputNodeId &&
        positivePromptNode &&
        negativePromptNode
      : workflowType === 'saree_step1_two_input'
        ? parsed &&
          tryonGarmentNodeId &&
          tryonGarmentNodeId2 &&
          tryonOutputNodeId &&
          positivePromptNode &&
          negativePromptNode
        : workflowType === 'two_stage'
          ? parsed &&
            faceNodeId &&
            poseNodeId &&
            bgNodeId &&
            twoStageGarmentNodeId &&
            stage1PositivePromptNode &&
            stage1NegativePromptNode &&
            positivePromptNode &&
            negativePromptNode
          : parsed &&
            poseNodeId &&
            positivePromptNode &&
            (!faceNodeId || negativePromptNode) &&
            (upperNodeIds.filter(Boolean).length > 0 || lowerNodeId));

  return (
    <EditDrawer
      onClose={onClose}
      title="Upload workflow"
      width="min(960px, calc(100vw - 40px))"
      saving={saving || parsing}
      onSave={() => void handleSubmit()}
      saveLabel="Create workflow"
      saveDisabled={!canSubmit}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Workflow type selector */}
        <div style={{ display: 'flex', gap: 8 }}>
          {(['regular', 'tryon', 'saree_step1', 'saree_step1_two_input', 'two_stage'] as const).map(
            (t) => (
              <button
                key={t}
                className={`btn sm ${workflowType === t ? 'primary' : 'ghost'}`}
                disabled={saving}
                onClick={() => {
                  setWorkflowType(t);
                  setError(null);
                }}
                style={{ textTransform: 'capitalize' }}
              >
                {t === 'tryon'
                  ? 'Tryon (person + garment)'
                  : t === 'saree_step1'
                    ? 'Saree Step 1 (mannequin)'
                    : t === 'saree_step1_two_input'
                      ? 'Saree Step 1 (body + pallu)'
                      : t === 'two_stage'
                        ? 'Two-Stage (build + dress)'
                        : 'Catalogue workflows (pose-based)'}
              </button>
            ),
          )}
        </div>

        {workflowType === 'two_stage' && (
          <div
            style={{
              background: 'var(--subtle)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 12,
              color: 'var(--muted)',
            }}
          >
            Face/pose/background/garment are detected by title, same as catalogue workflows. The two
            prompt pairs are <strong>not</strong> title-based — with two KSamplers in the graph, a
            single "positive_prompt"/"negative_prompt" title is ambiguous. Stage 2's prompts are
            found by tracing back from the output node to the nearest KSampler; stage 1's are
            whatever KSampler is left over. Override below if it picks the wrong one.
          </div>
        )}

        {/* Convention reference — only for regular */}
        {workflowType === 'regular' && (
          <div
            style={{
              background: 'var(--subtle)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '8px 12px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                Node titles in the JSON must follow the <strong>naming convention</strong> for
                auto-detection.
              </span>
              <button
                className="btn sm ghost"
                style={{ fontSize: 11 }}
                onClick={() => setShowConvention((v) => !v)}
              >
                {showConvention ? 'Hide' : 'Show'} convention
              </button>
            </div>
            {showConvention && (
              <pre
                style={{
                  margin: '8px 0 0',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: 'var(--muted)',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.6,
                }}
              >
                {CONVENTION_DOCS}
              </pre>
            )}
          </div>
        )}

        {/* Step 1: JSON file */}
        <div className="field">
          <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block' }}>
            ComfyUI workflow JSON <span style={{ color: 'var(--danger)' }}>*</span>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <label
              htmlFor="wf-json-upload"
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                border: '1px dashed var(--border)',
                borderRadius: 'var(--r)',
                cursor: saving ? 'default' : 'pointer',
                background: 'var(--surface-2)',
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 22 22" fill="none" style={{ flexShrink: 0 }}>
                <path
                  d="M11 15V9M11 9L8 12M11 9l3 3"
                  stroke="var(--muted-2)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M4 16v1a2 2 0 002 2h10a2 2 0 002-2v-1"
                  stroke="var(--muted-2)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <span
                style={{
                  fontSize: 13,
                  color: jsonFile ? 'var(--ink)' : 'var(--muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {jsonFile ? jsonFile.name : 'Click to choose .json file'}
              </span>
              <input
                ref={fileRef}
                id="wf-json-upload"
                type="file"
                accept=".json,application/json"
                disabled={saving}
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </label>
            {(workflowType === 'regular' ||
              workflowType === 'tryon' ||
              workflowType === 'saree_step1' ||
              workflowType === 'saree_step1_two_input' ||
              workflowType === 'two_stage') && (
              <button
                className="btn sm primary"
                onClick={handleParse}
                disabled={!jsonFile || parsing || saving}
                style={{ flexShrink: 0 }}
              >
                {parsing ? 'Parsing…' : 'Parse'}
              </button>
            )}
          </div>
          {parsed && workflowType === 'regular' && (
            <span
              style={{
                fontSize: 12,
                color:
                  requiredMissing.length === 0
                    ? 'var(--success, #4caf50)'
                    : 'var(--warning, #f59e0b)',
                marginTop: 4,
                display: 'block',
              }}
            >
              {requiredMissing.length === 0
                ? '✓ All required nodes auto-detected'
                : `⚠ Missing: ${requiredMissing.join(', ')} — set manually below`}
            </span>
          )}
        </div>

        {(workflowType === 'tryon' ||
          workflowType === 'saree_step1' ||
          workflowType === 'saree_step1_two_input') &&
          parsed && (
            <>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="field">
                  <label>
                    Slug <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={slug}
                    disabled={saving}
                    onChange={(e) =>
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
                    }
                  />
                </div>
                <div className="field">
                  <label>
                    Label <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={label}
                    disabled={saving}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div className="field">
                  <label>
                    Person node (optional — leave blank if face is fixed inside the workflow)
                  </label>
                  <input
                    className="input"
                    value={tryonPersonNodeId}
                    disabled={saving}
                    onChange={(e) => setTryonPersonNodeId(e.target.value.trim())}
                  />
                </div>
                <div className="field">
                  <label>
                    {workflowType === 'saree_step1_two_input' ? 'Body node' : 'Garment node'}{' '}
                    <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={tryonGarmentNodeId}
                    disabled={saving}
                    onChange={(e) => setTryonGarmentNodeId(e.target.value.trim())}
                  />
                </div>
                {workflowType === 'saree_step1_two_input' && (
                  <div className="field">
                    <label>
                      Pallu node <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <input
                      className="input"
                      value={tryonGarmentNodeId2}
                      disabled={saving}
                      onChange={(e) => setTryonGarmentNodeId2(e.target.value.trim())}
                    />
                  </div>
                )}
                <div className="field">
                  <label>
                    Output node <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={tryonOutputNodeId}
                    disabled={saving}
                    onChange={(e) => setTryonOutputNodeId(e.target.value.trim())}
                  />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="field">
                  <label>
                    Positive prompt node <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={positivePromptNode}
                    disabled={saving}
                    onChange={(e) => setPositivePromptNode(e.target.value.trim())}
                  />
                </div>
                <div className="field">
                  <label>
                    Negative prompt node <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={negativePromptNode}
                    disabled={saving}
                    onChange={(e) => setNegativePromptNode(e.target.value.trim())}
                  />
                </div>
              </div>
              <div className="field">
                <label>Positive prompt (default, editable)</label>
                <textarea
                  className="input"
                  rows={3}
                  value={tryonPositivePrompt}
                  disabled={saving}
                  onChange={(e) => setTryonPositivePrompt(e.target.value)}
                  style={{ fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }}
                />
              </div>
              <div className="field">
                <label>Negative prompt (default, editable)</label>
                <textarea
                  className="input"
                  rows={3}
                  value={tryonNegativePrompt}
                  disabled={saving}
                  onChange={(e) => setTryonNegativePrompt(e.target.value)}
                  style={{ fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }}
                />
              </div>
            </>
          )}

        {parsed && nodes && workflowType === 'two_stage' && (
          <>
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="field">
                <label>
                  Slug <span style={{ color: 'var(--danger)' }}>*</span>
                </label>
                <input
                  className="input"
                  value={slug}
                  disabled={saving}
                  onChange={(e) =>
                    setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))
                  }
                />
              </div>
              <div className="field">
                <label>
                  Label <span style={{ color: 'var(--danger)' }}>*</span>
                </label>
                <input
                  className="input"
                  value={label}
                  disabled={saving}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              <strong>Image nodes</strong> — auto-detected from node titles. Override any if needed.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <NodeSelect
                label="Face node"
                nodes={nodes.image}
                value={faceNodeId}
                onChange={setFaceNodeId}
                required
                disabled={saving}
                hint='Title convention: "face"'
              />
              <NodeSelect
                label="Pose node"
                nodes={nodes.image}
                value={poseNodeId}
                onChange={setPoseNodeId}
                required
                disabled={saving}
                hint='Title convention: "pose"'
              />
              <NodeSelect
                label="Background node"
                nodes={nodes.image}
                value={bgNodeId}
                onChange={setBgNodeId}
                required
                disabled={saving}
                hint='Title convention: "background"'
              />
              <NodeSelect
                label="Garment node"
                nodes={nodes.image}
                value={twoStageGarmentNodeId}
                onChange={setTwoStageGarmentNodeId}
                required
                disabled={saving}
                hint='Title convention: "garment"'
              />
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              <strong>Stage 1 — build person</strong> (pose + face + background). Detected from
              whichever KSampler in the graph isn't stage 2 — not by title.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <NodeSelect
                label="Stage 1 positive prompt"
                nodes={nodes.prompt}
                value={stage1PositivePromptNode}
                onChange={setStage1PositivePromptNode}
                required
                disabled={saving}
              />
              <NodeSelect
                label="Stage 1 negative prompt"
                nodes={nodes.prompt}
                value={stage1NegativePromptNode}
                onChange={setStage1NegativePromptNode}
                required
                disabled={saving}
              />
            </div>

            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              <strong>Stage 2 — dress in garment</strong> (final image, the only prompt pair patched
              at runtime). Detected by tracing back from the output node to the nearest KSampler.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <NodeSelect
                label="Stage 2 positive prompt"
                nodes={nodes.prompt}
                value={positivePromptNode}
                onChange={setPositivePromptNode}
                required
                disabled={saving}
              />
              <NodeSelect
                label="Stage 2 negative prompt"
                nodes={nodes.prompt}
                value={negativePromptNode}
                onChange={setNegativePromptNode}
                required
                disabled={saving}
              />
            </div>

            {sizeNodeIds.length > 0 && (
              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  Size nodes (auto-detected)
                </label>
                <span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>
                  [{sizeNodeIds.join(', ')}]
                </span>
              </div>
            )}
          </>
        )}

        {parsed && nodes && workflowType === 'regular' && (
          <>
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

            {/* Metadata */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="field">
                <label>
                  Slug <span style={{ color: 'var(--danger)' }}>*</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>
                    (snake_case)
                  </span>
                </label>
                <input
                  className="input"
                  value={slug}
                  disabled={saving}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                />
              </div>
              <div className="field">
                <label>
                  Label <span style={{ color: 'var(--danger)' }}>*</span>
                </label>
                <input
                  className="input"
                  value={label}
                  disabled={saving}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

            {/* Node mappings — driven by what the JSON contains */}
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              <strong>Node mappings</strong> — auto-detected from node titles. Override any if
              needed.
            </p>

            <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginTop: 4 }}>
              Leave face and background blank for a lower/inner-wear-only workflow - at least one of
              upper or lower garment node is still required.
            </span>

            {/* Core image nodes */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <NodeSelect
                label="Face node"
                nodes={nodes.image}
                value={faceNodeId}
                onChange={setFaceNodeId}
                disabled={saving}
                hint='Title convention: "face"'
              />
              <NodeSelect
                label="Pose / template node"
                nodes={nodes.image}
                value={poseNodeId}
                onChange={setPoseNodeId}
                required
                disabled={saving}
                hint='Title convention: "pose"'
              />
              <NodeSelect
                label="Background node"
                nodes={nodes.image}
                value={bgNodeId}
                onChange={setBgNodeId}
                disabled={saving}
                hint='Title convention: "background"'
              />
            </div>

            {/* Upper garment — can have multiple */}
            <div className="field">
              <label style={{ fontSize: 12, fontWeight: 600 }}>
                Upper garment node(s)
                <span
                  style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}
                >
                  Title convention: "upper_garment" (or "upper_garment_1", "upper_garment_2" …)
                </span>
              </label>
              {upperNodeIds.map((uid, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: controlled selects with no per-row state; values can repeat/be empty
                <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <SearchableSelect
                      options={nodes.image.map((n) => ({
                        id: n.id,
                        label: `[${n.id}] ${n.title} (${n.class_type})`,
                      }))}
                      value={uid}
                      disabled={saving}
                      emptyLabel="— select node —"
                      placeholder="— search node —"
                      onChange={(id) => {
                        const next = [...upperNodeIds];
                        next[idx] = id;
                        setUpperNodeIds(next);
                      }}
                    />
                  </div>
                  {upperNodeIds.length > 1 && (
                    <button
                      className="btn sm ghost"
                      disabled={saving}
                      onClick={() => setUpperNodeIds((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Icon.Close />
                    </button>
                  )}
                </div>
              ))}
              {upperNodeIds.length < 8 && (
                <button
                  className="btn sm ghost"
                  disabled={saving}
                  onClick={() => setUpperNodeIds((prev) => [...prev, ''])}
                  style={{ marginTop: 2 }}
                >
                  <Icon.Plus /> Add another upper garment node
                </button>
              )}
            </div>

            {/* Optional image nodes */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <NodeSelect
                label="Lower garment node"
                nodes={nodes.image}
                value={lowerNodeId}
                onChange={setLowerNodeId}
                disabled={saving}
                hint='Title convention: "lower_garment"'
              />
              <NodeSelect
                label="Shoes node (optional)"
                nodes={nodes.image}
                value={shoeNodeId}
                onChange={setShoeNodeId}
                disabled={saving}
                hint='Title convention: "shoes"'
              />
              <NodeSelect
                label="Third garment node (optional)"
                nodes={nodes.image}
                value={thirdNodeId}
                onChange={setThirdNodeId}
                disabled={saving}
                hint='Title convention: "third_garment"'
              />
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

            {/* Prompt nodes */}
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              <strong>Prompt nodes</strong> — the positive prompt changes per pose; the negative
              stays hardcoded in the workflow.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <NodeSelect
                label="Positive prompt node"
                nodes={nodes.prompt}
                value={positivePromptNode}
                onChange={setPositivePromptNode}
                required
                disabled={saving}
                hint='Title convention: "positive_prompt"'
              />
              <NodeSelect
                label="Negative prompt node"
                nodes={nodes.prompt}
                value={negativePromptNode}
                onChange={setNegativePromptNode}
                required={!!faceNodeId}
                disabled={saving}
                hint='Title convention: "negative_prompt"'
              />
            </div>

            {/* Size nodes — read-only, fully auto-detected (no manual override).
                  Dual-size-group templates (max-width/max-height + result-width/result-height
                  titles) take priority over the legacy single-group sizeNodeIds list. */}
            {(latentSizeNodeIds.length === 2 ||
              outputSizeNodeIds.length === 2 ||
              sizeNodeIds.length > 0) && (
              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  Size nodes (auto-detected)
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                  {latentSizeNodeIds.length === 2 || outputSizeNodeIds.length === 2 ? (
                    <>
                      <span>
                        Latent size:{' '}
                        <span className="mono" style={{ color: 'var(--accent)' }}>
                          [{latentSizeNodeIds.join(', ') || '—'}]
                        </span>
                      </span>
                      <span>
                        Output size:{' '}
                        <span className="mono" style={{ color: 'var(--accent)' }}>
                          [{outputSizeNodeIds.join(', ') || '—'}]
                        </span>
                      </span>
                    </>
                  ) : (
                    <span>
                      Size nodes:{' '}
                      <span className="mono" style={{ color: 'var(--accent)' }}>
                        [{sizeNodeIds.join(', ')}]
                      </span>
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Detected summary */}
            {detectedCount > 0 && (
              <div
                style={{
                  background: 'var(--success-soft)',
                  border: '1px solid var(--success-border)',
                  borderRadius: 6,
                  padding: '10px 12px',
                  fontSize: 12,
                }}
              >
                <strong>Auto-detected:</strong>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {[
                    parsed.detected.faceNodeId &&
                      parsed.allImageNodes.find((n) => n.id === parsed.detected.faceNodeId),
                    parsed.detected.poseNodeId &&
                      parsed.allImageNodes.find((n) => n.id === parsed.detected.poseNodeId),
                    parsed.detected.bgNodeId &&
                      parsed.allImageNodes.find((n) => n.id === parsed.detected.bgNodeId),
                    ...parsed.detected.upperNodeIds.map((id) =>
                      parsed.allImageNodes.find((n) => n.id === id),
                    ),
                    parsed.detected.lowerNodeId &&
                      parsed.allImageNodes.find((n) => n.id === parsed.detected.lowerNodeId),
                    parsed.detected.shoeNodeId &&
                      parsed.allImageNodes.find((n) => n.id === parsed.detected.shoeNodeId),
                    parsed.detected.thirdNodeId &&
                      parsed.allImageNodes.find((n) => n.id === parsed.detected.thirdNodeId),
                    parsed.detected.positivePromptNode &&
                      parsed.allPromptNodes.find(
                        (n) => n.id === parsed.detected.positivePromptNode,
                      ),
                    parsed.detected.negativePromptNode &&
                      parsed.allPromptNodes.find(
                        (n) => n.id === parsed.detected.negativePromptNode,
                      ),
                  ]
                    .filter(Boolean)
                    .map((n) => n && <NodeBadge key={n.id} node={n} />)}
                </div>
              </div>
            )}
          </>
        )}

        {error && (
          <div
            style={{
              fontSize: 13,
              color: 'var(--danger)',
              padding: '8px 12px',
              background: 'var(--danger-soft)',
              borderRadius: 6,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </EditDrawer>
  );
}
