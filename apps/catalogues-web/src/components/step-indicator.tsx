import { Fragment } from 'react';
import { CheckIcon } from './icons';
import { C, grad } from './tokens';

const STEPS = ['Setup', 'AI Models', 'Backgrounds', 'Generate'];

/** step: 1-based current step (1..4) */
export function StepBar({ step }: { step: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {STEPS.map((s, i) => {
        const num = i + 1;
        const done = num < step;
        const active = num === step;
        return (
          <Fragment key={s}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: active ? C.dark : done ? grad : C.border2,
                  fontSize: 10,
                  fontWeight: 600,
                  color: active || done ? C.onDark : C.mid,
                  flexShrink: 0,
                }}
              >
                {done ? <CheckIcon color={C.onDark} size={12} /> : num}
              </div>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: active ? C.text : C.mid,
                  whiteSpace: 'nowrap',
                }}
              >
                {s}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ width: 36, height: 1, background: C.border2, margin: '0 8px' }} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
