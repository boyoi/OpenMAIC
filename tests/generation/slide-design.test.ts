import { describe, expect, it } from 'vitest';
import { inferSlideIntent, resolveSlideDesign } from '@/lib/generation/slide-design';
import type { SceneOutline } from '@/lib/types/generation';

function slide(id: string, order: number, title: string): SceneOutline {
  return {
    id,
    type: 'slide',
    title,
    description: `Explain ${title}`,
    keyPoints: ['Input', 'Transformation', 'Observable result'],
    order,
  };
}

describe('slide design planning', () => {
  it('honors explicit semantic planning fields', () => {
    const outline = {
      ...slide('decision', 1, 'Release gate'),
      slideIntent: 'decision' as const,
      visualBrief: 'Show the threshold that changes GO into STOP.',
    };

    const design = resolveSlideDesign(outline, [outline]);

    expect(design.intent).toBe('decision');
    expect(design.visualBrief).toContain('threshold');
    expect(design.layout).toBe('decision-path');
  });

  it('distinguishes a worked example from a case study', () => {
    const outline = slide('worked', 2, '逐步求解 API 签名错误');

    expect(inferSlideIntent(outline, 3)).toBe('worked-example');
  });

  it('rotates layout variants for adjacent slides with the same intent', () => {
    const outlines = [
      { ...slide('a', 1, 'Core model A'), slideIntent: 'concept' as const },
      { ...slide('b', 2, 'Core model B'), slideIntent: 'concept' as const },
      { ...slide('c', 3, 'Core model C'), slideIntent: 'concept' as const },
    ];

    const variants = outlines.map((outline) => resolveSlideDesign(outline, outlines).variant);

    expect(new Set(variants).size).toBe(3);
    expect(variants[0]).not.toBe(variants[1]);
    expect(variants[1]).not.toBe(variants[2]);
  });

  it('keeps one topic-aware palette across the deck', () => {
    const outlines = [slide('a', 1, 'Python API basics'), slide('b', 2, 'Software system flow')];

    const first = resolveSlideDesign(outlines[0], outlines);
    const second = resolveSlideDesign(outlines[1], outlines);

    expect(first.palette.name).toBe('teal-blue-coral');
    expect(second.palette).toEqual(first.palette);
  });

  it('ignores malformed visual planning values safely', () => {
    const outline = {
      ...slide('bad', 1, 'Architecture overview'),
      visualBrief: { unexpected: true },
    } as unknown as SceneOutline;

    expect(() => resolveSlideDesign(outline, [outline])).not.toThrow();
    expect(resolveSlideDesign(outline, [outline]).visualBrief).toContain('components');
  });
});
