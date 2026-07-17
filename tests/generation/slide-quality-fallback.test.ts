import { describe, expect, it } from 'vitest';
import { generateSceneContent } from '@/lib/generation/scene-generator';
import type { AICallFn, GeneratedSlideData } from '@/lib/generation/pipeline-types';
import type { GeneratedSlideContent, SceneOutline } from '@/lib/types/generation';

const outline: SceneOutline = {
  id: 'quality-slide',
  type: 'slide',
  title: 'Build a Pi Agent Application',
  description: 'Move from a small Python script to a working agent application.',
  keyPoints: ['Define the agent role', 'Connect tools safely', 'Run and inspect the result'],
  order: 1,
};

function validCompactLayout(title = 'VALID-LAYOUT-SENTINEL'): GeneratedSlideData {
  return {
    background: { type: 'solid', color: '#F7F8FA' },
    elements: [
      {
        id: 'title',
        type: 'text',
        left: 60,
        top: 50,
        width: 880,
        height: 70,
        content: `<p style="font-size:34px;">${title}</p>`,
        defaultFontName: 'Microsoft YaHei',
        defaultColor: '#111827',
      },
      {
        id: 'visual_1',
        type: 'shape',
        left: 60,
        top: 160,
        width: 400,
        height: 280,
        path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
        viewBox: [1, 1],
        fill: '#FFFFFF',
        fixedRatio: false,
      },
      {
        id: 'visual_2',
        type: 'shape',
        left: 500,
        top: 160,
        width: 200,
        height: 130,
        path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
        viewBox: [1, 1],
        fill: '#0F766E',
        fixedRatio: false,
      },
      {
        id: 'visual_3',
        type: 'shape',
        left: 740,
        top: 160,
        width: 200,
        height: 130,
        path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
        viewBox: [1, 1],
        fill: '#2563EB',
        fixedRatio: false,
      },
      {
        id: 'visual_4',
        type: 'shape',
        left: 500,
        top: 330,
        width: 440,
        height: 110,
        path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
        viewBox: [1, 1],
        fill: '#E4573D',
        fixedRatio: false,
      },
    ],
  };
}

function textContent(content: GeneratedSlideContent): string {
  return content.elements
    .filter((element) => element.type === 'text')
    .map((element) => String((element as { content?: string }).content || ''))
    .join(' ');
}

describe('slide quality fallback', () => {
  it('replaces a truncated model response with a complete readable slide', async () => {
    const aiCall: AICallFn = async () =>
      '{"background":{"type":"solid","color":"#fff"},"elements":[{"type":"text","left":60';

    const result = (await generateSceneContent(outline, aiCall)) as GeneratedSlideContent;

    expect(result).not.toBeNull();
    expect(result.elements.length).toBeGreaterThanOrEqual(8);
    expect(result.elements.length).toBeLessThanOrEqual(16);
    expect(textContent(result)).toContain('Build a Pi Agent Application');
    expect(textContent(result)).toContain('Define the agent role');
  });

  it('replaces an overstuffed model layout instead of displaying it', async () => {
    const elements = Array.from({ length: 17 }, (_, index) => ({
      id: `shape_${index}`,
      type: 'shape',
      left: 10 + index,
      top: 10 + index,
      width: 20,
      height: 20,
      path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
      viewBox: [1, 1],
      fill: '#000000',
      fixedRatio: false,
    }));
    const aiCall: AICallFn = async () => JSON.stringify({ elements });

    const result = (await generateSceneContent(outline, aiCall)) as GeneratedSlideContent;

    expect(result.elements.length).toBeLessThanOrEqual(16);
    expect(textContent(result)).toContain('Build a Pi Agent Application');
  });

  it('falls back when valid JSON contains a non-array elements field', async () => {
    const aiCall: AICallFn = async () => JSON.stringify({ elements: { invalid: true } });

    const result = (await generateSceneContent(outline, aiCall)) as GeneratedSlideContent;

    expect(result.elements.length).toBeGreaterThanOrEqual(5);
    expect(textContent(result)).toContain('Build a Pi Agent Application');
  });

  it('keeps a compact valid model layout', async () => {
    const aiCall: AICallFn = async () => JSON.stringify(validCompactLayout());

    const result = (await generateSceneContent(outline, aiCall)) as GeneratedSlideContent;

    expect(textContent(result)).toContain('VALID-LAYOUT-SENTINEL');
  });

  it('normalizes a missing shape viewBox to the DSL width-height tuple', async () => {
    const layout = validCompactLayout('SHAPE-DEFAULT-SENTINEL');
    delete (layout.elements[1] as Record<string, unknown>).viewBox;
    const aiCall: AICallFn = async () => JSON.stringify(layout);

    const result = (await generateSceneContent(outline, aiCall)) as GeneratedSlideContent;
    const shape = result.elements.find(
      (element) => element.type === 'shape' && element.fill === '#FFFFFF',
    );

    expect(textContent(result)).toContain('SHAPE-DEFAULT-SENTINEL');
    expect(shape).toMatchObject({ viewBox: [400, 280] });
  });

  it('rejects a shape with a malformed viewBox before rendering', async () => {
    const layout = validCompactLayout('MALFORMED-SHAPE-SENTINEL');
    (layout.elements[1] as Record<string, unknown>).viewBox = '0 0 1 1';
    const aiCall: AICallFn = async () => JSON.stringify(layout);

    const result = (await generateSceneContent(outline, aiCall)) as GeneratedSlideContent;

    expect(textContent(result)).not.toContain('MALFORMED-SHAPE-SENTINEL');
    expect(textContent(result)).toContain('Build a Pi Agent Application');
  });

  it('rejects a title-only response as visually incomplete', async () => {
    const aiCall: AICallFn = async () =>
      JSON.stringify({
        elements: [
          {
            id: 'title',
            type: 'text',
            left: 60,
            top: 60,
            width: 880,
            height: 70,
            content: '<p style="font-size:34px;">TITLE-ONLY-SENTINEL</p>',
            defaultFontName: 'Microsoft YaHei',
            defaultColor: '#111827',
          },
        ],
      });

    const result = (await generateSceneContent(outline, aiCall)) as GeneratedSlideContent;

    expect(textContent(result)).not.toContain('TITLE-ONLY-SENTINEL');
    expect(result.elements.length).toBeGreaterThanOrEqual(5);
  });

  it('uses a process fallback instead of a card grid', async () => {
    const processOutline: SceneOutline = {
      ...outline,
      id: 'process-slide',
      title: 'API Request Workflow',
      slideIntent: 'process',
    };
    const aiCall: AICallFn = async () => '{"elements":[';

    const result = (await generateSceneContent(processOutline, aiCall)) as GeneratedSlideContent;
    const markerCount = result.elements.filter(
      (element) =>
        element.type === 'shape' &&
        String((element as { path?: string }).path || '').includes('A 0.5 0.5'),
    ).length;

    expect(markerCount).toBeGreaterThanOrEqual(3);
    expect(result.elements.some((element) => element.type === 'line')).toBe(true);
  });

  it('uses deck context and a deterministic layout variant in the prompt', async () => {
    let userPrompt = '';
    const allOutlines: SceneOutline[] = [
      { ...outline, id: 'cover', order: 1, slideIntent: 'cover' },
      { ...outline, id: 'process', order: 2, slideIntent: 'process' },
      { ...outline, id: 'summary', order: 3, slideIntent: 'summary' },
    ];
    const aiCall: AICallFn = async (_system, user) => {
      userPrompt = user;
      return JSON.stringify(validCompactLayout('DECK-CONTEXT-SENTINEL'));
    };

    await generateSceneContent(allOutlines[1], aiCall, { allOutlines });

    expect(userPrompt).toContain('Page 2 of 3');
    expect(userPrompt).toContain('Semantic intent: process');
    expect(userPrompt).toContain('Selected layout variant: zigzag-handoffs');
    expect(userPrompt).toContain('previous slide intent: cover');
    expect(userPrompt).toContain('next slide intent: summary');
  });

  it('rejects malformed chart data before rendering', async () => {
    const malformed = validCompactLayout('MALFORMED-CHART-SENTINEL');
    malformed.elements[1] = {
      id: 'bad_chart',
      type: 'chart',
      left: 60,
      top: 160,
      width: 400,
      height: 280,
      chartType: 'line',
      data: { labels: ['A', 'B'], legends: ['Value'], series: [[1]] },
      themeColors: ['#0F766E'],
    };
    const aiCall: AICallFn = async () => JSON.stringify(malformed);

    const result = (await generateSceneContent(outline, aiCall)) as GeneratedSlideContent;

    expect(textContent(result)).not.toContain('MALFORMED-CHART-SENTINEL');
  });

  it('uses a compact slide prompt', async () => {
    let systemPrompt = '';
    const aiCall: AICallFn = async (system) => {
      systemPrompt = system;
      return JSON.stringify(validCompactLayout('Compact'));
    };

    await generateSceneContent(outline, aiCall);

    expect(systemPrompt.length).toBeLessThan(12_000);
    expect(systemPrompt).toContain('Target 6-14 total elements');
    expect(systemPrompt).toContain('Never overlap text');
    expect(systemPrompt).toContain('ChartElement');
    expect(systemPrompt).toContain('TableElement');
    expect(systemPrompt).toContain('CodeElement');
  });
});
