import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import type { PPTCodeElement } from '@openmaic/dsl';
import {
  makeSlideFixture,
  RATIO_PX2_INCH,
  RATIO_PX2_PT,
  VIEWPORT_RATIO,
  VIEWPORT_SIZE,
} from './fixtures';

describe('round-trip: code element export', () => {
  it('keeps file name, line numbers, and code text in slide XML', async () => {
    const { scene, content } = makeSlideFixture();
    const code: PPTCodeElement = {
      id: 'code-1',
      type: 'code',
      left: 60,
      top: 150,
      width: 600,
      height: 300,
      rotate: 0,
      language: 'python',
      fileName: 'main.py',
      showLineNumbers: true,
      fontSize: 16,
      lines: [
        { id: 'L1', content: 'from openai import OpenAI' },
        { id: 'L2', content: 'client = OpenAI()' },
      ],
    };
    content.canvas.elements.push(code);

    const blob = await buildPptxBlob(
      [content.canvas],
      [scene],
      VIEWPORT_RATIO,
      VIEWPORT_SIZE,
      RATIO_PX2_INCH,
      RATIO_PX2_PT,
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string');

    expect(slideXml).toContain('main.py');
    expect(slideXml).toContain('from openai import OpenAI');
    expect(slideXml).toContain('client = OpenAI()');
  });
});
