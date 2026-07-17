import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';
import { mockSceneContentResponse } from '../fixtures/test-data/scene-content';

const SETTINGS_STORAGE = createSettingsStorage();
const REVIEW_SETTINGS_STORAGE = createSettingsStorage({ reviewOutlineEnabled: true });

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-test-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

const PERSISTED_REVIEW_SESSION = JSON.stringify({
  sessionId: 'e2e-review-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: mockOutlines,
  languageDirective: 'Use Chinese for the generated course.',
  currentStep: 'generating',
  previewPhase: 'review',
});

test.describe('Generation Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('settings-storage', settings);
        if (!sessionStorage.getItem('generationSession')) {
          sessionStorage.setItem('generationSession', session);
        }
      },
      { settings: SETTINGS_STORAGE, session: GENERATION_SESSION },
    );
  });

  test('completes generation pipeline and redirects to classroom', async ({ page, mockApi }) => {
    // Set up all API mocks
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    // Generation card with progress dots should be visible
    await expect(preview.stepTitle).toBeVisible();

    // Wait for auto-redirect to classroom
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
  });

  test('opens outline editor from preview review opportunity and resumes generation', async ({
    page,
    mockApi,
  }) => {
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await expect(preview.editorTitle).toBeVisible();

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
  });

  test('persists always review preference from the outline editor', async ({ page, mockApi }) => {
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForReviewOpportunity();
    await preview.openOutlineReview();
    await preview.enableAlwaysReview();

    const persistedPreference = await page.evaluate(() => {
      const raw = localStorage.getItem('settings-storage');
      return raw ? JSON.parse(raw).state.reviewOutlineEnabled : undefined;
    });
    expect(persistedPreference).toBe(true);

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
  });

  test('automatically opens outline editor when always review is enabled', async ({
    page,
    mockApi,
  }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: REVIEW_SETTINGS_STORAGE, session: GENERATION_SESSION },
    );

    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await preview.waitForEditor();
    await expect(preview.editorTitle).toBeVisible();

    await preview.confirmOutlines();
    await preview.waitForRedirectToClassroom();
  });

  test('regenerates after an outline stream closes without a done event', async ({
    page,
    mockApi,
  }) => {
    await mockApi.mockSceneContent();
    await mockApi.mockSceneActions();

    let outlineRequests = 0;
    await page.route('**/api/generate/scene-outlines-stream', async (route) => {
      outlineRequests++;
      const outlineEvents = mockOutlines
        .map(
          (outline, index) =>
            `data: ${JSON.stringify({ type: 'outline', data: outline, index })}\n\n`,
        )
        .join('');
      const doneEvent = `data: ${JSON.stringify({
        type: 'done',
        outlines: mockOutlines,
        courseTitle: 'Recovered Course',
      })}\n\n`;

      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: outlineRequests === 1 ? outlineEvents : outlineEvents + doneEvent,
      });
    });

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await expect(preview.regenerateButton).toBeVisible();
    expect(outlineRequests).toBe(1);

    await preview.regenerateButton.click();
    await preview.waitForRedirectToClassroom();
    expect(outlineRequests).toBe(2);
  });

  test('regenerates from the original request after first-scene generation fails', async ({
    page,
    mockApi,
  }) => {
    await mockApi.mockSceneOutlinesStream();
    await mockApi.mockSceneActions();

    let contentRequests = 0;
    await page.route('**/api/generate/scene-content', async (route) => {
      contentRequests++;
      if (contentRequests <= 3) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'upstream stream disconnected' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockSceneContentResponse),
      });
    });

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await expect(preview.regenerateButton).toBeVisible({ timeout: 15_000 });
    const failedSession = await page.evaluate(() => {
      const raw = sessionStorage.getItem('generationSession');
      return raw ? JSON.parse(raw) : null;
    });
    expect(failedSession).toMatchObject({
      sessionId: 'e2e-test-session',
      previewPhase: 'failed',
      failureMessage: expect.stringContaining('upstream stream disconnected'),
    });

    await page.reload();
    await expect(preview.regenerateButton).toBeVisible();
    await page.waitForTimeout(500);
    expect(contentRequests).toBe(3);

    await preview.regenerateButton.click();
    await preview.waitForRedirectToClassroom();
    expect(contentRequests).toBe(4);
  });
});

test('resumes generation from a persisted outline review session', async ({ page, mockApi }) => {
  await page.addInitScript(
    ({ settings, session }) => {
      localStorage.setItem('settings-storage', settings);
      sessionStorage.setItem('generationSession', session);
    },
    { settings: SETTINGS_STORAGE, session: PERSISTED_REVIEW_SESSION },
  );

  await mockApi.setupGenerationMocks();

  const preview = new GenerationPreviewPage(page);
  await preview.goto();

  await preview.waitForEditor();
  await preview.confirmOutlines();
  await preview.waitForRedirectToClassroom();
  expect(page.url()).toMatch(/\/classroom\//);
});
