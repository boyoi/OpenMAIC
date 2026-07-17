import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptxBlob, extractInteractivePreviewText } from '@/lib/export/use-export-pptx';
import {
  createDefaultShapeElement,
  createDefaultSlide,
  createDefaultTextElement,
} from '@/lib/edit/slide-edit-elements';
import type { Scene, SlideContent } from '@/lib/types/stage';
import type { Slide } from '@openmaic/dsl';
import {
  RATIO_PX2_INCH,
  RATIO_PX2_PT,
  VIEWPORT_RATIO,
  VIEWPORT_SIZE,
} from '../edit/round-trip/fixtures';

function makeSlideScene(id: string, order: number, marker: string): { scene: Scene; slide: Slide } {
  const slide = createDefaultSlide(`slide-${id}`);
  const text = createDefaultTextElement(`text-${id}`);
  text.content = `<p>${marker}</p>`;
  slide.elements.push(text);
  const content: SlideContent = { type: 'slide', canvas: slide };
  return {
    slide,
    scene: {
      id: `scene-${id}`,
      stageId: 'stage-1',
      type: 'slide',
      title: marker,
      order,
      content,
    },
  };
}

async function pptxEntry(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`PPTX did not contain entry: ${path}`);
  return entry.async('string');
}

describe('PPTX interactive scene export', () => {
  it('extracts visible semantic text without executing or exposing scripts', () => {
    const html = `
      <html>
        <head><style>.secret { color: red }</style></head>
        <body>
          <h1>ALSC method map</h1>
          <p>Compare the main branches.</p>
          <button>Show evidence</button>
          <script>window.SECRET_EXPORT_MARKER = true</script>
        </body>
      </html>
    `;

    expect(extractInteractivePreviewText(html)).toEqual([
      'ALSC method map',
      'Compare the main branches.',
      'Show evidence',
    ]);
  });

  it('keeps interactive scenes between slides and retains internal slide-link targets', async () => {
    const first = makeSlideScene('first', 0, 'FIRST_SLIDE_MARKER');
    const second = makeSlideScene('second', 2, 'SECOND_SLIDE_MARKER');
    const linkShape = createDefaultShapeElement('link-to-second');
    linkShape.link = { type: 'slide', target: second.slide.id };
    first.slide.elements.push(linkShape);

    const interactive: Scene = {
      id: 'scene-interactive',
      stageId: 'stage-1',
      type: 'interactive',
      title: 'ALSC method map',
      order: 1,
      content: {
        type: 'interactive',
        url: '',
        html: `
          <main>
            <h1>ALSC method map</h1>
            <p>Compare the main branches.</p>
            <button>Show evidence</button>
            <script>SECRET_SCRIPT_MARKER</script>
          </main>
        `,
      },
    };

    const blob = await buildPptxBlob(
      [first.slide, second.slide],
      [first.scene, second.scene],
      VIEWPORT_RATIO,
      VIEWPORT_SIZE,
      RATIO_PX2_INCH,
      RATIO_PX2_PT,
      {
        orderedScenes: [first.scene, interactive, second.scene],
        interactiveLabel: 'INTERACTIVE_TEST_LABEL',
        interactiveResourceLabel: 'RESOURCE_PACK_TEST_LABEL',
      },
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    expect(await pptxEntry(zip, 'ppt/slides/slide1.xml')).toContain('FIRST_SLIDE_MARKER');

    const interactiveXml = await pptxEntry(zip, 'ppt/slides/slide2.xml');
    expect(interactiveXml).toContain('ALSC method map');
    expect(interactiveXml).toContain('INTERACTIVE_TEST_LABEL');
    expect(interactiveXml).toContain('PPTX STATIC PREVIEW');
    expect(interactiveXml).toContain('Compare the main branches.');
    expect(interactiveXml).toContain('Show evidence');
    expect(interactiveXml).not.toContain('SECRET_SCRIPT_MARKER');

    expect(await pptxEntry(zip, 'ppt/slides/slide3.xml')).toContain('SECOND_SLIDE_MARKER');
    expect(await pptxEntry(zip, 'ppt/slides/_rels/slide1.xml.rels')).toContain('slide3.xml');
  });

  it('exports a URL-only interactive classroom as a one-page PPTX with a live link', async () => {
    const interactive: Scene = {
      id: 'scene-url-only',
      stageId: 'stage-1',
      type: 'interactive',
      title: 'External simulator',
      order: 0,
      content: {
        type: 'interactive',
        url: 'https://example.com/simulator',
      },
    };

    const blob = await buildPptxBlob(
      [],
      [],
      VIEWPORT_RATIO,
      VIEWPORT_SIZE,
      RATIO_PX2_INCH,
      RATIO_PX2_PT,
      { orderedScenes: [interactive] },
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    const slideXml = await pptxEntry(zip, 'ppt/slides/slide1.xml');
    expect(slideXml).toContain('External simulator');
    expect(slideXml).toContain('PPTX STATIC PREVIEW');
    expect(await pptxEntry(zip, 'ppt/slides/_rels/slide1.xml.rels')).toContain(
      'https://example.com/simulator',
    );
    expect(zip.file('ppt/slides/slide2.xml')).toBeNull();
  });
});
