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

/** Export stays fail-closed until generation and every tracked media task finish. */
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
  const generationReady =
    (generationStatus === 'completed' || generationStatus === 'idle') &&
    generatingOutlineCount === 0 &&
    failedOutlineCount === 0;
  const mediaReady = mediaTaskStatuses.every((status) => status === 'done');
  const ready = generationReady && mediaReady;

  return {
    canOpenMenu: ready && hasScenes,
    canExportPPTX: ready && (hasSlides || hasInteractiveScenes),
    canExportResourcePack: ready && (hasSlides || hasInteractiveScenes),
    canExportClassroomZip: ready && hasScenes,
    isPartial: !ready,
  };
}
