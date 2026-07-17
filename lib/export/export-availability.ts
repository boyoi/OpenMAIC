import type { MediaTaskStatus } from '@/lib/store/media-generation';

type GenerationStatus = 'idle' | 'generating' | 'paused' | 'completed' | 'error';

interface ExportableScene {
  content: {
    type: string;
  };
}

interface ExportAvailabilityInput {
  scenes: readonly ExportableScene[];
  generatingOutlineCount: number;
  failedOutlineCount: number;
  generationStatus: GenerationStatus;
  mediaTaskStatuses: readonly MediaTaskStatus[];
}

export interface ExportAvailability {
  canOpenMenu: boolean;
  canExportPPTX: boolean;
  canExportResourcePack: boolean;
  canExportClassroomZip: boolean;
  isPartial: boolean;
}

/**
 * Scene objects enter the stage store only after their content, actions, and
 * TTS step finish, so existing scenes remain exportable when later work stalls.
 */
export function getExportAvailability({
  scenes,
  generatingOutlineCount,
  failedOutlineCount,
  generationStatus,
  mediaTaskStatuses,
}: ExportAvailabilityInput): ExportAvailability {
  const hasScenes = scenes.length > 0;
  const hasSlides = scenes.some((scene) => scene.content.type === 'slide');
  const hasInteractiveScenes = scenes.some((scene) => scene.content.type === 'interactive');
  const hasIncompleteGeneration =
    generatingOutlineCount > 0 ||
    failedOutlineCount > 0 ||
    generationStatus === 'generating' ||
    generationStatus === 'paused' ||
    generationStatus === 'error';
  const hasIncompleteMedia = mediaTaskStatuses.some((status) => status !== 'done');

  return {
    canOpenMenu: hasScenes,
    canExportPPTX: hasSlides || hasInteractiveScenes,
    canExportResourcePack: hasSlides || hasInteractiveScenes,
    canExportClassroomZip: hasScenes,
    isPartial: hasIncompleteGeneration || hasIncompleteMedia,
  };
}
