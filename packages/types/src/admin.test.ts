// packages/types/src/admin.test.ts
import { describe, expect, it } from 'vitest';
import { ReplaceWorkflowBody } from './admin.js';

describe('ReplaceWorkflowBody', () => {
  const base = {
    slug: 'my_workflow',
    label: 'My Workflow',
    jsonContent: {},
    workflowType: 'regular' as const,
    poseNodeId: 'p1',
    garmentPhasePromptNode: 'g1',
    upperNodeIds: ['u1'],
  };

  it('rejects a missing password', () => {
    const result = ReplaceWorkflowBody.safeParse(base);
    expect(result.success).toBe(false);
  });

  it('accepts a valid body with a password', () => {
    const result = ReplaceWorkflowBody.safeParse({
      ...base,
      password: 'correct horse battery staple',
    });
    expect(result.success).toBe(true);
  });

  it('still enforces the underlying workflowType-specific requirements', () => {
    const result = ReplaceWorkflowBody.safeParse({
      slug: 'ts',
      label: 'Two stage',
      jsonContent: {},
      workflowType: 'two_stage',
      poseNodeId: 'p1',
      password: 'x',
      // missing stage1PositivePromptNode/stage1NegativePromptNode/etc.
    });
    expect(result.success).toBe(false);
  });
});
