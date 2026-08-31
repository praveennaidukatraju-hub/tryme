import { describe, expect, it } from 'vitest';
import { extractKSamplerNodes, writeKSamplerOverride } from './workflows.routes.js';

function ksampler(seed: number, steps = 4, cfg = 1, denoise = 1) {
  return { class_type: 'KSampler', inputs: { seed, steps, cfg, denoise } };
}

describe('extractKSamplerNodes', () => {
  it('returns an empty array when there is no KSampler node', () => {
    expect(extractKSamplerNodes({ '1': { class_type: 'LoadImage', inputs: {} } })).toEqual([]);
  });

  it('returns the single node for a regular (one-KSampler) workflow', () => {
    const json = { '10': ksampler(12345, 4, 1, 1) };
    expect(extractKSamplerNodes(json)).toEqual([
      { nodeId: '10', seed: 12345, steps: 4, cfg: 1, denoise: 1 },
    ]);
  });

  it('returns both nodes for a two-KSampler (two_stage) workflow, not just one', () => {
    const json = { '22': ksampler(111), '32': ksampler(222) };
    const result = extractKSamplerNodes(json);
    expect(result.map((n) => n.nodeId).sort()).toEqual(['22', '32']);
    expect(result.find((n) => n.nodeId === '22')?.seed).toBe(111);
    expect(result.find((n) => n.nodeId === '32')?.seed).toBe(222);
  });

  it('reports null fields for a KSampler node missing that input', () => {
    const json = { '1': { class_type: 'KSampler', inputs: { seed: 'not-a-number' } } };
    expect(extractKSamplerNodes(json)).toEqual([
      { nodeId: '1', seed: null, steps: null, cfg: null, denoise: null },
    ]);
  });
});

describe('writeKSamplerOverride', () => {
  it('writes only the provided fields, leaving others untouched', () => {
    const json = { '10': ksampler(1, 4, 1, 1) };
    writeKSamplerOverride(json, { nodeId: '10', seed: 999 });
    expect(extractKSamplerNodes(json)).toEqual([
      { nodeId: '10', seed: 999, steps: 4, cfg: 1, denoise: 1 },
    ]);
  });

  it('targets exactly the given node in a multi-KSampler graph, not "the first one"', () => {
    const json = { '22': ksampler(111), '32': ksampler(222) };
    writeKSamplerOverride(json, { nodeId: '32', seed: 777 });
    const result = extractKSamplerNodes(json);
    expect(result.find((n) => n.nodeId === '22')?.seed).toBe(111);
    expect(result.find((n) => n.nodeId === '32')?.seed).toBe(777);
  });

  it('throws when the node does not exist', () => {
    expect(() => writeKSamplerOverride({}, { nodeId: 'missing', seed: 1 })).toThrow(/not found/);
  });

  it('throws when the node exists but is not a KSampler', () => {
    const json = { '1': { class_type: 'LoadImage', inputs: {} } };
    expect(() => writeKSamplerOverride(json, { nodeId: '1', seed: 1 })).toThrow(/not a KSampler/);
  });
});
