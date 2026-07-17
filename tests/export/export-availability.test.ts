import { describe, expect, it } from 'vitest';
import { getExportAvailability } from '@/lib/export/export-availability';

const slide = { content: { type: 'slide' } };
const interactive = { content: { type: 'interactive', url: 'https://example.com' } };
const quiz = { content: { type: 'quiz' } };

function availability(overrides: Partial<Parameters<typeof getExportAvailability>[0]> = {}) {
  return getExportAvailability({
    scenes: [],
    generatingOutlineCount: 0,
    failedOutlineCount: 0,
    generationStatus: 'completed',
    mediaTaskStatuses: [],
    ...overrides,
  });
}

describe('getExportAvailability', () => {
  it('keeps the menu disabled when no completed scene exists', () => {
    expect(availability({ generatingOutlineCount: 2, generationStatus: 'generating' })).toEqual({
      canOpenMenu: false,
      canExportPPTX: false,
      canExportResourcePack: false,
      canExportClassroomZip: false,
      isPartial: true,
    });
  });

  it('allows completed slides to export while generation is paused or failed', () => {
    expect(
      availability({
        scenes: [slide],
        generatingOutlineCount: 1,
        failedOutlineCount: 1,
        generationStatus: 'paused',
      }),
    ).toEqual({
      canOpenMenu: true,
      canExportPPTX: true,
      canExportResourcePack: true,
      canExportClassroomZip: true,
      isPartial: true,
    });
  });

  it('allows interactive-only content in PPTX, resource, and classroom ZIP exports', () => {
    expect(availability({ scenes: [interactive] })).toEqual({
      canOpenMenu: true,
      canExportPPTX: true,
      canExportResourcePack: true,
      canExportClassroomZip: true,
      isPartial: false,
    });
  });

  it('keeps non-PPT content available through the classroom ZIP', () => {
    expect(availability({ scenes: [quiz] })).toEqual({
      canOpenMenu: true,
      canExportPPTX: false,
      canExportResourcePack: false,
      canExportClassroomZip: true,
      isPartial: false,
    });
  });

  it('warns when generated media is pending or failed', () => {
    expect(
      availability({ scenes: [slide], mediaTaskStatuses: ['done', 'pending', 'failed'] }).isPartial,
    ).toBe(true);
  });
});
