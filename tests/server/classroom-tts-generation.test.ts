import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  generateTTS: vi.fn(),
  getServerTTSProviders: vi.fn(),
  resolveTTSApiKey: vi.fn(),
  resolveTTSBaseUrl: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: {
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
  },
}));

vi.mock('@/lib/audio/tts-providers', () => ({
  generateTTS: mocks.generateTTS,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  CLASSROOMS_DIR: '/tmp/openmaic-classroom-tts-test',
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerImageProviders: vi.fn(() => ({})),
  getServerVideoProviders: vi.fn(() => ({})),
  getServerTTSProviders: mocks.getServerTTSProviders,
  resolveImageApiKey: vi.fn(),
  resolveImageBaseUrl: vi.fn(),
  resolveVideoApiKey: vi.fn(),
  resolveVideoBaseUrl: vi.fn(),
  resolveTTSApiKey: mocks.resolveTTSApiKey,
  resolveTTSBaseUrl: mocks.resolveTTSBaseUrl,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function sceneWithActions(actions: Scene['actions']): Scene {
  return {
    id: 'scene_1',
    stageId: 'stage_1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas_1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [],
      },
    },
    actions,
  } as unknown as Scene;
}

describe('server classroom TTS generation', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getServerTTSProviders.mockReturnValue({ 'openai-tts': { disabled: false } });
    mocks.resolveTTSApiKey.mockReturnValue('managed-key');
    mocks.resolveTTSBaseUrl.mockReturnValue('http://tts.test/v1');
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it('reports zero attempts when a classroom contains no speech actions', async () => {
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');

    const result = await generateTTSForClassroom(
      [sceneWithActions([{ id: 'spotlight_1', type: 'spotlight', elementId: 'text_1' }])],
      'classroom_1',
      'https://example.test',
    );

    expect(result).toEqual({ attempted: 0, generated: 0, failed: 0 });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('attaches audio metadata and reports generated files', async () => {
    mocks.generateTTS.mockResolvedValue({ audio: Buffer.from('mp3-data'), format: 'mp3' });
    const speech = { id: 'speech_1', type: 'speech' as const, text: '你好，世界。' };
    const classroomScene = sceneWithActions([speech]);
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');

    const result = await generateTTSForClassroom(
      [classroomScene],
      'classroom_1',
      'https://example.test',
    );

    expect(result).toEqual({ attempted: 1, generated: 1, failed: 0 });
    expect(classroomScene.actions?.[0]).toMatchObject({
      audioId: expect.stringContaining('tts_s1_'),
      audioUrl: expect.stringContaining('/api/classroom-media/classroom_1/audio/'),
    });
    expect(mocks.writeFile).toHaveBeenCalledOnce();
  });

  it('fails the TTS phase when every speech action fails', async () => {
    mocks.generateTTS.mockRejectedValue(new Error('provider unavailable'));
    const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');

    await expect(
      generateTTSForClassroom(
        [sceneWithActions([{ id: 'speech_1', type: 'speech', text: '测试语音。' }])],
        'classroom_1',
        'https://example.test',
      ),
    ).rejects.toThrow('failed for all 1 speech actions');
  });
});
