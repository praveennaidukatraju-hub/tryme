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
  workflow: WorkflowOption;
  onReplaced: (wf: WorkflowOption) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
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

export function ReplaceWorkflowModal({ workflow, onReplaced, onClose, toast }: Props) {
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [slug, setSlug] = useState(workflow.slug);
  const [label, setLabel] = useState(workflow.label);
  const [workflowType, setWorkflowType] = useState<WorkflowOption['workflowType']>(
    workflow.workflowType,
  );
  const [password, setPassword] = useState('');

  // Regular workflow fields
  const [faceNodeId, setFaceNodeId] = useState('');
  const [poseNodeId, setPoseNodeId] = useState('');
  const [bgNodeId, setBgNodeId] = useState('');
  const [upperNodeIds, setUpperNodeIds] = useState<string[]>(['']);
  const [lowerNodeId, setLowerNodeId] = useState('');
  const [shoeNodeId, setShoeNodeId] = useState('');
  const [thirdNodeId, setThirdNodeId] = useState('');
  const [sizeNodeIds, setSizeNodeIds] = useState<string[]>([]);
  const [latentSizeNodeIds, setLatentSizeNodeIds] = useState<string[]>([]);
  const [outputSizeNodeIds, setOutputSizeNodeIds] = useState<string[]>([]);
  const [resultNodeId, setResultNodeId] = useState('');
  const [positivePromptNode, setPositivePromptNode] = useState('');
  const [negativePromptNode, setNegativePromptNode] = useState('');

  // Tryon / Saree fields
  const [tryonPersonNodeId, setTryonPersonNodeId] = useState('');
  const [tryonGarmentNodeId, setTryonGarmentNodeId] = useState('');
  const [tryonGarmentNodeId2, setTryonGarmentNodeId2] = useState('');
  const [tryonOutputNodeId, setTryonOutputNodeId] = useState('');

  // Two-stage fields
  const [twoStageGarmentNodeId, setTwoStageGarmentNodeId] = useState('');
  const [stage1PositivePromptNode, setStage1PositivePromptNode] = useState('');
  const [stage1NegativePromptNode, setStage1NegativePromptNode] = useState('');

  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (file: File) => {
    if (!file.name.endsWith('.json')) {
      setError('Please upload a JSON file');
      return;
    }
    setJsonFile(file);
    setError(null);
    setParsing(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text) as Record<string, unknown>;

      const result = await apiFetch<ParseResult>('/admin/workflows/parse', {
        method: 'POST',
        body: JSON.stringify({ jsonContent: json, workflowType }),
      });
      setParsed(result);

      if (workflowType === 'tryon' || workflowType === 'saree_step1') {
        const d = result.detected as {
          personNodeId?: string;
          garmentNodeId?: string;
          outputNodeId?: string;
          positivePromptNode?: string;
          negativePromptNode?: string;
        };
        setTryonPersonNodeId(d.personNodeId ?? '');
        setTryonGarmentNodeId(d.garmentNodeId ?? '');
        setTryonGarmentNodeId2('');
        setTryonOutputNodeId(d.outputNodeId ?? '');
        setPositivePromptNode(d.positivePromptNode ?? '');
        setNegativePromptNode(d.negativePromptNode ?? '');
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
        };
        setTryonPersonNodeId(d.personNodeId ?? '');
        setTryonGarmentNodeId(d.bodyNodeId ?? '');
        setTryonGarmentNodeId2(d.palluNodeId ?? '');
        setTryonOutputNodeId(d.outputNodeId ?? '');
        setPositivePromptNode(d.positivePromptNode ?? '');
        setNegativePromptNode(d.negativePromptNode ?? '');
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
    if (!password.trim()) {
      setError('Admin password is required');
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
          password: password.trim(),
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
          facePhasePromptNode: negativePromptNode,
          garmentPhasePromptNode: positivePromptNode,
          stage1PositivePromptNode,
          stage1NegativePromptNode,
          password: password.trim(),
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
          facePhasePromptNode: negativePromptNode || undefined,
          garmentPhasePromptNode: positivePromptNode,
          password: password.trim(),
        };
      }

      const replaced = await apiFetch<WorkflowOption>(`/admin/workflows/${workflow.id}/replace`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast({ title: `Workflow replaced (now v${replaced.version ?? 2})` });
      onReplaced(replaced);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to replace workflow'));
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

  const canSubmit =
    !saving &&
    jsonFile &&
    slug.trim() &&
    label.trim() &&
    password.trim() &&
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
      title={`Replace Workflow: ${workflow.label}`}
      subtitle={`Replacing v${workflow.version ?? 1} in place. FK references will stay intact.`}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
      saveDisabled={!canSubmit}
      saveLabel="Confirm & Replace Workflow"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Warning / Impact banner */}
        <div
          style={{
            background: 'var(--amber-soft, #fffbeb)',
            border: '1px solid var(--amber-border, #fcd34d)',
            borderRadius: 8,
            padding: '12px 16px',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--amber-text, #92400e)', marginBottom: 4 }}>
            Replacing "{workflow.label}" in place (currently v{workflow.version ?? 1})
          </div>
          <div style={{ color: 'var(--text-muted, #6b7280)' }}>
            <strong>{workflow.poseCount}</strong> pose asset{workflow.poseCount === 1 ? '' : 's'}{' '}
            and <strong>{workflow.funnelCount ?? 0}</strong> Shopify funnel
            {workflow.funnelCount === 1 ? '' : 's'} reference this workflow. Their foreign keys will
            stay intact, and new jobs will immediately resolve the new version (v
            {(workflow.version ?? 1) + 1}). Any in-flight or queued jobs will continue using v
            {workflow.version ?? 1} until they finish.
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              background: 'var(--danger-soft, #fef2f2)',
              border: '1px solid var(--danger-border, #fecaca)',
              borderRadius: 6,
              color: 'var(--danger, #dc2626)',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {/* JSON File Drop Area */}
        <div>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
            New Workflow JSON <span style={{ color: 'var(--danger)' }}>*</span>
          </label>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              const file = e.dataTransfer.files[0];
              if (file) void handleFileSelect(file);
            }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${isDragOver ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8,
              padding: 24,
              textAlign: 'center',
              cursor: 'pointer',
              background: isDragOver ? 'var(--accent-soft, #f0f9ff)' : 'var(--surface)',
              transition: 'border-color 0.15s, background-color 0.15s',
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileSelect(file);
              }}
            />
            <div style={{ width: 28, height: 28, margin: '0 auto 8px', color: 'var(--muted)' }}>
              <Icon.Upload />
            </div>
            {jsonFile ? (
              <div>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{jsonFile.name}</span>
                <span
                  style={{ color: 'var(--muted)', fontSize: 12, display: 'block', marginTop: 2 }}
                >
                  {(jsonFile.size / 1024).toFixed(1)} KB — click or drop to replace
                </span>
              </div>
            ) : (
              <div>
                <span style={{ fontSize: 13, color: 'var(--text)' }}>
                  Drop new ComfyUI workflow JSON here, or click to browse
                </span>
              </div>
            )}
          </div>
        </div>

        {parsing && (
          <div
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span className="spinner" /> Parsing workflow nodes...
          </div>
        )}

        {/* Basic Metadata */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="field">
            <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Label <span style={{ color: 'var(--danger)' }}>*</span>
            </label>
            <input
              type="text"
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Flux Pro Studio (v2)"
            />
          </div>
          <div className="field">
            <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Slug <span style={{ color: 'var(--danger)' }}>*</span>
            </label>
            <input
              type="text"
              className="input"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="e.g. flux_pro_v2"
            />
          </div>
        </div>

        {/* Workflow Type Selector */}
        <div className="field">
          <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Workflow Type <span style={{ color: 'var(--danger)' }}>*</span>
          </label>
          <select
            className="input"
            value={workflowType}
            onChange={(e) => {
              setWorkflowType(e.target.value as WorkflowOption['workflowType']);
              if (jsonFile) void handleFileSelect(jsonFile);
            }}
          >
            <option value="regular">Regular (Pose / Studio / Merchant)</option>
            <option value="two_stage">Two-Stage (Person + Garment)</option>
            <option value="tryon">Try-On</option>
            <option value="saree_step1">Saree Step 1 (Single Input)</option>
            <option value="saree_step1_two_input">Saree Step 1 (Two Input: Body & Pallu)</option>
          </select>
        </div>

        {/* Node Configuration */}
        {nodes && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              borderTop: '1px solid var(--border)',
              paddingTop: 16,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              Node Mappings ({workflowType})
            </div>

            {workflowType === 'regular' && (
              <>
                <NodeSelect
                  label="Pose Node"
                  nodes={nodes.image}
                  value={poseNodeId}
                  onChange={setPoseNodeId}
                  required
                  hint="LoadImage node receiving the model pose image"
                />
                <NodeSelect
                  label="Face Node"
                  nodes={nodes.image}
                  value={faceNodeId}
                  onChange={setFaceNodeId}
                  hint="LoadImage node receiving the face swap image (optional)"
                />
                <NodeSelect
                  label="Background Node"
                  nodes={nodes.image}
                  value={bgNodeId}
                  onChange={setBgNodeId}
                  hint="LoadImage node receiving the background image (optional)"
                />
                <div className="field">
                  <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    Upper Garment Nodes
                  </label>
                  {upperNodeIds.map((uid, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: controlled selects with no per-row state; values can repeat/be empty
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                      <SearchableSelect
                        options={nodes.image.map((n) => ({
                          id: n.id,
                          label: `[${n.id}] ${n.title}`,
                        }))}
                        value={uid}
                        onChange={(v) => {
                          const updated = [...upperNodeIds];
                          updated[i] = v;
                          setUpperNodeIds(updated);
                        }}
                        emptyLabel="— none —"
                        placeholder="— select node —"
                      />
                      {upperNodeIds.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-icon"
                          onClick={() =>
                            setUpperNodeIds(upperNodeIds.filter((_, idx) => idx !== i))
                          }
                        >
                          <Icon.Close />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ marginTop: 4 }}
                    onClick={() => setUpperNodeIds([...upperNodeIds, ''])}
                  >
                    <Icon.Plus /> Add Upper Garment Node
                  </button>
                </div>
                <NodeSelect
                  label="Lower Garment Node"
                  nodes={nodes.image}
                  value={lowerNodeId}
                  onChange={setLowerNodeId}
                  hint="LoadImage node receiving lower garment image (optional)"
                />
                <NodeSelect
                  label="Shoe Node"
                  nodes={nodes.image}
                  value={shoeNodeId}
                  onChange={setShoeNodeId}
                  hint="LoadImage node receiving shoe image (optional)"
                />
                <NodeSelect
                  label="Third Garment Node"
                  nodes={nodes.image}
                  value={thirdNodeId}
                  onChange={setThirdNodeId}
                  hint="LoadImage node receiving third garment image (optional)"
                />
                <NodeSelect
                  label="Positive Prompt Node"
                  nodes={nodes.prompt}
                  value={positivePromptNode}
                  onChange={setPositivePromptNode}
                  required
                  hint="CLIPTextEncode node patched with the garment prompt"
                />
                <NodeSelect
                  label="Negative / Face Phase Prompt Node"
                  nodes={nodes.prompt}
                  value={negativePromptNode}
                  onChange={setNegativePromptNode}
                  required={Boolean(faceNodeId)}
                  hint="CLIPTextEncode node patched during face phase"
                />
              </>
            )}

            {(workflowType === 'tryon' || workflowType === 'saree_step1') && (
              <>
                <NodeSelect
                  label="Person Node"
                  nodes={nodes.image}
                  value={tryonPersonNodeId}
                  onChange={setTryonPersonNodeId}
                  hint="LoadImage node receiving customer person image (optional if baked into template)"
                />
                <NodeSelect
                  label="Garment Node"
                  nodes={nodes.image}
                  value={tryonGarmentNodeId}
                  onChange={setTryonGarmentNodeId}
                  required
                  hint="LoadImage node receiving garment cloth image"
                />
                <NodeSelect
                  label="Output Node"
                  nodes={nodes.image}
                  value={tryonOutputNodeId}
                  onChange={setTryonOutputNodeId}
                  required
                  hint="SaveImage / PreviewImage node delivering final result"
                />
                <NodeSelect
                  label="Positive Prompt Node"
                  nodes={nodes.prompt}
                  value={positivePromptNode}
                  onChange={setPositivePromptNode}
                  required
                />
                <NodeSelect
                  label="Negative Prompt Node"
                  nodes={nodes.prompt}
                  value={negativePromptNode}
                  onChange={setNegativePromptNode}
                  required
                />
              </>
            )}

            {workflowType === 'saree_step1_two_input' && (
              <>
                <NodeSelect
                  label="Person Node"
                  nodes={nodes.image}
                  value={tryonPersonNodeId}
                  onChange={setTryonPersonNodeId}
                  hint="LoadImage node receiving person image (optional)"
                />
                <NodeSelect
                  label="Body Node"
                  nodes={nodes.image}
                  value={tryonGarmentNodeId}
                  onChange={setTryonGarmentNodeId}
                  required
                  hint="LoadImage node receiving saree body cloth image"
                />
                <NodeSelect
                  label="Pallu Node"
                  nodes={nodes.image}
                  value={tryonGarmentNodeId2}
                  onChange={setTryonGarmentNodeId2}
                  required
                  hint="LoadImage node receiving saree pallu cloth image"
                />
                <NodeSelect
                  label="Output Node"
                  nodes={nodes.image}
                  value={tryonOutputNodeId}
                  onChange={setTryonOutputNodeId}
                  required
                  hint="SaveImage node delivering final result"
                />
                <NodeSelect
                  label="Positive Prompt Node"
                  nodes={nodes.prompt}
                  value={positivePromptNode}
                  onChange={setPositivePromptNode}
                  required
                />
                <NodeSelect
                  label="Negative Prompt Node"
                  nodes={nodes.prompt}
                  value={negativePromptNode}
                  onChange={setNegativePromptNode}
                  required
                />
              </>
            )}

            {workflowType === 'two_stage' && (
              <>
                <NodeSelect
                  label="Face Node"
                  nodes={nodes.image}
                  value={faceNodeId}
                  onChange={setFaceNodeId}
                  required
                />
                <NodeSelect
                  label="Pose Node"
                  nodes={nodes.image}
                  value={poseNodeId}
                  onChange={setPoseNodeId}
                  required
                />
                <NodeSelect
                  label="Background Node"
                  nodes={nodes.image}
                  value={bgNodeId}
                  onChange={setBgNodeId}
                  required
                />
                <NodeSelect
                  label="Garment Node"
                  nodes={nodes.image}
                  value={twoStageGarmentNodeId}
                  onChange={setTwoStageGarmentNodeId}
                  required
                />
                <NodeSelect
                  label="Stage 1 Positive Prompt Node"
                  nodes={nodes.prompt}
                  value={stage1PositivePromptNode}
                  onChange={setStage1PositivePromptNode}
                  required
                />
                <NodeSelect
                  label="Stage 1 Negative Prompt Node"
                  nodes={nodes.prompt}
                  value={stage1NegativePromptNode}
                  onChange={setStage1NegativePromptNode}
                  required
                />
                <NodeSelect
                  label="Stage 2 Positive Prompt Node"
                  nodes={nodes.prompt}
                  value={positivePromptNode}
                  onChange={setPositivePromptNode}
                  required
                />
                <NodeSelect
                  label="Stage 2 Negative Prompt Node"
                  nodes={nodes.prompt}
                  value={negativePromptNode}
                  onChange={setNegativePromptNode}
                  required
                />
              </>
            )}
          </div>
        )}

        {/* Password Confirmation */}
        <div
          className="field"
          style={{
            marginTop: 12,
            padding: 16,
            background: 'var(--surface-sunken, #f8fafc)',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>
            Admin Password Confirmation <span style={{ color: 'var(--danger)' }}>*</span>
          </label>
          <span style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 8 }}>
            Replacing a workflow modifies the pipeline for all poses/funnels using it. Enter your
            admin password to confirm.
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter admin password"
            className="input"
            style={{ width: '100%', maxWidth: 360 }}
          />
        </div>
      </div>
    </EditDrawer>
  );
}
