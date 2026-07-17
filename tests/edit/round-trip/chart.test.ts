import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import type { PPTChartElement } from '@openmaic/dsl';
import {
  makeSlideFixture,
  RATIO_PX2_INCH,
  RATIO_PX2_PT,
  VIEWPORT_RATIO,
  VIEWPORT_SIZE,
} from './fixtures';

describe('round-trip: chart legend export', () => {
  it('uses chart legends as series names in chart XML', async () => {
    const { scene, content } = makeSlideFixture();
    const chart: PPTChartElement = {
      id: 'chart-1',
      type: 'chart',
      left: 80,
      top: 120,
      width: 720,
      height: 360,
      rotate: 0,
      chartType: 'line',
      data: {
        labels: ['Q1', 'Q2', 'Q3'],
        legends: ['Actual revenue', 'Forecast revenue'],
        series: [
          [12, 18, 24],
          [10, 20, 30],
        ],
      },
      themeColors: ['#2563eb', '#f59e0b'],
      textColor: '#111827',
    };
    content.canvas.elements.push(chart);

    const blob = await buildPptxBlob(
      [content.canvas],
      [scene],
      VIEWPORT_RATIO,
      VIEWPORT_SIZE,
      RATIO_PX2_INCH,
      RATIO_PX2_PT,
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const chartXml = await zip.file('ppt/charts/chart1.xml')?.async('string');

    expect(chartXml).toBeDefined();
    expect(chartXml).toContain('Actual revenue');
    expect(chartXml).toContain('Forecast revenue');
    expect(chartXml).not.toContain('Series 1');
    expect(chartXml).not.toContain('Series 2');
  });
});
