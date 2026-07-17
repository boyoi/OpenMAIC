import { migrateScene } from '@/lib/edit/slide-schema';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

interface PersistInitialGenerationAttemptParams {
  stage: Stage;
  firstScene: Scene;
  outlines: SceneOutline[];
}

/** Persist the minimum complete classroom snapshot required for safe navigation. */
export async function persistInitialGenerationAttempt({
  stage,
  firstScene,
  outlines,
}: PersistInitialGenerationAttemptParams): Promise<Scene> {
  const persistedFirstScene = migrateScene(firstScene);
  const [{ saveStageData }, { db }] = await Promise.all([
    import('@/lib/utils/stage-storage'),
    import('@/lib/utils/database'),
  ]);

  await saveStageData(stage.id, {
    stage,
    scenes: [persistedFirstScene],
    currentSceneId: persistedFirstScene.id,
    chats: [],
  });

  const now = Date.now();
  await db.stageOutlines.put({
    stageId: stage.id,
    outlines,
    generationComplete: false,
    createdAt: now,
    updatedAt: now,
  });

  return persistedFirstScene;
}
