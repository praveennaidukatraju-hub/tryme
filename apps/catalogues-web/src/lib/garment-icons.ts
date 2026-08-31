import { Handbag, Watch } from 'lucide-react';
import type { ComponentType } from 'react';
import {
  TbEyeglass,
  TbJacket,
  TbShirt,
  TbShirtSport,
  TbShoe,
  TbSock,
  TbSunglasses,
  TbTie,
} from 'react-icons/tb';

type IconComponent = ComponentType<{ size?: number; color?: string }>;

/** Generic fallback glyph — also used for empty states so they visually
 * match the per-category icons instead of a different shirt shape. */
export const DEFAULT_GARMENT_ICON: IconComponent = TbShirt;

// Keyword -> icon, checked in order (first match wins), matched against the
// garment type's label. Every icon here is a plain thin-stroke outline (no
// fills, no fine detail) so nothing looks muddy at the 20px card size —
// types with no clean matching glyph (dresses, pants, caps) fall through to
// the generic shirt rather than showing something that looks wrong.
const RULES: [RegExp, IconComponent][] = [
  [/hood|jacket|blazer|sherwani|coat|\bsuit\b/i, TbJacket],
  [/polo|t.?shirt|\btee\b|crop|tank|\btop\b/i, TbShirt],
  [/kurta|chudidar|churidar|pyjama|shirt/i, TbShirtSport],
  [/\btie\b/i, TbTie],
  [/boot|shoe|sneaker|sandal|slipper/i, TbShoe],
  [/sock/i, TbSock],
  [/bag|purse/i, Handbag],
  [/sunglass/i, TbSunglasses],
  [/glass/i, TbEyeglass],
  [/watch/i, Watch],
];

/** Best-effort icon for a garment type label. Falls back to a generic shirt
 * glyph when nothing has a clean matching icon. */
export function getGarmentIcon(label?: string): IconComponent {
  if (label) {
    for (const [pattern, Icon] of RULES) {
      if (pattern.test(label)) return Icon;
    }
  }
  return DEFAULT_GARMENT_ICON;
}
