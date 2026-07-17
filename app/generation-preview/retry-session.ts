import type { GenerationSessionState } from './types';

/**
 * Build a clean generation attempt from the user's original inputs.
 * Parsed PDF data is reusable source material; model-produced outlines,
 * research, titles, and mode decisions must be generated again.
 */
export function createRetryGenerationSession(
  failedSession: GenerationSessionState,
  nextSessionId: string,
): GenerationSessionState {
  return {
    sessionId: nextSessionId,
    requirements: failedSession.requirements,
    pdfText: failedSession.pdfText,
    pdfImages: failedSession.pdfImages,
    imageStorageIds: failedSession.imageStorageIds,
    imageMapping: failedSession.imageMapping,
    pdfStorageKey: failedSession.pdfStorageKey,
    pdfFileName: failedSession.pdfFileName,
    pdfProviderId: failedSession.pdfProviderId,
    pdfProviderConfig: failedSession.pdfProviderConfig,
    sceneOutlines: null,
    currentStep: 'generating',
    previewPhase: 'preparing',
  };
}
