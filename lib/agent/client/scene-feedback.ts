import type { Scene } from '@/lib/types/stage';

export const MAX_SCENE_FEEDBACK_LENGTH = 1200;

export type SceneFeedbackKind = 'interactive' | 'slide';

export interface SceneFeedbackIntent {
  readonly id: string;
  readonly sceneId: string;
  readonly prompt: string;
}

function isRealImageSrc(src: unknown): src is string {
  return (
    typeof src === 'string' &&
    (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://'))
  );
}

/** Only expose feedback where the editor agent can make a real change. */
export function getSceneFeedbackKind(
  scene: Pick<Scene, 'type' | 'content'> | null | undefined,
): SceneFeedbackKind | null {
  if (!scene) return null;
  if (scene.type === 'slide' && scene.content.type === 'slide') {
    const elements = scene.content.canvas.elements ?? [];
    const hasVideo = elements.some((element) => element?.type === 'video');
    const background = scene.content.canvas.background;
    const hasImageBackground =
      background?.type === 'image' && isRealImageSrc(background.image?.src);
    return hasVideo || hasImageBackground ? null : 'slide';
  }
  if (
    scene.type === 'interactive' &&
    scene.content.type === 'interactive' &&
    typeof scene.content.html === 'string' &&
    scene.content.html.trim().length > 0
  ) {
    return 'interactive';
  }
  return null;
}

export function sanitizeSceneFeedbackReport(report: string): string {
  return report.trim().slice(0, MAX_SCENE_FEEDBACK_LENGTH);
}

/** Claim an auto-submit exactly once and only on the scene it was created for. */
export function claimSceneFeedbackIntent(
  intent: SceneFeedbackIntent | null | undefined,
  activeSceneId: string,
  consumedIds: Set<string>,
): intent is SceneFeedbackIntent {
  if (!intent || intent.sceneId !== activeSceneId || consumedIds.has(intent.id)) return false;
  consumedIds.add(intent.id);
  return true;
}
