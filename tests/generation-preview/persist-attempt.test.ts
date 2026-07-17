import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSlide } from '@/lib/edit/slide-edit-elements';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  saveStageData: vi.fn(),
  putOutlines: vi.fn(),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: mocks.saveStageData,
}));

vi.mock('@/lib/utils/database', () => ({
  db: { stageOutlines: { put: mocks.putOutlines } },
}));

const stage: Stage = {
  id: 'stage-1',
  name: 'Retry-safe classroom',
  style: 'professional',
  createdAt: 1,
  updatedAt: 1,
};

const firstScene = {
  id: 'scene-1',
  stageId: stage.id,
  type: 'slide',
  title: 'Introduction',
  order: 1,
  content: { type: 'slide', canvas: createDefaultSlide('slide-1') },
  actions: [],
  createdAt: 1,
  updatedAt: 1,
} as Scene;

const outlines: SceneOutline[] = [
  {
    id: 'outline-1',
    type: 'slide',
    title: 'Introduction',
    description: '',
    keyPoints: [],
    order: 1,
  },
];

describe('persistInitialGenerationAttempt', () => {
  beforeEach(() => {
    mocks.saveStageData.mockReset().mockResolvedValue(undefined);
    mocks.putOutlines.mockReset().mockResolvedValue(undefined);
  });

  it('persists the normalized first scene before the complete outline plan', async () => {
    const { persistInitialGenerationAttempt } =
      await import('@/app/generation-preview/persist-attempt');

    const persisted = await persistInitialGenerationAttempt({ stage, firstScene, outlines });

    expect(persisted.content).toMatchObject({ type: 'slide', schemaVersion: 1 });
    expect(mocks.saveStageData).toHaveBeenCalledWith(stage.id, {
      stage,
      scenes: [persisted],
      currentSceneId: persisted.id,
      chats: [],
    });
    expect(mocks.putOutlines).toHaveBeenCalledWith(
      expect.objectContaining({
        stageId: stage.id,
        outlines,
        generationComplete: false,
      }),
    );
    expect(mocks.saveStageData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.putOutlines.mock.invocationCallOrder[0],
    );
  });

  it('rejects when the outline plan is not durable', async () => {
    mocks.putOutlines.mockRejectedValueOnce(new Error('quota exceeded'));
    const { persistInitialGenerationAttempt } =
      await import('@/app/generation-preview/persist-attempt');

    await expect(persistInitialGenerationAttempt({ stage, firstScene, outlines })).rejects.toThrow(
      'quota exceeded',
    );
  });
});
