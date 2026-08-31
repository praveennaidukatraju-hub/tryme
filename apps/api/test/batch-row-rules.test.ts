import {
  CreateBatchJobRequest,
  countBatchJobs,
  MAX_BATCH_ROWS,
  requiredInputsForPoses,
} from '@tryme/types';
import { describe, expect, it } from 'vitest';

const UUID = '00000000-0000-4000-8000-000000000001';
const KEY = `inputs/${UUID}/garment.jpg`;

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    upperGarmentKey: KEY,
    faceId: UUID,
    backgroundId: UUID,
    poseIds: [UUID],
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    garmentTypeId: UUID,
    aspectRatio: '1:1',
    resolution: '2K',
    rows: [validRow()],
    ...overrides,
  };
}

describe('requiredInputsForPoses', () => {
  it('needs neither when no pose asks for one', () => {
    expect(requiredInputsForPoses([{ hasLower: false, hasShoes: false }])).toEqual({
      needsLower: false,
      needsShoes: false,
    });
  });

  it('needs a lower when any single pose asks for one', () => {
    expect(
      requiredInputsForPoses([
        { hasLower: false, hasShoes: false },
        { hasLower: true, hasShoes: false },
      ]),
    ).toEqual({ needsLower: true, needsShoes: false });
  });

  it('needs both when different poses each ask for one', () => {
    expect(
      requiredInputsForPoses([
        { hasLower: true, hasShoes: false },
        { hasLower: false, hasShoes: true },
      ]),
    ).toEqual({ needsLower: true, needsShoes: true });
  });

  it('needs neither for an empty selection', () => {
    expect(requiredInputsForPoses([])).toEqual({ needsLower: false, needsShoes: false });
  });
});

describe('countBatchJobs', () => {
  it('sums poses across rows', () => {
    expect(countBatchJobs([{ poseIds: ['a', 'b'] }, { poseIds: ['c'] }])).toBe(3);
  });

  it('is zero for no rows', () => {
    expect(countBatchJobs([])).toBe(0);
  });
});

describe('CreateBatchJobRequest', () => {
  it('accepts a minimal valid body', () => {
    expect(CreateBatchJobRequest.safeParse(validBody()).success).toBe(true);
  });

  it('rejects a row with no poses', () => {
    const res = CreateBatchJobRequest.safeParse(validBody({ rows: [validRow({ poseIds: [] })] }));
    expect(res.success).toBe(false);
  });

  it('rejects an empty rows array', () => {
    expect(CreateBatchJobRequest.safeParse(validBody({ rows: [] })).success).toBe(false);
  });

  it('rejects more than MAX_BATCH_ROWS rows', () => {
    const rows = Array.from({ length: MAX_BATCH_ROWS + 1 }, () => validRow());
    expect(CreateBatchJobRequest.safeParse(validBody({ rows })).success).toBe(false);
  });

  it('rejects a garment key that does not match the presign format', () => {
    const res = CreateBatchJobRequest.safeParse(
      validBody({ rows: [validRow({ upperGarmentKey: 'inputs/../../etc/passwd' })] }),
    );
    expect(res.success).toBe(false);
  });

  it('requires garmentTypeId', () => {
    const body = validBody() as Record<string, unknown>;
    delete body.garmentTypeId;
    expect(CreateBatchJobRequest.safeParse(body).success).toBe(false);
  });

  it('rejects mannequinJobId, thirdGarmentKey and catalogueTemplateMappingId on a row', () => {
    for (const field of ['mannequinJobId', 'thirdGarmentKey', 'catalogueTemplateMappingId']) {
      const parsed = CreateBatchJobRequest.parse(
        validBody({ rows: [validRow({ [field]: UUID })] }),
      );
      expect(parsed.rows[0]).not.toHaveProperty(field);
    }
  });
});
