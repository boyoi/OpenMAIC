import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

type ExportScenario =
  | 'valid'
  | 'degraded'
  | 'invalid-gradient'
  | 'invalid-path'
  | 'broken-interactive'
  | 'pending-media'
  | 'failed-media';

const BROKEN_INTERACTIVE_HTML = `<!doctype html><html><body>
<h1>Broken interactive export</h1>
<script>
throw new Error('E2E interactive runtime exploded');
</script>
</body></html>`;

function stageIdFor(scenario: ExportScenario) {
  return `e2e-pptx-export-${scenario}`;
}

async function seedExportScenario(page: Page, scenario: ExportScenario) {
  const stageId = stageIdFor(scenario);
  const settings = createSettingsStorage(
    scenario === 'pending-media'
      ? {
          imageGenerationEnabled: true,
          imageProviderId: 'openai-image',
          imageModelId: 'gpt-image-1',
          imageProvidersConfig: {
            'openai-image': {
              apiKey: 'e2e-image-key',
              baseUrl: 'https://api.openai.com/v1',
              enabled: true,
            },
          },
        }
      : {},
  );

  await page.addInitScript((settingsStorage) => {
    localStorage.setItem('settings-storage', settingsStorage);
    localStorage.setItem('locale', 'en-US');
  }, settings);

  // Let Dexie create the database at the current schema version before using
  // raw IndexedDB, matching the other classroom E2E seeds.
  await page.goto('/', { waitUntil: 'networkidle' });
  const seedStageData = () =>
    page.evaluate(
      ({ stageId, scenario, theme, brokenInteractiveHtml }) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('MAIC-Database');
          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            const tx = db.transaction(
              ['stages', 'scenes', 'stageOutlines', 'mediaFiles'],
              'readwrite',
            );
            const now = Date.now();
            const mediaScenario = scenario === 'pending-media' || scenario === 'failed-media';
            const mediaRef = 'gen_img_export_gate';

            const textElement = {
              id: 'export-title',
              type: 'text',
              left: 90,
              top: 70,
              width: 820,
              height: 90,
              rotate: 0,
              content: '<p>Validated export content</p>',
              defaultFontName: 'Inter',
              defaultColor: '#111827',
              lineHeight: 1.4,
            };
            const shapeElement = {
              id: 'export-shape',
              type: 'shape',
              left: 160,
              top: 210,
              width: 680,
              height: 220,
              rotate: 0,
              viewBox: [680, 220],
              path:
                scenario === 'invalid-path'
                  ? 'THIS IS NOT SVG PATH DATA'
                  : 'M 0 0 L 680 0 L 680 220 L 0 220 Z',
              fixedRatio: false,
              fill: '#dbeafe',
              outline: { width: 2, color: '#2563eb', style: 'solid' },
            };
            const imageElement = {
              id: 'export-generated-image',
              type: 'image',
              left: 620,
              top: 220,
              width: 220,
              height: 180,
              rotate: 0,
              fixedRatio: true,
              src: mediaRef,
            };
            const slide = {
              id: `slide-${scenario}`,
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme,
              background:
                scenario === 'invalid-gradient'
                  ? {
                      type: 'gradient',
                      gradient: { type: 'linear', colors: [], rotate: 0 },
                    }
                  : { type: 'solid', color: '#ffffff' },
              elements: mediaScenario
                ? [textElement, shapeElement, imageElement]
                : [textElement, shapeElement],
            };

            tx.objectStore('stages').put({
              id: stageId,
              name: `PPTX ${scenario}`,
              description: '',
              languageDirective: 'Deliver the entire course in English (en-US).',
              style: 'professional',
              currentSceneId: `scene-${scenario}`,
              createdAt: now,
              updatedAt: now,
            });

            tx.objectStore('scenes').put(
              scenario === 'broken-interactive'
                ? {
                    id: `scene-${scenario}`,
                    stageId,
                    type: 'interactive',
                    title: 'Broken interaction',
                    order: 0,
                    content: { type: 'interactive', url: '', html: brokenInteractiveHtml },
                    quality: { status: 'candidate', issues: [] },
                    actions: [],
                    createdAt: now,
                    updatedAt: now,
                  }
                : {
                    id: `scene-${scenario}`,
                    stageId,
                    type: 'slide',
                    title: 'Export validation',
                    order: 0,
                    content: { type: 'slide', canvas: slide },
                    quality:
                      scenario === 'degraded'
                        ? {
                            status: 'degraded',
                            issues: ['E2E degraded fallback must not be exported'],
                          }
                        : { status: 'candidate', issues: [] },
                    actions: [],
                    createdAt: now,
                    updatedAt: now,
                  },
            );

            const outlines = mediaScenario
              ? [
                  {
                    id: 'outline-media',
                    type: 'slide',
                    title: 'Export validation',
                    description: 'Validate generated media export readiness.',
                    keyPoints: ['Media must finish before export.'],
                    order: 0,
                    mediaGenerations: [
                      {
                        type: 'image',
                        elementId: mediaRef,
                        prompt: 'A simple educational diagram',
                        aspectRatio: '16:9',
                      },
                    ],
                  },
                ]
              : [];
            tx.objectStore('stageOutlines').put({
              stageId,
              outlines,
              generationComplete: true,
              createdAt: now,
              updatedAt: now,
            });

            if (scenario === 'failed-media') {
              tx.objectStore('mediaFiles').put({
                id: `${stageId}:${mediaRef}`,
                stageId,
                type: 'image',
                blob: new Blob([], { type: 'image/png' }),
                mimeType: 'image/png',
                size: 0,
                prompt: 'A simple educational diagram',
                params: JSON.stringify({ aspectRatio: '16:9' }),
                error: 'E2E image generation failed',
                errorCode: 'E2E_MEDIA_FAILURE',
                createdAt: now,
              });
            }

            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          request.onerror = () => reject(request.error);
        }),
      { stageId, scenario, theme: defaultTheme, brokenInteractiveHtml: BROKEN_INTERACTIVE_HTML },
    );

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await seedStageData();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Execution context was destroyed') || attempt === 2) throw error;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(250);
    }
  }

  await page.goto(`/classroom/${stageId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByText('Loading classroom...').waitFor({ state: 'hidden', timeout: 15_000 });
  return stageId;
}

function mainExportButton(page: Page) {
  return page.locator('button[aria-label="Export PPTX"]');
}

async function startPptxExport(page: Page) {
  const mainButton = mainExportButton(page);
  await expect(mainButton).toBeEnabled();
  await mainButton.click();
  const exportButtons = page.getByRole('button', { name: 'Export PPTX', exact: true });
  await expect(exportButtons).toHaveCount(2);
  await exportButtons.last().click();
}

async function expectValidationBlocked(page: Page, description: string | RegExp) {
  let downloadCount = 0;
  page.on('download', () => downloadCount++);

  await startPptxExport(page);
  await expect(page.getByText('Export failed', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(description)).toBeVisible();
  await page.waitForTimeout(250);
  expect(downloadCount).toBe(0);
}

test.describe('PPTX fail-closed browser export', () => {
  test.describe.configure({ timeout: 75_000 });

  test('downloads a PPTX only after a valid slide passes the full validation chain', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await seedExportScenario(page, 'valid');

    const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
    await startPptxExport(page);
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('PPTX valid.pptx');
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const bytes = await readFile(downloadPath!);
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
    await expect(page.getByText('Export successful', { exact: true })).toBeVisible();
  });

  test('blocks a degraded generation result before a download is created', async ({ page }) => {
    await seedExportScenario(page, 'degraded');
    await expectValidationBlocked(page, 'E2E degraded fallback must not be exported');
  });

  test('keeps export disabled while generated media is still pending', async ({ page }) => {
    test.setTimeout(90_000);
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route('**/api/generate/image', async (route) => {
      markRequestStarted();
      await requestGate;
      await route.abort('failed');
    });

    try {
      await seedExportScenario(page, 'pending-media');
      await requestStarted;
      await expect(mainExportButton(page)).toBeDisabled();
    } finally {
      releaseRequest();
    }
  });

  test('keeps export disabled when a generated media task failed', async ({ page }) => {
    await seedExportScenario(page, 'failed-media');
    await expect(mainExportButton(page)).toBeDisabled();
  });

  test('blocks malformed gradients before a download is created', async ({ page }) => {
    await seedExportScenario(page, 'invalid-gradient');
    await expectValidationBlocked(page, /gradient requires at least two colors/i);
  });

  test('blocks malformed shape paths before a download is created', async ({ page }) => {
    await seedExportScenario(page, 'invalid-path');
    await expectValidationBlocked(page, 'Shape path is invalid');
  });

  test('blocks an interactive scene that reports a runtime error', async ({ page }) => {
    await seedExportScenario(page, 'broken-interactive');
    await expectValidationBlocked(page, 'E2E interactive runtime exploded');
  });
});
