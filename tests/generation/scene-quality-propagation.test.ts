import { describe, expect, it } from 'vitest';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import { buildCompleteScene } from '@/lib/generation/scene-builder';
import { createSceneWithActions } from '@/lib/generation/scene-generator';
import type { GeneratedSlideContent, SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

const outline: SceneOutline = {
  id: 'quality-outline',
  type: 'slide',
  title: 'Quality provenance',
  description: 'Keep fallback provenance on the final scene.',
  keyPoints: ['candidate', 'degraded'],
  order: 1,
};

const degradedContent: GeneratedSlideContent = {
  elements: [],
  quality: {
    status: 'degraded',
    issues: ['model response was incomplete'],
  },
};

describe('scene quality propagation', () => {
  it('copies generated slide quality onto buildCompleteScene output', () => {
    const scene = buildCompleteScene(outline, degradedContent, [], 'stage-1');

    expect(scene?.quality).toEqual(degradedContent.quality);
  });

  it('persists generated slide quality through createSceneWithActions', () => {
    const stage: Stage = {
      id: 'stage-1',
      name: 'Quality stage',
      createdAt: 1,
      updatedAt: 1,
    };
    let state: ReturnType<StageStore['getState']> = {
      stage,
      scenes: [] as Scene[],
      currentSceneId: null,
      mode: 'playback',
    };
    const store: StageStore = {
      getState: () => state,
      setState: (partial) => {
        state = { ...state, ...partial };
      },
      subscribe: () => () => undefined,
    };

    const sceneId = createSceneWithActions(outline, degradedContent, [], createStageAPI(store));

    expect(sceneId).toBeTruthy();
    expect(state.scenes).toHaveLength(1);
    expect(state.scenes[0].quality).toEqual(degradedContent.quality);
  });

  it('defaults unmarked slide content to candidate provenance', () => {
    const scene = buildCompleteScene(outline, { elements: [] }, [], 'stage-1');

    expect(scene?.quality).toEqual({ status: 'candidate', issues: [] });
  });
});
