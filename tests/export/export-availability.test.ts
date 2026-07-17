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

  it.each(['generating', 'paused', 'error'] as const)(
    'blocks every export while generation status is %s',
    (generationStatus) => {
      expect(availability({ scenes: [slide], generationStatus })).toEqual({
        canOpenMenu: false,
        canExportPPTX: false,
        canExportResourcePack: false,
        canExportClassroomZip: false,
        isPartial: true,
      });
    },
  );

  it('blocks every export when outlines are pending or failed', () => {
    expect(
      availability({ scenes: [slide], generatingOutlineCount: 1, failedOutlineCount: 1 }),
    ).toEqual({
      canOpenMenu: false,
      canExportPPTX: false,
      canExportResourcePack: false,
      canExportClassroomZip: false,
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

  it.each(['pending', 'generating', 'failed'] as const)(
    'blocks every export when generated media is %s',
    (mediaStatus) => {
      expect(availability({ scenes: [slide], mediaTaskStatuses: ['done', mediaStatus] })).toEqual({
        canOpenMenu: false,
        canExportPPTX: false,
        canExportResourcePack: false,
        canExportClassroomZip: false,
        isPartial: true,
      });
    },
  );

  it('allows a fully ready idle deck to export', () => {
    expect(
      availability({ scenes: [slide], generationStatus: 'idle', mediaTaskStatuses: ['done'] }),
    ).toEqual({
      canOpenMenu: true,
      canExportPPTX: true,
      canExportResourcePack: true,
      canExportClassroomZip: true,
      isPartial: false,
    });
  });
});
