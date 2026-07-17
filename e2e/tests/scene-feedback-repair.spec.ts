import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const STAGE_ID = 'e2e-scene-feedback';
const SCENE_ID = 'feedback-interactive';
const IFRAME_TITLE = `Interactive Scene ${SCENE_ID}`;
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

const BROKEN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><button id="start">Start</button><p id="status">idle</p>
<script>throw new Error('FEEDBACK-RUNTIME-SENTINEL');</script></body></html>`;

const FIXED_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><button id="start">Start</button><p id="status">idle</p>
<script>document.getElementById('start').addEventListener('click', function () {
  document.getElementById('status').textContent = 'fixed';
});</script></body></html>`;

const LATE_HTML = `<!DOCTYPE html><html><body><p id="status">late-write</p>
<script>window.__LATE_REPAIR_SENTINEL__ = true;</script></body></html>`;

async function seedDatabase(page: Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ stageId, sceneId, html }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
          const now = Date.now();
          tx.objectStore('stages').put({
            id: stageId,
            name: 'Scene feedback test',
            description: '',
            language: 'en-US',
            style: 'professional',
            currentSceneId: sceneId,
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('scenes').put({
            id: sceneId,
            stageId,
            type: 'interactive',
            title: 'Broken interaction',
            order: 0,
            content: { type: 'interactive', url: '', html },
            actions: [],
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('stageOutlines').put({
            stageId,
            outlines: [],
            generationComplete: true,
            createdAt: now,
            updatedAt: now,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { stageId: STAGE_ID, sceneId: SCENE_ID, html: BROKEN_HTML },
  );
}

test('reports a broken page and applies the AI repair to the same scene', async ({ page }) => {
  test.setTimeout(90_000);
  let requestBody: Record<string, unknown> | null = null;
  await page.route('**/api/agent/edit', async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    const event = {
      type: 'tool_execution_end',
      toolCallId: 'feedback-tool-1',
      toolName: 'edit_interactive_html',
      result: {
        content: [{ type: 'text', text: 'Applied one edit.' }],
        details: { sceneId: SCENE_ID, html: FIXED_HTML, editCount: 1 },
      },
      isError: false,
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      body: `data: ${JSON.stringify(event)}\n\nevent: close\ndata: {}\n\n`,
    });
  });

  await seedDatabase(page);
  const classroom = new ClassroomPage(page);
  await classroom.goto(STAGE_ID);
  await classroom.waitForLoaded();

  const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);
  await expect(frame.locator('#status')).toHaveText('idle');
  await expect(page.getByRole('button', { name: 'Report issue' })).toBeVisible();

  await page.getByRole('button', { name: 'Report issue' }).click();
  await expect(page.getByText(/runtime error.*detected/i)).toBeVisible();
  await page.getByLabel('What is wrong?').fill('The Start button does nothing.');
  await page.getByRole('button', { name: 'Ask AI to fix' }).click();

  await expect(page.getByText('Edit with AI').first()).toBeVisible();
  await expect.poll(() => requestBody).not.toBeNull();

  const body = requestBody as {
    message: string;
    scene: { id: string };
    sceneContextMap: Record<string, { runtimeErrors?: string[] }>;
  };
  expect(body.scene.id).toBe(SCENE_ID);
  expect(body.message).toContain('The Start button does nothing.');
  expect(body.sceneContextMap[SCENE_ID].runtimeErrors?.join('\n')).toContain(
    'FEEDBACK-RUNTIME-SENTINEL',
  );

  await expect(frame.locator('#status')).toHaveText('idle');
  await frame.locator('#start').click();
  await expect(frame.locator('#status')).toHaveText('fixed');
});

test('leaving Pro mode aborts a pending repair before the edit lock is released', async ({
  page,
}) => {
  test.setTimeout(90_000);
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });

  await page.route('**/api/agent/edit', async (route) => {
    markRequestStarted();
    await responseGate;
    const event = {
      type: 'tool_execution_end',
      toolCallId: 'late-feedback-tool',
      toolName: 'edit_interactive_html',
      result: {
        content: [{ type: 'text', text: 'Late edit.' }],
        details: { sceneId: SCENE_ID, html: LATE_HTML, editCount: 1 },
      },
      isError: false,
    };
    try {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: `data: ${JSON.stringify(event)}\n\nevent: close\ndata: {}\n\n`,
      });
    } catch {
      // Expected when the browser has already aborted the repair request.
    }
  });

  await seedDatabase(page);
  const classroom = new ClassroomPage(page);
  await classroom.goto(STAGE_ID);
  await classroom.waitForLoaded();

  await page.getByRole('button', { name: 'Report issue' }).click();
  await page.getByLabel('What is wrong?').fill('The Start button does nothing.');
  await page.getByRole('button', { name: 'Ask AI to fix' }).click();
  await requestStarted;
  await expect(page.getByText('Edit with AI').first()).toBeVisible();

  await page.getByRole('switch').first().click();
  await expect(page.getByRole('button', { name: 'Report issue' })).toBeVisible();
  releaseResponse();
  await page.waitForTimeout(1_000);

  const storedHtml = await page.evaluate(
    ({ sceneId }) =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction('scenes', 'readonly');
          const getRequest = tx.objectStore('scenes').get(sceneId);
          getRequest.onsuccess = () => {
            const html = getRequest.result?.content?.html ?? '';
            db.close();
            resolve(html);
          };
          getRequest.onerror = () => reject(getRequest.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { sceneId: SCENE_ID },
  );
  expect(storedHtml).toContain('FEEDBACK-RUNTIME-SENTINEL');
  expect(storedHtml).not.toContain('__LATE_REPAIR_SENTINEL__');
});
