import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  ClassroomExportValidationError,
  assertClassroomExportValid,
  validateClassroomInlineFailures,
  validateClassroomManifest,
  validateClassroomScenes,
  validateClassroomZipBlob,
} from '@/lib/export/classroom-zip-validation';
import {
  CLASSROOM_ZIP_FORMAT_VERSION,
  type ClassroomManifest,
} from '@/lib/export/classroom-zip-types';
import type { Scene, SceneContent } from '@/lib/types/stage';

function scene(id: string, order: number, content: SceneContent): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: content.type,
    title: id,
    order,
    content,
  } as Scene;
}

function manifest(overrides: Partial<ClassroomManifest> = {}): ClassroomManifest {
  return {
    formatVersion: CLASSROOM_ZIP_FORMAT_VERSION,
    exportedAt: new Date(0).toISOString(),
    appVersion: '1.0.0',
    stage: {
      name: 'Validated classroom',
      createdAt: 1,
      updatedAt: 2,
    },
    agents: [],
    scenes: [
      {
        type: 'quiz',
        title: 'Knowledge check',
        order: 1,
        content: { type: 'quiz', questions: [] } as SceneContent,
      },
      {
        type: 'pbl',
        title: 'Project',
        order: 2,
        content: { type: 'pbl', projectConfig: {} } as SceneContent,
        actions: [
          {
            id: 'speech-1',
            type: 'speech',
            text: 'Start the project',
            audioRef: 'audio/tts-1.mp3',
          },
        ],
      },
    ],
    mediaIndex: {
      'audio/tts-1.mp3': { type: 'audio', format: 'mp3' },
    },
    ...overrides,
  } as ClassroomManifest;
}

async function classroomBlob(
  value: ClassroomManifest,
  files: Record<string, string | Uint8Array> = {},
): Promise<Blob> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(value));
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'blob' });
}

describe('classroom ZIP export validation', () => {
  it('allows complete quiz and PBL scenes', () => {
    const scenes = [
      scene('quiz-1', 1, { type: 'quiz', questions: [] } as SceneContent),
      scene('pbl-1', 2, { type: 'pbl', projectConfig: {} } as SceneContent),
    ];

    expect(validateClassroomScenes(scenes)).toEqual([]);
    expect(validateClassroomManifest(manifest(), { expectedSceneCount: 2 })).toEqual([]);
  });

  it('rejects degraded scenes before packaging', () => {
    const degraded = scene('slide-1', 1, {
      type: 'slide',
      canvas: { id: 'slide-1', elements: [] },
    } as unknown as SceneContent);
    degraded.quality = { status: 'degraded', issues: ['model output was truncated'] };

    const issues = validateClassroomScenes([degraded]);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'DEGRADED_SCENE', sceneId: 'slide-1' }),
    );
    expect(() => assertClassroomExportValid(issues)).toThrow(ClassroomExportValidationError);
  });

  it('rejects any interactive asset that could not be inlined', () => {
    const issues = validateClassroomInlineFailures([
      { sceneId: 'interactive-1', url: 'https://cdn.example.com/widget.js', reason: 'timeout' },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        code: 'INLINE_ASSET_FAILED',
        sceneId: 'interactive-1',
        resourcePath: 'https://cdn.example.com/widget.js',
      }),
    ]);
  });

  it('rejects speech without a packaged audioRef and generated media without an index entry', () => {
    const value = manifest({
      scenes: [
        {
          type: 'slide',
          title: 'Broken resources',
          order: 1,
          content: {
            type: 'slide',
            canvas: {
              id: 'slide-1',
              elements: [{ id: 'image-1', type: 'image', src: 'gen_img_missing' }],
            },
          } as SceneContent,
          actions: [
            { id: 'speech-1', type: 'speech', text: 'No TTS file' },
          ] as unknown as NonNullable<ClassroomManifest['scenes'][number]['actions']>,
        },
      ],
      mediaIndex: {},
    });

    const codes = validateClassroomManifest(value).map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(['MISSING_AUDIO', 'MISSING_MEDIA']));
  });

  it('accepts a ZIP only after every manifest resource can be read', async () => {
    const value = manifest();
    const blob = await classroomBlob(value, { 'audio/tts-1.mp3': new Uint8Array([1, 2, 3]) });

    await expect(validateClassroomZipBlob(blob, { expectedSceneCount: 2 })).resolves.toEqual([]);
  });

  it('rejects missing, empty, and unindexed ZIP resources', async () => {
    const value = manifest();
    const missingBlob = await classroomBlob(value);
    const missingIssues = await validateClassroomZipBlob(missingBlob);
    expect(missingIssues).toContainEqual(
      expect.objectContaining({ code: 'MISSING_AUDIO', resourcePath: 'audio/tts-1.mp3' }),
    );

    const emptyBlob = await classroomBlob(value, { 'audio/tts-1.mp3': new Uint8Array() });
    const emptyIssues = await validateClassroomZipBlob(emptyBlob);
    expect(emptyIssues).toContainEqual(
      expect.objectContaining({ code: 'MISSING_AUDIO', resourcePath: 'audio/tts-1.mp3' }),
    );

    const unindexedBlob = await classroomBlob(value, {
      'audio/tts-1.mp3': new Uint8Array([1]),
      'media/orphan.png': new Uint8Array([2]),
    });
    const unindexedIssues = await validateClassroomZipBlob(unindexedBlob);
    expect(unindexedIssues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_MANIFEST', resourcePath: 'media/orphan.png' }),
    );
  });

  it('rejects archives without a readable manifest', async () => {
    const zip = new JSZip();
    zip.file('unrelated.txt', 'no manifest');
    const blob = await zip.generateAsync({ type: 'blob' });

    await expect(validateClassroomZipBlob(blob)).resolves.toContainEqual(
      expect.objectContaining({ code: 'INVALID_CLASSROOM_ZIP' }),
    );
  });

  it('reports malformed manifest structures without throwing from the validator', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ scenes: [null], mediaIndex: null }));
    const blob = await zip.generateAsync({ type: 'blob' });

    await expect(validateClassroomZipBlob(blob)).resolves.toContainEqual(
      expect.objectContaining({ code: 'INVALID_MANIFEST' }),
    );
  });
});
