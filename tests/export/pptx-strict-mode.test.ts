import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import {
  createDefaultImageElement,
  createDefaultShapeElement,
} from '@/lib/edit/slide-edit-elements';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { PPTAudioElement, PPTLatexElement, PPTVideoElement, Slide } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';
import {
  makeSlideFixture,
  RATIO_PX2_INCH,
  RATIO_PX2_PT,
  VIEWPORT_RATIO,
  VIEWPORT_SIZE,
} from '../edit/round-trip/fixtures';

function exportFixture(slide: Slide, scene: Scene, strict = true): Promise<Blob> {
  return buildPptxBlob(
    [slide],
    [scene],
    VIEWPORT_RATIO,
    VIEWPORT_SIZE,
    RATIO_PX2_INCH,
    RATIO_PX2_PT,
    { strict },
  );
}

describe('PPTX strict export mode', () => {
  beforeEach(() => useMediaGenerationStore.setState({ tasks: {} }));

  afterEach(() => {
    vi.unstubAllGlobals();
    useMediaGenerationStore.setState({ tasks: {} });
  });

  it('keeps legacy omission behavior when strict mode is disabled', async () => {
    const { slide, scene } = makeSlideFixture();
    slide.elements.push(createDefaultImageElement('img-pending', 'gen_img_pending'));

    const blob = await exportFixture(slide, scene, false);

    expect(blob.size).toBeGreaterThan(0);
  });

  it('rejects an unresolved generated-image placeholder with page and element context', async () => {
    const { slide, scene } = makeSlideFixture();
    slide.elements.push(createDefaultImageElement('img-pending', 'gen_img_pending'));

    await expect(exportFixture(slide, scene)).rejects.toThrow(
      /page 1, slide "slide-1", image element "img-pending".*gen_img_pending.*not ready/i,
    );
  });

  it('rejects an image fetch failure instead of dropping the image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const { slide, scene } = makeSlideFixture();
    slide.elements.push(createDefaultImageElement('img-http', 'https://example.com/image.png'));

    await expect(exportFixture(slide, scene)).rejects.toThrow(
      /image element "img-http".*failed to fetch image.*HTTP 503/i,
    );
  });

  it('rejects an empty image response instead of embedding a zero-byte asset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Blob([], { type: 'image/png' }), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    );
    const { slide, scene } = makeSlideFixture();
    slide.elements.push(createDefaultImageElement('img-empty', 'https://example.com/empty.png'));

    await expect(exportFixture(slide, scene)).rejects.toThrow(
      /image element "img-empty".*image source returned an empty file/i,
    );
  });

  it('rejects a malformed shape path instead of omitting the shape', async () => {
    const { slide, scene } = makeSlideFixture();
    const shape = createDefaultShapeElement('shape-bad-path');
    shape.path = 'THIS IS NOT SVG PATH DATA';
    slide.elements.push(shape);

    await expect(exportFixture(slide, scene)).rejects.toThrow(
      /shape element "shape-bad-path".*shape path could not be parsed/i,
    );
  });

  it('rejects an unresolved internal slide link', async () => {
    const { slide, scene } = makeSlideFixture();
    const shape = createDefaultShapeElement('shape-bad-link');
    shape.link = { type: 'slide', target: 'missing-slide' };
    slide.elements.push(shape);

    await expect(exportFixture(slide, scene)).rejects.toThrow(
      /shape element "shape-bad-link".*could not resolve slide link target "missing-slide"/i,
    );
  });

  it('rejects a formula that has neither native OMML nor an SVG fallback', async () => {
    const { slide, scene } = makeSlideFixture();
    const formula: PPTLatexElement = {
      id: 'formula-empty',
      type: 'latex',
      left: 100,
      top: 100,
      width: 320,
      height: 100,
      rotate: 0,
      latex: '',
    };
    slide.elements.push(formula);

    await expect(exportFixture(slide, scene)).rejects.toThrow(
      /latex element "formula-empty".*could not be converted and has no SVG fallback path/i,
    );
  });

  it('rejects missing and unreachable audio/video media', async () => {
    const missingFixture = makeSlideFixture();
    const missingVideo: PPTVideoElement = {
      id: 'video-missing',
      type: 'video',
      left: 100,
      top: 100,
      width: 400,
      height: 225,
      rotate: 0,
      autoplay: false,
      mediaRef: 'gen_vid_missing',
    };
    missingFixture.slide.elements.push(missingVideo);

    await expect(exportFixture(missingFixture.slide, missingFixture.scene)).rejects.toThrow(
      /video element "video-missing".*gen_vid_missing.*not ready/i,
    );

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));
    const unreachableFixture = makeSlideFixture();
    const unreachableAudio: PPTAudioElement = {
      id: 'audio-unreachable',
      type: 'audio',
      left: 100,
      top: 100,
      width: 48,
      height: 48,
      rotate: 0,
      fixedRatio: true,
      color: '#000000',
      loop: false,
      autoplay: false,
      src: 'https://example.com/audio.mp3',
    };
    unreachableFixture.slide.elements.push(unreachableAudio);

    await expect(exportFixture(unreachableFixture.slide, unreachableFixture.scene)).rejects.toThrow(
      /audio element "audio-unreachable".*failed to fetch or embed audio media.*network unavailable/i,
    );
  });
});
