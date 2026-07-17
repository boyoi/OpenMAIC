import { describe, expect, it } from 'vitest';

import { createRetryGenerationSession } from '@/app/generation-preview/retry-session';
import type { GenerationSessionState } from '@/app/generation-preview/types';

describe('generation preview retry session', () => {
  it('preserves user inputs and parsed PDF data while clearing generated state', () => {
    const failed: GenerationSessionState = {
      sessionId: 'failed-attempt',
      requirements: { requirement: 'Teach ALSC', webSearch: true },
      pdfText: 'parsed source',
      pdfImages: [{ id: 'pdf-1', src: '', pageNumber: 1, storageId: 'image-1' }],
      imageStorageIds: ['image-1'],
      pdfFileName: 'source.pdf',
      pdfProviderId: 'native',
      sceneOutlines: [
        {
          id: 'outline-1',
          title: 'Partial',
          description: '',
          keyPoints: [],
          order: 1,
          type: 'slide',
        },
      ],
      researchContext: 'stale research',
      researchSources: [{ title: 'stale', url: 'https://example.com' }],
      languageDirective: 'stale language',
      courseTitle: 'stale title',
      taskEngineMode: true,
      currentStep: 'generating',
      previewPhase: 'failed',
      failureMessage: 'upstream disconnected',
    };

    expect(createRetryGenerationSession(failed, 'retry-attempt')).toEqual({
      sessionId: 'retry-attempt',
      requirements: failed.requirements,
      pdfText: 'parsed source',
      pdfImages: failed.pdfImages,
      imageStorageIds: ['image-1'],
      imageMapping: undefined,
      pdfStorageKey: undefined,
      pdfFileName: 'source.pdf',
      pdfProviderId: 'native',
      pdfProviderConfig: undefined,
      sceneOutlines: null,
      currentStep: 'generating',
      previewPhase: 'preparing',
    });
  });
});
