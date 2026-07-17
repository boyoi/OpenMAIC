import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  generateMediaForClassroom: vi.fn(),
  replaceMediaPlaceholders: vi.fn(),
  generateTTSForClassroom: vi.fn(),
  persistClassroom: vi.fn(),
  callLLM: vi.fn(),
  collectStreamedLLMText: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/providers', () => ({
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
  collectStreamedLLMText: mocks.collectStreamedLLMText,
}));

vi.mock('@/lib/generation/outline-generator', () => ({
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
}));

vi.mock('@/lib/generation/scene-generator', () => ({
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
  createSceneWithActions: mocks.createSceneWithActions,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  persistClassroom: mocks.persistClassroom,
}));

vi.mock('@/lib/server/classroom-media-generation', () => ({
  generateMediaForClassroom: mocks.generateMediaForClassroom,
  replaceMediaPlaceholders: mocks.replaceMediaPlaceholders,
  generateTTSForClassroom: mocks.generateTTSForClassroom,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Basics',
  description: 'Explain retries',
  keyPoints: ['Retry transient failures'],
  order: 1,
} as const;

const secondOutline = {
  ...outline,
  id: 'outline-2',
  title: 'Retry Advanced',
  order: 2,
} as const;

const slideContent = {
  elements: [],
  remark: 'Retry transient failures',
};

async function generateWithProgress(
  input: GenerateClassroomInput = { requirement: 'Teach retry basics' },
) {
  const progress: Array<{ message: string }> = [];
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  const result = await generateClassroom(input, {
    baseUrl: 'http://localhost',
    onProgress: (event) => {
      progress.push({ message: event.message });
    },
  });
  return { result, progress };
}

describe('classroom scene generation retries', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.collectStreamedLLMText.mockResolvedValue('ok');
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'Use English.',
        outlines: [outline],
      },
    });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.generateMediaForClassroom.mockResolvedValue({});
    mocks.generateTTSForClassroom.mockResolvedValue({ attempted: 0, generated: 0, failed: 0 });
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const sceneResult = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: content.elements,
          },
        },
        actions,
        quality: content.quality,
      });
      return sceneResult.success ? (sceneResult.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, scenes }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
      scenesCount: scenes.length,
      createdAt: '2026-06-22T00:00:00.000Z',
    }));
  });

  it('retries an empty scene content result before completing the scene', async () => {
    mocks.generateSceneContent.mockResolvedValueOnce(null).mockResolvedValueOnce(slideContent);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
      true,
    );
  });

  it('retries degraded scene content before creating the scene', async () => {
    mocks.generateSceneContent
      .mockResolvedValueOnce({
        ...slideContent,
        quality: { status: 'degraded', issues: ['model response was incomplete'] },
      })
      .mockResolvedValueOnce(slideContent);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
    expect(mocks.createSceneWithActions).toHaveBeenCalledTimes(1);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
      true,
    );
  });

  it('retries provider-side stream aborts for scene content and actions', async () => {
    const streamAbort = Object.assign(new Error('LLM stream was aborted'), {
      name: 'AbortError',
    });
    mocks.generateSceneContent
      .mockRejectedValueOnce(streamAbort)
      .mockResolvedValueOnce(slideContent);
    mocks.generateSceneActions.mockRejectedValueOnce(streamAbort).mockResolvedValueOnce([]);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
      true,
    );
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 actions'))).toBe(
      true,
    );
  });

  it('forwards classroom thinking config to scene retry LLM calls', async () => {
    const thinkingConfig = { enabled: true, effort: 'high' };
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
      thinkingConfig,
    });
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return slideContent;
    });

    await generateWithProgress();

    expect(mocks.collectStreamedLLMText).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0 }),
      'generate-classroom-scene',
      thinkingConfig,
    );
  });

  it('retries retryable action generation errors', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }))
      .mockResolvedValueOnce([]);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 actions'))).toBe(
      true,
    );
  });

  it('does not retry non-retryable action generation errors', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockRejectedValue(unauthorized);

    await expect(generateWithProgress()).rejects.toBe(unauthorized);

    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(1);
  });

  it('does not persist a partial classroom when a later scene content generation fails', async () => {
    const contentError = Object.assign(new Error('invalid scene request'), { statusCode: 401 });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'Use English.',
        outlines: [outline, secondOutline],
      },
    });
    mocks.generateSceneContent
      .mockResolvedValueOnce(slideContent)
      .mockRejectedValueOnce(contentError);

    await expect(generateWithProgress()).rejects.toBe(contentError);

    expect(mocks.createSceneWithActions).toHaveBeenCalledTimes(1);
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('fails the classroom when scene creation fails', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.createSceneWithActions.mockReturnValue(null);

    await expect(generateWithProgress()).rejects.toThrow('Scene creation failed: Retry Basics');

    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('fails the classroom when the final scene count does not match the outlines', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.createSceneWithActions.mockReturnValue('scene-not-added-to-store');

    await expect(generateWithProgress()).rejects.toThrow(
      'Incomplete classroom generation: generated 0/1 scenes',
    );

    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('fails before scene creation when degraded content exhausts retries', async () => {
    vi.useFakeTimers();
    mocks.generateSceneContent.mockResolvedValue({
      ...slideContent,
      quality: { status: 'degraded', issues: ['model response was incomplete'] },
    });

    try {
      const settled = generateWithProgress().then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      const { error } = await settled;

      expect(error).toEqual(
        new Error(
          'Scene content quality validation failed after retries: Retry Basics: model response was incomplete',
        ),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(6);
    expect(mocks.createSceneWithActions).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('does not persist when the enabled media phase throws', async () => {
    const mediaError = new Error('image provider unavailable');
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateMediaForClassroom.mockRejectedValue(mediaError);

    await expect(
      generateWithProgress({ requirement: 'Teach retry basics', enableImageGeneration: true }),
    ).rejects.toBe(mediaError);

    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('does not persist when enabled media requests are only partially generated', async () => {
    const outlineWithMedia = {
      ...outline,
      mediaGenerations: [
        {
          elementId: 'gen_img_1',
          type: 'image' as const,
          prompt: 'A retry flow diagram',
          aspectRatio: '16:9',
        },
      ],
    };
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'Use English.',
        outlines: [outlineWithMedia],
      },
    });
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateMediaForClassroom.mockResolvedValue({});

    await expect(
      generateWithProgress({ requirement: 'Teach retry basics', enableImageGeneration: true }),
    ).rejects.toThrow('Media generation incomplete: missing 1/1 files (gen_img_1)');

    expect(mocks.replaceMediaPlaceholders).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('does not persist when enabled TTS is skipped', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateTTSForClassroom.mockResolvedValue({
      attempted: 0,
      generated: 0,
      failed: 0,
      skippedReason: 'no server TTS provider configured',
    });

    await expect(
      generateWithProgress({ requirement: 'Teach retry basics', enableTTS: true }),
    ).rejects.toThrow('TTS generation skipped: no server TTS provider configured');

    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('does not persist when speech exists but TTS attempts none', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockResolvedValue([
      { id: 'speech-1', type: 'speech', text: 'Explain retry behavior.' },
    ]);
    mocks.generateTTSForClassroom.mockResolvedValue({ attempted: 0, generated: 0, failed: 0 });

    await expect(
      generateWithProgress({ requirement: 'Teach retry basics', enableTTS: true }),
    ).rejects.toThrow('TTS generation incomplete: no speech actions were attempted');

    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('does not persist when TTS is only partially generated', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockResolvedValue([
      { id: 'speech-1', type: 'speech', text: 'Explain retry behavior.' },
    ]);
    mocks.generateTTSForClassroom.mockResolvedValue({ attempted: 2, generated: 1, failed: 1 });

    await expect(
      generateWithProgress({ requirement: 'Teach retry basics', enableTTS: true }),
    ).rejects.toThrow('TTS generation incomplete: generated 1/2 audio files');

    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('does not persist when the enabled TTS phase throws', async () => {
    const ttsError = new Error('TTS provider unavailable');
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateTTSForClassroom.mockRejectedValue(ttsError);

    await expect(
      generateWithProgress({ requirement: 'Teach retry basics', enableTTS: true }),
    ).rejects.toBe(ttsError);

    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('allows enabled TTS with zero attempts when no scene contains speech', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateTTSForClassroom.mockResolvedValue({ attempted: 0, generated: 0, failed: 0 });

    const { result } = await generateWithProgress({
      requirement: 'Teach retry basics',
      enableTTS: true,
    });

    expect(result.scenesCount).toBe(1);
    expect(mocks.persistClassroom).toHaveBeenCalledOnce();
  });
});
