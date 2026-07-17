import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { validateExportSnapshot, validatePptxBlob } from '@/lib/export/pptx-validation';
import {
  createDefaultShapeElement,
  createDefaultSlide,
  createDefaultTextElement,
} from '@/lib/edit/slide-edit-elements';
import type { Scene } from '@/lib/types/stage';

function slideScene(overrides: Partial<Scene> = {}): Scene {
  const slide = createDefaultSlide('slide-1');
  const text = createDefaultTextElement('text-1');
  text.content = '<p>Validated content</p>';
  slide.elements.push(text, createDefaultShapeElement('shape-1'));
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Validated slide',
    order: 1,
    content: { type: 'slide', canvas: slide },
    ...overrides,
  } as Scene;
}

describe('PPTX export validation', () => {
  it('accepts a structurally valid completed slide deck', () => {
    expect(
      validateExportSnapshot({
        scenes: [slideScene()],
        generationComplete: true,
        hasOutlines: true,
      }),
    ).toEqual([]);
  });

  it('rejects incomplete and degraded decks', () => {
    const scene = slideScene({
      quality: { status: 'degraded', issues: ['model response was incomplete'] },
    } as Partial<Scene>);
    const issues = validateExportSnapshot({
      scenes: [scene],
      generationComplete: false,
      hasOutlines: true,
    });

    expect(issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(['DECK_NOT_COMPLETE', 'DEGRADED_SCENE']),
    );
  });

  it('rejects invalid backgrounds, shape paths, and dense tiny text boxes', () => {
    const scene = slideScene();
    if (scene.content.type !== 'slide') throw new Error('expected slide');
    scene.content.canvas.background = {
      type: 'gradient',
      gradient: { type: 'linear', colors: [], rotate: 0 },
    };
    const shape = scene.content.canvas.elements.find((element) => element.type === 'shape');
    if (shape?.type === 'shape') shape.path = 'NOT_A_PATH';
    const text = scene.content.canvas.elements.find((element) => element.type === 'text');
    if (text?.type === 'text') {
      text.width = 20;
      text.height = 20;
      text.content = `<p>${'x'.repeat(300)}</p>`;
    }

    const issues = validateExportSnapshot({
      scenes: [scene],
      generationComplete: true,
      hasOutlines: true,
    });
    expect(issues.filter((item) => item.code === 'INVALID_ELEMENT').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(issues.some((item) => item.message.includes('gradient'))).toBe(true);
  });

  it('rejects substantially overlapping text boxes', () => {
    const scene = slideScene();
    if (scene.content.type !== 'slide') throw new Error('expected slide');
    const overlapping = createDefaultTextElement('text-overlap');
    overlapping.content = '<p>Overlapping content</p>';
    overlapping.left = 0;
    overlapping.top = 0;
    const firstText = scene.content.canvas.elements.find((element) => element.type === 'text');
    if (firstText?.type !== 'text') throw new Error('expected text element');
    firstText.left = 0;
    firstText.top = 0;
    scene.content.canvas.elements.push(overlapping);

    const issues = validateExportSnapshot({
      scenes: [scene],
      generationComplete: true,
      hasOutlines: true,
    });

    expect(issues.some((item) => item.message.includes('overlap'))).toBe(true);
  });

  it('rejects unresolved generated media and captured interactive runtime errors', () => {
    const scene = slideScene();
    if (scene.content.type !== 'slide') throw new Error('expected slide');
    scene.content.canvas.elements.push({
      id: 'image-1',
      type: 'image',
      left: 20,
      top: 20,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
      src: 'gen_img_pending',
    });
    const interactive: Scene = {
      id: 'interactive-1',
      stageId: 'stage-1',
      type: 'interactive',
      title: 'Broken interaction',
      order: 2,
      content: { type: 'interactive', url: '', html: '<html><body>Widget</body></html>' },
    };
    const issues = validateExportSnapshot({
      scenes: [scene, interactive],
      generationComplete: true,
      hasOutlines: true,
      mediaTasks: { gen_img_pending: { status: 'failed', error: 'provider failed' } },
      runtimeErrors: { 'interactive-1': ['ReferenceError: app is not defined'] },
    });

    expect(issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(['MISSING_MEDIA', 'INTERACTIVE_RUNTIME_ERROR']),
    );
  });

  it('validates PPTX page count and internal relationships', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(
      '_rels/.rels',
      '<Relationships><Relationship Id="rId1" Target="ppt/presentation.xml"/></Relationships>',
    );
    zip.file('ppt/presentation.xml', '<p:presentation/>');
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
    );
    zip.file('ppt/slides/slide1.xml', '<p:sld></p:sld>');
    const blob = await zip.generateAsync({ type: 'blob' });

    await expect(validatePptxBlob(blob, 1)).resolves.toEqual([]);
    const mismatch = await validatePptxBlob(blob, 2);
    expect(mismatch.some((item) => item.code === 'PPTX_PAGE_MISMATCH')).toBe(true);
  });

  it('rejects PPTX relationships that point to missing entries', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('_rels/.rels', '<Relationships/>');
    zip.file('ppt/presentation.xml', '<p:presentation/>');
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="slides/missing.xml"/></Relationships>',
    );
    const blob = await zip.generateAsync({ type: 'blob' });
    const issues = await validatePptxBlob(blob, 0);

    expect(issues.some((item) => item.code === 'PPTX_RELATIONSHIP_MISSING')).toBe(true);
  });
});
