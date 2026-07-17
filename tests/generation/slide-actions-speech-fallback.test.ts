import { describe, expect, it } from 'vitest';

import { generateSceneActions } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { GeneratedSlideContent, SceneOutline } from '@/lib/types/generation';

const outline: SceneOutline = {
  id: 'scene-slide-actions',
  type: 'slide',
  title: '可验证输出',
  description: '解释如何确认 API 调用成功。',
  keyPoints: ['检查状态码', '读取返回字段'],
  order: 1,
};

const content: GeneratedSlideContent = {
  elements: [
    {
      id: 'text_1',
      type: 'text',
      left: 60,
      top: 60,
      width: 400,
      height: 80,
      content: '<p>检查状态码</p>',
      defaultFontName: 'Microsoft YaHei',
      defaultColor: '#17212B',
      rotate: 0,
    },
  ],
  remark: '检查状态码并读取返回字段。',
};

describe('slide action narration fallback', () => {
  it('preserves visual actions and adds usable speech when the model omits narration', async () => {
    const aiCall: AICallFn = async () =>
      JSON.stringify([
        {
          type: 'action',
          name: 'spotlight',
          params: { elementId: 'text_1' },
        },
      ]);

    const actions = await generateSceneActions(outline, content, aiCall);

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'spotlight', elementId: 'text_1' }),
        expect.objectContaining({
          type: 'speech',
          text: expect.stringContaining('检查状态码'),
        }),
      ]),
    );
  });

  it('replaces empty speech with usable fallback narration', async () => {
    const aiCall: AICallFn = async () => JSON.stringify([{ type: 'text', content: '   ' }]);

    const actions = await generateSceneActions(outline, content, aiCall);
    const speech = actions.filter((action) => action.type === 'speech');

    expect(speech).toHaveLength(1);
    expect(speech[0]).toMatchObject({ text: expect.stringContaining('读取返回字段') });
  });
});
