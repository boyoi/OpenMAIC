import { describe, expect, it } from 'vitest';
import {
  claimSceneFeedbackIntent,
  getSceneFeedbackKind,
  MAX_SCENE_FEEDBACK_LENGTH,
  sanitizeSceneFeedbackReport,
  type SceneFeedbackIntent,
} from '@/lib/agent/client/scene-feedback';
import type { Scene } from '@/lib/types/stage';

function feedbackScene(
  type: Scene['type'],
  content: Scene['content'],
): Pick<Scene, 'type' | 'content'> {
  return { type, content };
}

describe('scene feedback availability', () => {
  it('supports inline interactive pages', () => {
    expect(
      getSceneFeedbackKind(
        feedbackScene('interactive', {
          type: 'interactive',
          url: '',
          html: '<html><body><button>Start</button></body></html>',
        }),
      ),
    ).toBe('interactive');
  });

  it('does not promise AI repair for URL-only interactive pages', () => {
    expect(
      getSceneFeedbackKind(
        feedbackScene('interactive', { type: 'interactive', url: 'https://example.com' }),
      ),
    ).toBeNull();
  });

  it('supports slides but not quiz or PBL scenes', () => {
    expect(
      getSceneFeedbackKind(
        feedbackScene('slide', {
          type: 'slide',
          canvas: { id: 'c', viewportSize: 1000, viewportRatio: 0.5625, elements: [] },
        } as unknown as Scene['content']),
      ),
    ).toBe('slide');
    expect(
      getSceneFeedbackKind(
        feedbackScene('quiz', { type: 'quiz', questions: [] } as Scene['content']),
      ),
    ).toBeNull();
    expect(getSceneFeedbackKind(null)).toBeNull();
  });

  it('does not offer whole-slide repair when regeneration would drop protected media', () => {
    const baseCanvas = {
      id: 'c',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {},
      elements: [],
    };
    expect(
      getSceneFeedbackKind(
        feedbackScene('slide', {
          type: 'slide',
          canvas: {
            ...baseCanvas,
            elements: [{ id: 'video-1', type: 'video' }],
          },
        } as unknown as Scene['content']),
      ),
    ).toBeNull();
    expect(
      getSceneFeedbackKind(
        feedbackScene('slide', {
          type: 'slide',
          canvas: {
            ...baseCanvas,
            background: { type: 'image', image: { src: 'https://example.com/bg.png' } },
          },
        } as unknown as Scene['content']),
      ),
    ).toBeNull();
  });
});

describe('scene feedback intent', () => {
  const intent: SceneFeedbackIntent = {
    id: 'feedback-1',
    sceneId: 'scene-a',
    prompt: 'Fix this page',
  };

  it('freezes the target scene and can only be claimed once', () => {
    const consumed = new Set<string>();
    expect(claimSceneFeedbackIntent(intent, 'scene-b', consumed)).toBe(false);
    expect(consumed.size).toBe(0);
    expect(claimSceneFeedbackIntent(intent, 'scene-a', consumed)).toBe(true);
    expect(claimSceneFeedbackIntent(intent, 'scene-a', consumed)).toBe(false);
  });

  it('trims and bounds user reports before interpolation', () => {
    expect(sanitizeSceneFeedbackReport('  button does nothing  ')).toBe('button does nothing');
    expect(sanitizeSceneFeedbackReport('x'.repeat(MAX_SCENE_FEEDBACK_LENGTH + 50))).toHaveLength(
      MAX_SCENE_FEEDBACK_LENGTH,
    );
  });
});
