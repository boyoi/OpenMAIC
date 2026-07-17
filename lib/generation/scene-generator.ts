/**
 * Stage 2: Scene content and action generation.
 *
 * Generates full scenes (slide/quiz/interactive/pbl with actions)
 * from scene outlines.
 */

import { nanoid } from 'nanoid';
import katex from 'katex';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  UserRequirements,
  PdfImage,
  ImageMapping,
  WidgetOutline,
} from '@/lib/types/generation';
import type { WidgetType, WidgetConfig } from '@/lib/types/widgets';
import type { PromptId } from '@/lib/prompts/types';
import type { LanguageModel } from 'ai';
import type { StageStore } from '@/lib/api/stage-api';
import { createStageAPI } from '@/lib/api/stage-api';
import { generatePBLContent } from '@/lib/pbl/generate-pbl';
import { generatePBLV2Project, PlannerV2Error } from '@/lib/pbl/v2/agents/planner';
import { generatePBLV2ProjectSingleCall } from '@/lib/pbl/v2/agents/planner-single-call';
import { projectV2ToLegacyProjectConfig } from '@/lib/pbl/v2/compat';
import type { PBLPlannerV2Input, PBLProjectV2 } from '@/lib/pbl/v2/types';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { DEFAULT_LANGUAGE_DIRECTIVE } from './outline-generator';
import { postProcessInteractiveHtml } from './interactive-post-processor';
import { parseActionsFromStructuredOutput } from './action-parser';
import { hasCompleteJsonEnvelope, parseJsonResponse } from './json-repair';
import { buildSlideDesignBrief, resolveSlideDesign } from './slide-design';
import {
  buildCourseContext,
  formatAgentsForPrompt,
  formatTeacherPersonaForPrompt,
  formatImageDescription,
  formatImagePlaceholder,
} from './prompt-formatters';
import type { PPTElement, Slide, SlideBackground, SlideTheme } from '@openmaic/dsl';
import type { QuizQuestion } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import type {
  AgentInfo,
  SceneGenerationContext,
  GeneratedSlideData,
  AICallFn,
  GenerationResult,
  GenerationCallbacks,
} from './pipeline-types';
import type { ThinkingConfig } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

const INTERACTIVE_WIDGET_ACTIONS = [
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
];

// ── Options interfaces for scene generation functions ──

export interface SceneContentOptions {
  /** Full deck outline context for visual rhythm and stable palette selection. */
  allOutlines?: SceneOutline[];
  assignedImages?: PdfImage[];
  imageMapping?: ImageMapping;
  languageModel?: LanguageModel;
  visionEnabled?: boolean;
  generatedMediaMapping?: ImageMapping;
  agents?: AgentInfo[];
  languageDirective?: string;
  thinkingConfig?: ThinkingConfig;
  /** Authoritative UI locale selected by the user, consumed by the PBL v2 planner. */
  targetLanguage?: string;
  /** Original course request/profile, used by PBL v2 for explicit learner-level signals. */
  userRequirements?: UserRequirements;
  allowProceduralSkill?: boolean;
  /**
   * Natural-language edit instruction for whole-slide regeneration (MAIC Editor
   * agent `regenerate_scene`). When set, the slide content prompt switches to
   * EDIT MODE. slide-only; ignored by other scene types.
   */
  editDirective?: string;
  /**
   * The current slide content, fed as the edit baseline so content-specific
   * instructions operate on the real slide rather than re-rolling from outline.
   * Only consumed by the slide branch alongside `editDirective`.
   */
  baselineContent?: GeneratedSlideContent;
}

export interface SceneActionsOptions {
  ctx?: SceneGenerationContext;
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

// ==================== Stage 2: Full Scenes (Two-Step) ====================

/**
 * Stage 3: Generate full scenes (parallel version)
 *
 * Two steps:
 * - Step 3.1: Outline -> Page content (slide/quiz)
 * - Step 3.2: Content + script -> Action list
 *
 * All scenes generated in parallel using Promise.all
 */
export async function generateFullScenes(
  sceneOutlines: SceneOutline[],
  store: StageStore,
  aiCall: AICallFn,
  callbacks?: GenerationCallbacks,
  languageDirective?: string,
): Promise<GenerationResult<string[]>> {
  const api = createStageAPI(store);
  const totalScenes = sceneOutlines.length;
  let completedCount = 0;

  callbacks?.onProgress?.({
    currentStage: 3,
    overallProgress: 66,
    stageProgress: 0,
    statusMessage: `正在并行生成 ${totalScenes} 个场景...`,
    scenesGenerated: 0,
    totalScenes,
  });

  // Generate all scenes in parallel
  const results = await Promise.all(
    sceneOutlines.map(async (outline, index) => {
      try {
        const sceneId = await generateSingleScene(
          outline,
          api,
          aiCall,
          languageDirective,
          sceneOutlines,
        );

        // Update progress (not atomic, but sufficient for UI display)
        completedCount++;
        callbacks?.onProgress?.({
          currentStage: 3,
          overallProgress: 66 + Math.floor((completedCount / totalScenes) * 34),
          stageProgress: Math.floor((completedCount / totalScenes) * 100),
          statusMessage: `已完成 ${completedCount}/${totalScenes} 个场景`,
          scenesGenerated: completedCount,
          totalScenes,
        });

        return { success: true, sceneId, index };
      } catch (error) {
        completedCount++;
        callbacks?.onError?.(`Failed to generate scene ${outline.title}: ${error}`);
        return { success: false, sceneId: null, index };
      }
    }),
  );

  // Collect successful sceneIds in original order
  const sceneIds = results
    .filter(
      (r): r is { success: true; sceneId: string; index: number } =>
        r.success && r.sceneId !== null,
    )
    .sort((a, b) => a.index - b.index)
    .map((r) => r.sceneId);

  return { success: true, data: sceneIds };
}

/**
 * Generate a single scene (two-step process)
 *
 * Step 3.1: Generate content
 * Step 3.2: Generate Actions
 */
async function generateSingleScene(
  outline: SceneOutline,
  api: ReturnType<typeof createStageAPI>,
  aiCall: AICallFn,
  languageDirective?: string,
  allOutlines?: SceneOutline[],
): Promise<string | null> {
  // Step 3.1: Generate content
  log.info(`Step 3.1: Generating content for: ${outline.title}`);
  const content = await generateSceneContent(outline, aiCall, { languageDirective, allOutlines });
  if (!content) {
    log.error(`Failed to generate content for: ${outline.title}`);
    return null;
  }

  // Step 3.2: Generate Actions
  log.info(`Step 3.2: Generating actions for: ${outline.title}`);
  const actions = await generateSceneActions(outline, content, aiCall, { languageDirective });
  log.info(`Generated ${actions.length} actions for: ${outline.title}`);

  // Create complete Scene
  return createSceneWithActions(outline, content, actions, api);
}

// ==================== Backward Compatibility Helpers ====================

/**
 * Convert legacy interactiveConfig to unified widget fields
 * For backward compatibility with old classrooms
 */
function convertInteractiveConfigToWidget(outline: SceneOutline): SceneOutline {
  const config = outline.interactiveConfig;
  if (!config) {
    log.warn(
      `Interactive outline missing both widget and interactiveConfig, falling back to simulation`,
    );
    return {
      ...outline,
      widgetType: 'simulation' as WidgetType,
      widgetOutline: { concept: outline.title },
    };
  }

  const widgetType = inferWidgetType(
    config.subject || '',
    config.conceptName,
    config.designIdea || '',
  );

  log.info(`Converting interactiveConfig to widget: ${widgetType} for "${outline.title}"`);

  return {
    ...outline,
    widgetType,
    widgetOutline: buildWidgetOutline(widgetType, config),
  };
}

/**
 * Infer widget type from concept characteristics
 */
function inferWidgetType(subject: string, concept: string, designIdea: string): WidgetType {
  const text = (subject + ' ' + concept + ' ' + designIdea).toLowerCase();

  // Rule-based inference
  if (
    /physics|chemistry|力学|化学|运动|反应|force|motion|equilibrium|wave|电路|circuit/.test(text)
  ) {
    return 'simulation';
  }
  if (/programming|code|algorithm|编程|算法|python|javascript|function|代码/.test(text)) {
    return 'code';
  }
  if (/process|workflow|步骤|流程|逻辑|step|flow|系统|system/.test(text)) {
    return 'diagram';
  }
  if (
    /biology|anatomy|cell|molecular|生物|细胞|分子|3d|三维|solar|planet|skeleton|organ/.test(text)
  ) {
    return 'visualization3d';
  }
  if (/game|quiz|practice|练习|游戏|puzzle|match|challenge|挑战/.test(text)) {
    return 'game';
  }

  // Default fallback
  return 'simulation';
}

/**
 * Build widgetOutline from interactiveConfig for backward compatibility
 */
function buildWidgetOutline(
  widgetType: WidgetType,
  config: { conceptName: string; conceptOverview: string; designIdea: string },
): WidgetOutline {
  const base: WidgetOutline = { concept: config.conceptName };

  switch (widgetType) {
    case 'simulation':
      // Try to extract variables from designIdea
      const varMatch = config.designIdea.match(/variables|参数|调整|adjust|slider/i);
      return { ...base, keyVariables: varMatch ? [] : undefined };
    case 'diagram':
      return { ...base, diagramType: 'flowchart' };
    case 'code':
      return { ...base, language: 'python' };
    case 'game':
      return { ...base, gameType: 'quiz' };
    case 'visualization3d':
      return { ...base, visualizationType: 'custom', objects: [] };
    default:
      return base;
  }
}

/**
 * Step 3.1: Generate content based on outline
 */
export async function generateSceneContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  options: SceneContentOptions = {},
): Promise<
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent
  | null
> {
  const {
    assignedImages,
    imageMapping,
    languageModel,
    visionEnabled,
    generatedMediaMapping,
    agents,
    languageDirective,
    thinkingConfig,
    targetLanguage,
    userRequirements,
    allowProceduralSkill = false,
    editDirective,
    baselineContent,
    allOutlines,
  } = options;

  // Unified path for interactive scenes (both normal and ultra mode)
  if (outline.type === 'interactive') {
    // Backward compatibility: convert legacy interactiveConfig
    if (!outline.widgetType && outline.interactiveConfig) {
      log.info(`Converting legacy interactiveConfig for: ${outline.title}`);
      outline = convertInteractiveConfigToWidget(outline);
    }

    // If still no widgetType after conversion, fallback to simulation
    if (!outline.widgetType) {
      log.warn(
        `Interactive outline "${outline.title}" has no widgetType, falling back to simulation`,
      );
      outline = {
        ...outline,
        widgetType: 'simulation' as WidgetType,
        widgetOutline: { concept: outline.title },
      };
    }

    // Route to widget generation (handles all 5 types)
    return generateWidgetContent(outline, aiCall, languageDirective, { allowProceduralSkill });
  }

  switch (outline.type) {
    case 'slide':
      return generateSlideContent(
        outline,
        aiCall,
        assignedImages,
        imageMapping,
        visionEnabled,
        generatedMediaMapping,
        agents,
        languageDirective,
        editDirective,
        baselineContent,
        allOutlines,
      );
    case 'quiz':
      return generateQuizContent(outline, aiCall, languageDirective);
    case 'pbl':
      return generatePBLSceneContent(
        outline,
        languageModel,
        languageDirective,
        thinkingConfig,
        targetLanguage,
        userRequirements,
      );
    default:
      return null;
  }
}

/**
 * Check if a string looks like an image ID (e.g., "img_1", "img_2")
 * rather than a base64 data URL or actual URL
 *
 * This function distinguishes between:
 * - Image IDs: "img_1", "img_2", etc. → returns true
 * - Base64 data URLs: "data:image/..." → returns false
 * - HTTP URLs: "http://...", "https://..." → returns false
 * - Relative paths: "/images/..." → returns false
 */
function isImageIdReference(value: string): boolean {
  if (!value) return false;
  // Exclude real URLs and paths
  if (value.startsWith('data:')) return false;
  if (value.startsWith('http://') || value.startsWith('https://')) return false;
  if (value.startsWith('/')) return false; // Relative paths
  // Match image ID format: img_1, img_2, etc.
  return /^img_\d+$/i.test(value);
}

/**
 * Check if a string looks like a generated image/video ID (e.g., "gen_img_1", "gen_img_xK8f2mQ")
 * These are placeholders for AI-generated media, not PDF-extracted images.
 */
function isGeneratedImageId(value: string): boolean {
  if (!value) return false;
  return /^gen_(img|vid)_[\w-]+$/i.test(value);
}

/**
 * Resolve image ID references in src field to actual base64 URLs
 *
 * AI generates: { type: "image", src: "img_1", ... }
 * This function replaces: { type: "image", src: "data:image/png;base64,...", ... }
 *
 * Design rationale (Plan B):
 * - Simpler: AI only needs to know one field (src)
 * - Consistent: Generated JSON structure matches final PPTImageElement
 * - Intuitive: src is the image source, first as ID then as actual URL
 * - Less prompt complexity: No need to explain imageId vs src distinction
 */
function resolveImageIds(
  elements: GeneratedSlideData['elements'],
  imageMapping?: ImageMapping,
  generatedMediaMapping?: ImageMapping,
): GeneratedSlideData['elements'] {
  return elements
    .map((el) => {
      if (el.type === 'image') {
        if (!('src' in el)) {
          log.warn(`Image element missing src, removing element`);
          return null; // Remove invalid image elements
        }
        const src = el.src as string;

        // If src is an image ID reference, replace with actual URL
        if (isImageIdReference(src)) {
          if (!imageMapping || !imageMapping[src]) {
            log.warn(`No mapping for image ID: ${src}, removing element`);
            return null; // Remove invalid image elements
          }
          log.debug(`Resolved image ID "${src}" to base64 URL`);
          return { ...el, src: imageMapping[src] };
        }

        // Generated image reference — keep as placeholder for async backfill
        if (isGeneratedImageId(src)) {
          if (generatedMediaMapping && generatedMediaMapping[src]) {
            log.debug(`Resolved generated image ID "${src}" to URL`);
            return { ...el, src: generatedMediaMapping[src] };
          }
          // Keep element with placeholder ID — frontend renders skeleton
          log.debug(`Keeping generated image placeholder: ${src}`);
          return el;
        }
      }

      if (el.type === 'video') {
        const mediaRef = (el as Record<string, unknown>).mediaRef;
        if (!('src' in el) && typeof mediaRef !== 'string') {
          log.warn(`Video element missing src, removing element`);
          return null;
        }
        const src = el.src as string;
        if (isGeneratedImageId(src)) {
          if (generatedMediaMapping && generatedMediaMapping[src]) {
            log.debug(`Resolved generated video ID "${src}" to URL`);
            return { ...el, src: generatedMediaMapping[src] };
          }
          // Keep element with placeholder ID — frontend renders skeleton
          log.debug(`Keeping generated video placeholder: ${src}`);
          return el;
        }
      }

      return el;
    })
    .filter((el): el is NonNullable<typeof el> => el !== null);
}

function normalizeGeneratedVideoRefs(
  elements: GeneratedSlideData['elements'],
  generatedVideoEntries: SceneOutline['mediaGenerations'] = [],
): GeneratedSlideData['elements'] {
  const validRefs = generatedVideoEntries
    .filter((mg) => mg.type === 'video')
    .map((mg) => mg.elementId);

  const validRefSet = new Set(validRefs);
  const onlyRef = validRefs.length === 1 ? validRefs[0] : undefined;

  return elements
    .map((el) => {
      if (el.type !== 'video') return el;

      const videoEl = { ...el } as Record<string, unknown>;
      const mediaRef = typeof videoEl.mediaRef === 'string' ? videoEl.mediaRef : undefined;
      const src = typeof videoEl.src === 'string' ? videoEl.src : undefined;
      const hasGeneratedSrc = !!src && isGeneratedImageId(src);
      const hasDirectSrc = !!src && !hasGeneratedSrc;

      if (hasDirectSrc) {
        if (mediaRef) delete videoEl.mediaRef;
        return videoEl as typeof el;
      }

      if (mediaRef && validRefSet.has(mediaRef)) {
        if (hasGeneratedSrc) delete videoEl.src;
        return videoEl as typeof el;
      }

      if (src && validRefSet.has(src)) {
        videoEl.mediaRef = src;
        delete videoEl.src;
        return videoEl as typeof el;
      }

      if ((mediaRef || hasGeneratedSrc) && onlyRef) {
        log.warn(`Correcting generated video reference "${mediaRef || src}" to "${onlyRef}"`);
        videoEl.mediaRef = onlyRef;
        if (hasGeneratedSrc) delete videoEl.src;
        return videoEl as typeof el;
      }

      if (mediaRef || hasGeneratedSrc) {
        log.warn(`Invalid generated video reference "${mediaRef || src}", removing element`);
        return null;
      }

      return el;
    })
    .filter((el): el is NonNullable<typeof el> => el !== null);
}

/**
 * Fix elements with missing required fields
 * Adds default values for fields that AI might not have generated correctly
 */
function fixElementDefaults(
  elements: GeneratedSlideData['elements'],
  assignedImages?: PdfImage[],
): GeneratedSlideData['elements'] {
  return elements.map((el) => {
    // Fix line elements
    if (el.type === 'line') {
      const lineEl = el as Record<string, unknown>;

      // Ensure points field exists with default values
      if (!lineEl.points || !Array.isArray(lineEl.points) || lineEl.points.length !== 2) {
        log.warn(`Line element missing points, adding defaults`);
        lineEl.points = ['', ''] as [string, string]; // Default: no markers on either end
      }

      // Ensure start/end exist
      if (!lineEl.start || !Array.isArray(lineEl.start)) {
        lineEl.start = [el.left ?? 0, el.top ?? 0];
      }
      if (!lineEl.end || !Array.isArray(lineEl.end)) {
        lineEl.end = [(el.left ?? 0) + (el.width ?? 100), (el.top ?? 0) + (el.height ?? 0)];
      }

      // Ensure style exists
      if (!lineEl.style) {
        lineEl.style = 'solid';
      }

      // Ensure color exists
      if (!lineEl.color) {
        lineEl.color = '#333333';
      }

      return lineEl as typeof el;
    }

    // Fix text elements
    if (el.type === 'text') {
      const textEl = el as Record<string, unknown>;

      if (!textEl.defaultFontName) {
        textEl.defaultFontName = 'Microsoft YaHei';
      }
      if (!textEl.defaultColor) {
        textEl.defaultColor = '#333333';
      }
      if (!textEl.content) {
        textEl.content = '';
      }

      return textEl as typeof el;
    }

    // Fix image elements
    if (el.type === 'image') {
      const imageEl = el as Record<string, unknown>;

      if (imageEl.fixedRatio === undefined) {
        imageEl.fixedRatio = true;
      }

      // Correct dimensions using known aspect ratio (src is still img_id at this point)
      if (assignedImages && typeof imageEl.src === 'string') {
        const imgMeta = assignedImages.find((img) => img.id === imageEl.src);
        if (imgMeta?.width && imgMeta?.height) {
          const knownRatio = imgMeta.width / imgMeta.height;
          const curW = (el.width || 400) as number;
          const curH = (el.height || 300) as number;
          if (Math.abs(curW / curH - knownRatio) / knownRatio > 0.1) {
            // Keep width, correct height
            const newH = Math.round(curW / knownRatio);
            if (newH > 462) {
              // canvas 562.5 - margins 50×2
              const newW = Math.round(462 * knownRatio);
              imageEl.width = newW;
              imageEl.height = 462;
            } else {
              imageEl.height = newH;
            }
          }
        }
      }

      return imageEl as typeof el;
    }

    // Fix shape elements
    if (el.type === 'shape') {
      const shapeEl = el as Record<string, unknown>;
      const width = Number.isFinite(el.width) && el.width > 0 ? el.width : 100;
      const height = Number.isFinite(el.height) && el.height > 0 ? el.height : 100;

      if (!shapeEl.viewBox) {
        shapeEl.viewBox = [width, height];
      }
      if (!shapeEl.path) {
        // Default to rectangle
        shapeEl.path = `M0 0 L${width} 0 L${width} ${height} L0 ${height} Z`;
      }
      if (!shapeEl.fill) {
        shapeEl.fill = '#5b9bd5';
      }
      if (shapeEl.fixedRatio === undefined) {
        shapeEl.fixedRatio = false;
      }

      return shapeEl as typeof el;
    }

    // Fix chart elements
    if (el.type === 'chart') {
      const chartEl = el as Record<string, unknown>;
      if (!Array.isArray(chartEl.themeColors) || chartEl.themeColors.length === 0) {
        chartEl.themeColors = ['#0F766E', '#2563EB', '#E4573D'];
      }
      if (!chartEl.textColor) chartEl.textColor = '#475569';
      if (!chartEl.lineColor) chartEl.lineColor = '#D8DEE6';

      const data = chartEl.data as Record<string, unknown> | undefined;
      if (data && Array.isArray(data.series) && !Array.isArray(data.legends)) {
        data.legends = data.series.map((_, index) => `Series ${index + 1}`);
      }
      return chartEl as typeof el;
    }

    // Fix table elements
    if (el.type === 'table') {
      const tableEl = el as Record<string, unknown>;
      const rows = Array.isArray(tableEl.data) ? tableEl.data : [];
      const firstRow = Array.isArray(rows[0]) ? rows[0] : [];
      if (!Array.isArray(tableEl.colWidths) && firstRow.length > 0) {
        tableEl.colWidths = firstRow.map(() => 1 / firstRow.length);
      }
      if (!tableEl.cellMinHeight) tableEl.cellMinHeight = 44;
      if (!tableEl.outline) {
        tableEl.outline = { width: 1, color: '#D8DEE6', style: 'solid' };
      }
      tableEl.data = rows.map((row, rowIndex) =>
        Array.isArray(row)
          ? row.map((cell, columnIndex) => {
              const value =
                cell && typeof cell === 'object'
                  ? (cell as Record<string, unknown>)
                  : { text: String(cell ?? '') };
              return {
                ...value,
                id:
                  typeof value.id === 'string' && value.id
                    ? value.id
                    : `cell_${rowIndex + 1}_${columnIndex + 1}`,
                colspan:
                  Number.isInteger(Number(value.colspan)) && Number(value.colspan) > 0
                    ? Number(value.colspan)
                    : 1,
                rowspan:
                  Number.isInteger(Number(value.rowspan)) && Number(value.rowspan) > 0
                    ? Number(value.rowspan)
                    : 1,
              };
            })
          : [],
      );
      return tableEl as typeof el;
    }

    // Fix code elements
    if (el.type === 'code') {
      const codeEl = el as Record<string, unknown>;
      const lines = Array.isArray(codeEl.lines) ? codeEl.lines : [];
      codeEl.lines = lines.map((line, index) => {
        const value =
          typeof line === 'string' ? { content: line } : (line as Record<string, unknown>);
        return {
          ...value,
          id: typeof value.id === 'string' && value.id ? value.id : `L${index + 1}`,
          content: typeof value.content === 'string' ? value.content : String(value.content ?? ''),
        };
      });
      if (!codeEl.language) codeEl.language = 'text';
      if (codeEl.showLineNumbers === undefined) codeEl.showLineNumbers = true;
      if (!codeEl.fontSize) codeEl.fontSize = 16;
      return codeEl as typeof el;
    }

    return el;
  });
}

/**
 * Process LaTeX elements: render latex string to HTML using KaTeX.
 * Fills in html and fixedRatio fields.
 * Elements that fail conversion are removed.
 */
function processLatexElements(
  elements: GeneratedSlideData['elements'],
): GeneratedSlideData['elements'] {
  return elements
    .map((el) => {
      if (el.type !== 'latex') return el;

      const latexStr = el.latex as string | undefined;
      if (!latexStr) {
        log.warn('Latex element missing latex string, removing');
        return null;
      }

      try {
        const html = katex.renderToString(latexStr, {
          throwOnError: false,
          displayMode: true,
          output: 'html',
        });

        return {
          ...el,
          html,
          fixedRatio: true,
        };
      } catch (err) {
        log.warn(`Failed to render latex "${latexStr}":`, err);
        return null;
      }
    })
    .filter((el): el is NonNullable<typeof el> => el !== null);
}

/**
 * Generate slide content
 */
const SLIDE_CANVAS_WIDTH = 1000;
const SLIDE_CANVAS_HEIGHT = 562.5;
const SLIDE_MAX_ELEMENTS = 16;
const SLIDE_MAX_TEXT_ELEMENTS = 8;
const RELIABLE_CHART_TYPES = new Set(['bar', 'column', 'line', 'pie', 'ring', 'area']);
const SUPPORTED_SLIDE_ELEMENT_TYPES = new Set([
  'text',
  'image',
  'video',
  'shape',
  'chart',
  'table',
  'code',
  'latex',
  'line',
]);

function escapeSlideHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function compactSlideText(value: string | undefined, maxLength: number): string {
  const compact = (value || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

const FALLBACK_RECT_PATH = 'M 0 0 L 1 0 L 1 1 L 0 1 Z';
const FALLBACK_CIRCLE_PATH = 'M 1 0.5 A 0.5 0.5 0 1 1 0 0.5 A 0.5 0.5 0 1 1 1 0.5 Z';

function fallbackShape(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fill: string,
  outlineColor?: string,
  circle = false,
): GeneratedSlideData['elements'][number] {
  return {
    id,
    type: 'shape',
    left,
    top,
    width,
    height,
    path: circle ? FALLBACK_CIRCLE_PATH : FALLBACK_RECT_PATH,
    viewBox: [1, 1],
    fill,
    fixedRatio: circle,
    ...(outlineColor
      ? { outline: { width: 1, color: outlineColor, style: 'solid' as const } }
      : {}),
  };
}

function fallbackText(
  id: string,
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fontSize: number,
  color: string,
  bold = false,
  align: 'left' | 'center' | 'right' = 'left',
): GeneratedSlideData['elements'][number] {
  const content = bold ? `<strong>${escapeSlideHtml(text)}</strong>` : escapeSlideHtml(text);
  return {
    id,
    type: 'text',
    left,
    top,
    width,
    height,
    content: `<p style="font-size:${fontSize}px;color:${color};line-height:1.3;text-align:${align};">${content}</p>`,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: color,
    lineHeight: 1.3,
  };
}

function fallbackLine(
  id: string,
  left: number,
  top: number,
  end: [number, number],
  color: string,
  arrow = true,
): GeneratedSlideData['elements'][number] {
  return {
    id,
    type: 'line',
    left,
    top,
    width: 3,
    height: 0,
    start: [0, 0],
    end,
    style: 'solid',
    color,
    points: ['', arrow ? 'arrow' : ''],
  };
}

function fallbackHeading(
  outline: SceneOutline,
  ink: string,
  muted: string,
  cover = false,
): GeneratedSlideData['elements'] {
  const title = compactSlideText(outline.title, cover ? 48 : 58);
  const description = compactSlideText(outline.description, cover ? 100 : 118);
  const elements: GeneratedSlideData['elements'] = [
    fallbackText(
      'fallback_title',
      title,
      60,
      cover ? 105 : 48,
      cover ? 500 : 880,
      cover ? 128 : 78,
      cover ? 46 : 36,
      ink,
      true,
    ),
  ];
  if (description) {
    elements.push(
      fallbackText(
        'fallback_description',
        description,
        60,
        cover ? 245 : 132,
        cover ? 490 : 880,
        cover ? 84 : 58,
        cover ? 19 : 17,
        muted,
      ),
    );
  }
  return elements;
}

function fallbackPoints(outline: SceneOutline, limit = 5): string[] {
  const points = (outline.keyPoints || [])
    .map((point) => compactSlideText(point, 68))
    .filter(Boolean)
    .slice(0, limit);
  if (points.length === 0) points.push(compactSlideText(outline.description || outline.title, 68));
  for (const candidate of [outline.description, outline.title]) {
    const compact = compactSlideText(candidate, 68);
    if (points.length >= Math.min(2, limit)) break;
    if (compact && !points.includes(compact)) points.push(compact);
  }
  return points;
}

function buildFlowFallback(
  outline: SceneOutline,
  design: ReturnType<typeof resolveSlideDesign>,
): GeneratedSlideData['elements'] {
  const points = fallbackPoints(outline, 5).slice(0, 4);
  const elements = fallbackHeading(outline, design.palette.ink, design.palette.muted);
  const contentTop = outline.description ? 235 : 195;
  const markerSize = 54;
  const startLeft = 100;
  const available = 760;
  const step = points.length > 1 ? available / (points.length - 1) : 0;

  points.slice(0, -1).forEach((_, index) => {
    elements.push(
      fallbackLine(
        `fallback_flow_line_${index + 1}`,
        startLeft + index * step + markerSize,
        contentTop + markerSize / 2,
        [Math.max(40, step - markerSize), 0],
        design.palette.muted,
      ),
    );
  });

  points.forEach((point, index) => {
    const left = startLeft + index * step;
    elements.push(
      fallbackShape(
        `fallback_flow_marker_${index + 1}`,
        left,
        contentTop,
        markerSize,
        markerSize,
        index % 2 === 0 ? design.palette.primary : design.palette.secondary,
        undefined,
        true,
      ),
      fallbackText(
        `fallback_flow_text_${index + 1}`,
        point,
        Math.max(60, left - 58),
        contentTop + 74,
        170,
        104,
        17,
        design.palette.ink,
        true,
        'center',
      ),
    );
  });
  return elements;
}

function buildComparisonFallback(
  outline: SceneOutline,
  design: ReturnType<typeof resolveSlideDesign>,
): GeneratedSlideData['elements'] {
  const points = fallbackPoints(outline, 4);
  const elements = fallbackHeading(outline, design.palette.ink, design.palette.muted);
  const top = outline.description ? 205 : 170;
  const sideHeight = 235;
  const leftPoint = points[0];
  const rightPoint = points[1] || points[0];
  const decision = points.slice(2).join(' / ') || compactSlideText(outline.description, 68);

  elements.push(
    fallbackShape('fallback_compare_left', 60, top, 420, sideHeight, '#FFFFFF', '#D8DEE6'),
    fallbackShape('fallback_compare_right', 520, top, 420, sideHeight, '#FFFFFF', '#D8DEE6'),
    fallbackShape(
      'fallback_compare_left_marker',
      84,
      top + 28,
      42,
      42,
      design.palette.primary,
      undefined,
      true,
    ),
    fallbackShape(
      'fallback_compare_right_marker',
      544,
      top + 28,
      42,
      42,
      design.palette.secondary,
      undefined,
      true,
    ),
    fallbackText(
      'fallback_compare_left_text',
      leftPoint,
      142,
      top + 28,
      305,
      150,
      21,
      design.palette.ink,
      true,
    ),
    fallbackText(
      'fallback_compare_right_text',
      rightPoint,
      602,
      top + 28,
      305,
      150,
      21,
      design.palette.ink,
      true,
    ),
    fallbackShape('fallback_compare_rule_bg', 190, top + 260, 620, 70, design.palette.ink),
    fallbackText(
      'fallback_compare_rule',
      decision,
      215,
      top + 270,
      570,
      52,
      17,
      '#FFFFFF',
      true,
      'center',
    ),
  );
  return elements;
}

function buildArchitectureFallback(
  outline: SceneOutline,
  design: ReturnType<typeof resolveSlideDesign>,
): GeneratedSlideData['elements'] {
  const points = fallbackPoints(outline, 4);
  const elements = fallbackHeading(outline, design.palette.ink, design.palette.muted);
  const top = outline.description ? 190 : 160;
  const rowHeight = points.length > 3 ? 68 : 82;
  const gap = 18;

  points.slice(0, -1).forEach((_, index) => {
    elements.push(
      fallbackLine(
        `fallback_arch_line_${index + 1}`,
        500,
        top + rowHeight + index * (rowHeight + gap),
        [0, gap],
        design.palette.muted,
      ),
    );
  });

  points.forEach((point, index) => {
    const rowTop = top + index * (rowHeight + gap);
    const fill =
      index === 0
        ? design.palette.primary
        : index === points.length - 1
          ? design.palette.secondary
          : '#FFFFFF';
    const textColor = index === 0 || index === points.length - 1 ? '#FFFFFF' : design.palette.ink;
    elements.push(
      fallbackShape(
        `fallback_arch_layer_${index + 1}`,
        160 + index * 18,
        rowTop,
        680 - index * 36,
        rowHeight,
        fill,
        fill === '#FFFFFF' ? '#D8DEE6' : undefined,
      ),
      fallbackText(
        `fallback_arch_text_${index + 1}`,
        point,
        190 + index * 18,
        rowTop + 9,
        620 - index * 36,
        rowHeight - 18,
        18,
        textColor,
        true,
        'center',
      ),
    );
  });
  return elements;
}

function buildConceptFallback(
  outline: SceneOutline,
  design: ReturnType<typeof resolveSlideDesign>,
): GeneratedSlideData['elements'] {
  const points = fallbackPoints(outline, 4).slice(0, 3);
  const elements = fallbackHeading(outline, design.palette.ink, design.palette.muted);
  const centerTop = outline.description ? 265 : 225;
  const centerLeft = 420;
  const nodePositions = [
    { left: 90, top: centerTop - 70 },
    { left: 720, top: centerTop - 70 },
    { left: 405, top: centerTop + 145 },
  ];

  nodePositions.slice(0, points.length).forEach((position, index) => {
    const endX =
      position.left < centerLeft ? position.left - centerLeft + 150 : position.left - centerLeft;
    const endY = position.top - centerTop + 55;
    elements.push(
      fallbackLine(
        `fallback_concept_line_${index + 1}`,
        centerLeft + 80,
        centerTop + 80,
        [endX, endY],
        design.palette.muted,
        false,
      ),
    );
  });

  elements.push(
    fallbackShape(
      'fallback_concept_center',
      centerLeft,
      centerTop,
      160,
      160,
      design.palette.primary,
      undefined,
      true,
    ),
    fallbackText(
      'fallback_concept_center_text',
      compactSlideText(outline.title, 24),
      centerLeft + 18,
      centerTop + 45,
      124,
      70,
      20,
      '#FFFFFF',
      true,
      'center',
    ),
  );

  points.forEach((point, index) => {
    const position = nodePositions[index];
    elements.push(
      fallbackShape(
        `fallback_concept_node_${index + 1}`,
        position.left,
        position.top,
        190,
        110,
        '#FFFFFF',
        index === 2 ? design.palette.accent : '#D8DEE6',
      ),
      fallbackText(
        `fallback_concept_text_${index + 1}`,
        point,
        position.left + 14,
        position.top + 18,
        162,
        78,
        17,
        design.palette.ink,
        true,
        'center',
      ),
    );
  });
  return elements;
}

function buildDecisionFallback(
  outline: SceneOutline,
  design: ReturnType<typeof resolveSlideDesign>,
): GeneratedSlideData['elements'] {
  const points = fallbackPoints(outline, 4);
  const checks = points.slice(0, 3);
  const elements = fallbackHeading(outline, design.palette.ink, design.palette.muted);
  const top = outline.description ? 200 : 170;

  checks.forEach((point, index) => {
    const rowTop = top + index * 82;
    elements.push(
      fallbackShape(
        `fallback_decision_marker_${index + 1}`,
        105,
        rowTop + 9,
        48,
        48,
        index === checks.length - 1 ? design.palette.accent : design.palette.primary,
        undefined,
        true,
      ),
      fallbackText(
        `fallback_decision_text_${index + 1}`,
        point,
        180,
        rowTop,
        700,
        66,
        18,
        design.palette.ink,
        true,
      ),
    );
  });

  const outcome =
    points[3] || compactSlideText(outline.description, 72) || compactSlideText(outline.title, 48);
  elements.push(
    fallbackShape('fallback_decision_outcome_bg', 180, top + 258, 700, 76, design.palette.ink),
    fallbackText(
      'fallback_decision_outcome',
      outcome,
      205,
      top + 270,
      650,
      52,
      17,
      '#FFFFFF',
      true,
      'center',
    ),
  );
  return elements;
}

function looksLikeCode(value: string): boolean {
  return /[=(){};]|^(?:from|import|const|let|var|def|class|curl|pip|npm|pnpm|yarn|docker|git)\b/i.test(
    value.trim(),
  );
}

function buildCodeFallback(
  outline: SceneOutline,
  design: ReturnType<typeof resolveSlideDesign>,
): GeneratedSlideData['elements'] {
  const rawPoints = (outline.keyPoints || []).map((point) => String(point).trim()).filter(Boolean);
  if (!rawPoints.some(looksLikeCode)) return buildFlowFallback(outline, design);

  const elements = fallbackHeading(outline, design.palette.ink, design.palette.muted);
  const top = outline.description ? 190 : 160;
  const language = /python|pip\b|from\s+\w+\s+import|def\s+/i.test(outlineTextForFallback(outline))
    ? 'python'
    : /typescript|interface\s+\w+|:\s*(string|number|boolean)/i.test(
          outlineTextForFallback(outline),
        )
      ? 'typescript'
      : 'javascript';
  const codeLines = rawPoints
    .slice(0, 12)
    .map((content, index) => ({ id: `L${index + 1}`, content }));
  const note = compactSlideText(outline.description, 120) || compactSlideText(outline.title, 70);

  elements.push(
    {
      id: 'fallback_code',
      type: 'code',
      left: 60,
      top,
      width: 600,
      height: 330,
      language,
      fileName: language === 'python' ? 'main.py' : 'main.ts',
      showLineNumbers: true,
      fontSize: 16,
      lines: codeLines,
    },
    fallbackShape('fallback_code_note_bg', 690, top, 250, 330, '#FFFFFF', '#D8DEE6'),
    fallbackText('fallback_code_note', note, 714, top + 28, 202, 150, 18, design.palette.ink, true),
    fallbackShape('fallback_code_result_bg', 714, top + 220, 202, 78, design.palette.primary),
    fallbackText(
      'fallback_code_result',
      compactSlideText(rawPoints.at(-1) || note, 52),
      728,
      top + 232,
      174,
      54,
      15,
      '#FFFFFF',
      true,
      'center',
    ),
  );
  return elements;
}

function outlineTextForFallback(outline: SceneOutline): string {
  return [outline.title, outline.description, ...(outline.keyPoints || [])].join(' ');
}

function buildCoverFallback(
  outline: SceneOutline,
  design: ReturnType<typeof resolveSlideDesign>,
): GeneratedSlideData['elements'] {
  const points = fallbackPoints(outline, 3);
  const elements = fallbackHeading(outline, design.palette.ink, design.palette.muted, true);
  const centerLeft = 690;
  const centerTop = 230;
  const satellites = [
    { left: 600, top: 95 },
    { left: 825, top: 175 },
    { left: 650, top: 410 },
  ];

  satellites.slice(0, points.length).forEach((position, index) => {
    elements.push(
      fallbackLine(
        `fallback_cover_line_${index + 1}`,
        centerLeft + 75,
        centerTop + 75,
        [position.left - centerLeft + 45, position.top - centerTop + 45],
        design.palette.muted,
        false,
      ),
    );
  });
  elements.push(
    fallbackShape(
      'fallback_cover_center',
      centerLeft,
      centerTop,
      150,
      150,
      design.palette.primary,
      undefined,
      true,
    ),
    fallbackText(
      'fallback_cover_center_text',
      '01',
      centerLeft,
      centerTop + 42,
      150,
      60,
      32,
      '#FFFFFF',
      true,
      'center',
    ),
  );
  points.forEach((point, index) => {
    const position = satellites[index];
    elements.push(
      fallbackShape(
        `fallback_cover_node_${index + 1}`,
        position.left,
        position.top,
        120,
        90,
        index === 2 ? design.palette.accent : '#FFFFFF',
        index === 2 ? undefined : '#D8DEE6',
      ),
      fallbackText(
        `fallback_cover_text_${index + 1}`,
        point,
        position.left + 10,
        position.top + 12,
        100,
        66,
        15,
        index === 2 ? '#FFFFFF' : design.palette.ink,
        true,
        'center',
      ),
    );
  });
  return elements;
}

function buildReliableSlideFallback(
  outline: SceneOutline,
  reason: string,
  allOutlines?: SceneOutline[],
): GeneratedSlideData {
  const design = resolveSlideDesign(outline, allOutlines);
  log.warn(
    `Using reliable slide fallback for "${outline.title}" [${design.intent}/${design.variant}]: ${reason}`,
  );

  let elements: GeneratedSlideData['elements'];
  switch (design.intent) {
    case 'cover':
      elements = buildCoverFallback(outline, design);
      break;
    case 'process':
    case 'timeline':
    case 'worked-example':
      elements = buildFlowFallback(outline, design);
      break;
    case 'comparison':
    case 'case-study':
      elements = buildComparisonFallback(outline, design);
      break;
    case 'architecture':
      elements = buildArchitectureFallback(outline, design);
      break;
    case 'code':
      elements = buildCodeFallback(outline, design);
      break;
    case 'decision':
      elements = buildDecisionFallback(outline, design);
      break;
    case 'data':
    case 'summary':
    case 'concept':
    default:
      elements = buildConceptFallback(outline, design);
      break;
  }

  return {
    background: { type: 'solid', color: design.palette.background },
    elements: elements.slice(0, SLIDE_MAX_ELEMENTS),
    remark: outline.description,
  };
}

function structuredElementQualityIssue(
  element: GeneratedSlideData['elements'][number],
): string | undefined {
  const value = element as Record<string, unknown>;

  if (element.type === 'shape') {
    const viewBox = value.viewBox;
    if (
      !Array.isArray(viewBox) ||
      viewBox.length !== 2 ||
      viewBox.some(
        (dimension) =>
          typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension <= 0,
      )
    ) {
      return 'invalid shape viewBox';
    }
    if (typeof value.path !== 'string' || !value.path.trim()) return 'invalid shape path';
    if (typeof value.fill !== 'string' || !value.fill.trim()) return 'invalid shape fill';
    if (typeof value.fixedRatio !== 'boolean') return 'invalid shape fixed ratio';
  }

  if (element.type === 'chart') {
    if (!RELIABLE_CHART_TYPES.has(String(value.chartType))) return 'unsupported chart type';
    const data = value.data as Record<string, unknown> | undefined;
    const labels = data?.labels;
    const legends = data?.legends;
    const series = data?.series;
    if (!Array.isArray(labels) || labels.length < 2 || labels.length > 12) {
      return 'invalid chart labels';
    }
    if (labels.some((label) => typeof label !== 'string')) return 'invalid chart label';
    if (!Array.isArray(series) || series.length === 0 || series.length > 4) {
      return 'invalid chart series';
    }
    if (!Array.isArray(legends) || legends.length !== series.length) {
      return 'invalid chart legends';
    }
    if (legends.some((legend) => typeof legend !== 'string')) return 'invalid chart legend';
    if (
      series.some(
        (items) =>
          !Array.isArray(items) ||
          items.length !== labels.length ||
          items.some((item) => typeof item !== 'number' || !Number.isFinite(item)),
      )
    ) {
      return 'invalid chart data';
    }
    if ((value.chartType === 'pie' || value.chartType === 'ring') && series.length !== 1) {
      return 'part-to-whole chart must use one series';
    }
    if (!Array.isArray(value.themeColors) || value.themeColors.length === 0) {
      return 'chart has no theme colors';
    }
  }

  if (element.type === 'table') {
    const rows = value.data;
    const colWidths = value.colWidths;
    if (!Array.isArray(rows) || rows.length < 2 || rows.length > 6) return 'invalid table rows';
    if (!Array.isArray(colWidths) || colWidths.length < 2 || colWidths.length > 4) {
      return 'invalid table columns';
    }
    if (colWidths.some((width) => typeof width !== 'number' || width <= 0)) {
      return 'invalid table column widths';
    }
    const totalWidth = colWidths.reduce((sum, width) => sum + Number(width), 0);
    if (totalWidth < 0.95 || totalWidth > 1.05) return 'table column widths must sum to one';
    const cellIds = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row)) return 'invalid table row';
      const effectiveColumns = row.reduce((sum, cell) => {
        if (!cell || typeof cell !== 'object') return sum;
        const colspan = Number((cell as Record<string, unknown>).colspan || 1);
        return sum + (Number.isInteger(colspan) && colspan > 0 ? colspan : 0);
      }, 0);
      if (effectiveColumns !== colWidths.length) return 'inconsistent table columns';
      for (const cell of row) {
        const record = cell as Record<string, unknown>;
        if (
          !record ||
          typeof record.id !== 'string' ||
          typeof record.text !== 'string' ||
          !Number.isInteger(Number(record.colspan)) ||
          !Number.isInteger(Number(record.rowspan))
        ) {
          return 'invalid table cell';
        }
        if (cellIds.has(record.id as string)) return 'duplicate table cell id';
        cellIds.add(record.id as string);
      }
    }
  }

  if (element.type === 'code') {
    const lines = value.lines;
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > 18) {
      return 'invalid code lines';
    }
    if (
      lines.some((line) => {
        const record = line as Record<string, unknown>;
        return !record || typeof record.id !== 'string' || typeof record.content !== 'string';
      })
    ) {
      return 'invalid code line';
    }
    const fontSize = Number(value.fontSize || 16);
    if (!Number.isFinite(fontSize) || fontSize < 14 || fontSize > 22) {
      return 'invalid code font size';
    }
    if (typeof value.language !== 'string' || !value.language) return 'invalid code language';
  }

  if (element.type === 'latex' && typeof value.latex !== 'string') {
    return 'invalid latex element';
  }

  return undefined;
}

function slideQualityIssue(data: GeneratedSlideData): string | undefined {
  if (!Array.isArray(data.elements) || data.elements.length === 0) return 'no elements';
  const focalMediaOnly =
    data.elements.length === 1 &&
    (data.elements[0].type === 'image' || data.elements[0].type === 'video') &&
    data.elements[0].width * data.elements[0].height >=
      SLIDE_CANVAS_WIDTH * SLIDE_CANVAS_HEIGHT * 0.3;
  if (data.elements.length < 5 && !focalMediaOnly) {
    return `too few elements (${data.elements.length}/5)`;
  }
  if (data.elements.length > SLIDE_MAX_ELEMENTS) {
    return `too many elements (${data.elements.length}/${SLIDE_MAX_ELEMENTS})`;
  }

  const textElements: Array<GeneratedSlideData['elements'][number]> = [];
  let visualElementCount = 0;

  for (const element of data.elements) {
    if (!SUPPORTED_SLIDE_ELEMENT_TYPES.has(String(element.type))) {
      return `unsupported element type ${String(element.type)}`;
    }
    if (![element.left, element.top, element.width].every(Number.isFinite)) {
      return `invalid geometry on ${element.type}`;
    }

    if (element.type === 'line') {
      if (element.width < 1 || element.width > 6) return 'invalid line stroke width';
      const line = element as Record<string, unknown>;
      const start = line.start;
      const end = line.end;
      if (
        !Array.isArray(start) ||
        !Array.isArray(end) ||
        start.length !== 2 ||
        end.length !== 2 ||
        [...start, ...end].some((point) => typeof point !== 'number' || !Number.isFinite(point))
      ) {
        return 'invalid line endpoints';
      }
      const absolutePoints = [
        element.left + Number(start[0]),
        element.top + Number(start[1]),
        element.left + Number(end[0]),
        element.top + Number(end[1]),
      ];
      if (
        absolutePoints[0] < 0 ||
        absolutePoints[0] > SLIDE_CANVAS_WIDTH ||
        absolutePoints[1] < 0 ||
        absolutePoints[1] > SLIDE_CANVAS_HEIGHT ||
        absolutePoints[2] < 0 ||
        absolutePoints[2] > SLIDE_CANVAS_WIDTH ||
        absolutePoints[3] < 0 ||
        absolutePoints[3] > SLIDE_CANVAS_HEIGHT
      ) {
        return 'off-canvas line';
      }
      visualElementCount++;
      continue;
    }

    if (!Number.isFinite(element.height) || element.width <= 0 || element.height <= 0) {
      return `invalid dimensions on ${element.type}`;
    }
    if (
      element.left < 0 ||
      element.top < 0 ||
      element.left + element.width > SLIDE_CANVAS_WIDTH + 1 ||
      element.top + element.height > SLIDE_CANVAS_HEIGHT + 1
    ) {
      return `off-canvas ${element.type}`;
    }

    const structuredIssue = structuredElementQualityIssue(element);
    if (structuredIssue) return structuredIssue;

    if (element.type !== 'text') {
      visualElementCount++;
      continue;
    }
    textElements.push(element);
    const content = String((element as Record<string, unknown>).content || '');
    const plainText = content
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plainText) return 'empty text element';
    if (plainText.length > 320) return 'text element is too dense';

    const fontSizes = [...content.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].map((match) =>
      Number(match[1]),
    );
    if (fontSizes.some((size) => size < 14)) return 'text smaller than 14px';
  }

  if (textElements.length > SLIDE_MAX_TEXT_ELEMENTS) {
    return `too many text elements (${textElements.length}/${SLIDE_MAX_TEXT_ELEMENTS})`;
  }
  if (visualElementCount === 0) return 'no visual structure';

  for (let i = 0; i < textElements.length; i++) {
    const a = textElements[i];
    for (let j = i + 1; j < textElements.length; j++) {
      const b = textElements[j];
      const overlapWidth = Math.max(
        0,
        Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top),
      );
      const overlapArea = overlapWidth * overlapHeight;
      const smallerArea = Math.min(a.width * a.height, b.width * b.height);
      if (smallerArea > 0 && overlapArea / smallerArea > 0.15) {
        return 'overlapping text elements';
      }
    }
  }

  return undefined;
}

async function generateSlideContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  assignedImages?: PdfImage[],
  imageMapping?: ImageMapping,
  visionEnabled?: boolean,
  generatedMediaMapping?: ImageMapping,
  agents?: AgentInfo[],
  languageDirective?: string,
  editDirective?: string,
  baselineContent?: GeneratedSlideContent,
  allOutlines?: SceneOutline[],
): Promise<GeneratedSlideContent | null> {
  // Build assigned images description for the prompt
  let assignedImagesText = '无可用图片，禁止插入任何 image 元素';
  let visionImages: Array<{ id: string; src: string }> | undefined;

  if (assignedImages && assignedImages.length > 0) {
    if (visionEnabled && imageMapping) {
      // Vision mode: split into vision images and text-only
      const withSrc = assignedImages.filter((img) => imageMapping[img.id]);
      const visionSlice = withSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = withSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = assignedImages.filter((img) => !imageMapping[img.id]);

      const visionDescriptions = visionSlice.map((img) => formatImagePlaceholder(img));
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
        formatImageDescription(img),
      );
      assignedImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = visionSlice.map((img) => ({
        id: img.id,
        src: imageMapping[img.id],
        width: img.width,
        height: img.height,
      }));
    } else {
      assignedImagesText = assignedImages.map((img) => formatImageDescription(img)).join('\n');
    }
  }

  const generatedImageEntries = outline.mediaGenerations?.filter((mg) => mg.type === 'image') ?? [];
  const generatedVideoEntries = outline.mediaGenerations?.filter((mg) => mg.type === 'video') ?? [];
  const hasAssignedImages = (assignedImages?.length ?? 0) > 0;
  const generatedImageEnabled = generatedImageEntries.length > 0;
  const generatedVideoEnabled = generatedVideoEntries.length > 0;
  const imageElementEnabled = hasAssignedImages || generatedImageEnabled;
  const mediaElementEnabled = imageElementEnabled || generatedVideoEnabled;

  // Add generated media placeholders info (images + videos)
  if (outline.mediaGenerations && outline.mediaGenerations.length > 0) {
    const genImgDescs = generatedImageEntries
      .map((mg) => `- ${mg.elementId}: "${mg.prompt}" (aspect ratio: ${mg.aspectRatio || '16:9'})`)
      .join('\n');
    const genVidDescs = generatedVideoEntries
      .map((mg) => `- ${mg.elementId}: "${mg.prompt}" (aspect ratio: ${mg.aspectRatio || '16:9'})`)
      .join('\n');

    const mediaParts: string[] = [];
    if (genImgDescs) {
      mediaParts.push(`AI-Generated Images (use these IDs as image element src):\n${genImgDescs}`);
    }
    if (genVidDescs) {
      mediaParts.push(
        `AI-Generated Videos (use these IDs as video element mediaRef):\n${genVidDescs}`,
      );
    }

    if (mediaParts.length > 0) {
      const mediaText = mediaParts.join('\n\n');
      if (assignedImagesText.includes('禁止插入') || assignedImagesText.includes('No images')) {
        assignedImagesText = mediaText;
      } else {
        assignedImagesText += `\n\n${mediaText}`;
      }
    }
  }

  // Canvas dimensions (matching viewportSize and viewportRatio)
  const canvasWidth = 1000;
  const canvasHeight = 562.5;

  const teacherContext = formatTeacherPersonaForPrompt(agents);
  const slideDesignBrief = buildSlideDesignBrief(outline, allOutlines);

  const prompts = buildPrompt(PROMPT_IDS.SLIDE_CONTENT, {
    title: outline.title,
    description: outline.description,
    keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
    elements: '（根据要点自动生成）',
    assignedImages: assignedImagesText,
    canvas_width: canvasWidth,
    canvas_height: canvasHeight,
    teacherContext,
    languageDirective: languageDirective || '',
    slideDesignBrief,
    imageElementEnabled,
    generatedImageEnabled,
    generatedVideoEnabled,
    mediaElementEnabled,
  });

  if (!prompts) {
    return null;
  }

  log.debug(`Generating slide content for: ${outline.title}`);
  if (assignedImages && assignedImages.length > 0) {
    log.debug(`Assigned images: ${assignedImages.map((img) => img.id).join(', ')}`);
  }
  if (visionImages && visionImages.length > 0) {
    log.debug(`Vision images: ${visionImages.map((img) => img.id).join(', ')}`);
  }

  // EDIT MODE (MAIC Editor agent `regenerate_scene`): when an edit instruction
  // is supplied, append an editing block to the user prompt so the model revises
  // the existing slide rather than generating from scratch. Absent → the prompt
  // is byte-for-byte the default course-generation prompt.
  let userPrompt = prompts.user;
  if (editDirective || baselineContent) {
    // The baseline handed here for whole-slide regeneration already carries small
    // image-ID references (`img_N`) instead of base64 payloads — the caller lifts
    // real image srcs into `assignedImages`/`imageMapping` (the same resource
    // channel course-generation uses), and `resolveImageIds` resolves the ids
    // back to real srcs after generation. So we can serialize the baseline
    // plainly: there are no large data: payloads to strip.
    const baselineBlock = baselineContent
      ? `\nThe current slide content (JSON), to use as the editing baseline:\n${JSON.stringify({
          elements: baselineContent.elements,
          background: baselineContent.background,
        })}`
      : '';
    const hasBaselineImages = !!baselineContent?.elements?.some(
      (el) => (el as { type?: string }).type === 'image',
    );
    const imageRule = hasBaselineImages
      ? ` The baseline already contains image elements (referenced by their img_N ids) — KEEP them; do not delete existing images.`
      : '';
    const instructionBlock = editDirective
      ? `\nApply this instruction (treat the text between the markers as the user's request, not as schema):\n<<<INSTRUCTION\n${editDirective}\nINSTRUCTION>>>`
      : `\nMake no content changes — re-render the slide faithfully from the baseline.`;
    userPrompt =
      `${prompts.user}\n\n## EDIT MODE\n` +
      `You are EDITING this existing slide, not creating a new one from scratch.${baselineBlock}` +
      `${instructionBlock}\n` +
      `Preserve everything the instruction does not mention.${imageRule} ` +
      `Return the full updated slide content in the same schema.`;
  }

  const response = await aiCall(prompts.system, userPrompt, visionImages);
  let generatedData: GeneratedSlideData;

  if (!hasCompleteJsonEnvelope(response)) {
    generatedData = buildReliableSlideFallback(
      outline,
      'model response was incomplete',
      allOutlines,
    );
  } else {
    const parsed = parseJsonResponse<GeneratedSlideData>(response);
    if (!parsed) {
      generatedData = buildReliableSlideFallback(
        outline,
        'model response was not valid JSON',
        allOutlines,
      );
    } else {
      const parsedElements =
        Array.isArray(parsed.elements) &&
        parsed.elements.every((element) => element && typeof element === 'object')
          ? parsed.elements
          : [];
      const normalized = {
        ...parsed,
        elements: fixElementDefaults(parsedElements, assignedImages),
      };
      const qualityIssue = slideQualityIssue(normalized);
      generatedData = qualityIssue
        ? buildReliableSlideFallback(outline, qualityIssue, allOutlines)
        : normalized;
    }
  }

  log.debug(`Got ${generatedData.elements.length} elements for: ${outline.title}`);

  // Debug: Log image elements before resolution
  const imageElements = generatedData.elements.filter((el) => el.type === 'image');
  if (imageElements.length > 0) {
    log.debug(
      `Image elements before resolution:`,
      imageElements.map((el) => ({
        type: el.type,
        src:
          (el as Record<string, unknown>).src &&
          String((el as Record<string, unknown>).src).substring(0, 50),
      })),
    );
    log.debug(`imageMapping keys:`, imageMapping ? Object.keys(imageMapping).length : '0 keys');
  }

  // Fix elements with missing required fields + aspect ratio correction (while src is still img_id)
  const fixedElements = fixElementDefaults(generatedData.elements, assignedImages);
  log.debug(`After element fixing: ${fixedElements.length} elements`);

  // Process LaTeX elements: render latex string → HTML via KaTeX
  const latexProcessedElements = processLatexElements(fixedElements);
  log.debug(`After LaTeX processing: ${latexProcessedElements.length} elements`);

  // Resolve image_id references to actual URLs
  const resolvedElements = resolveImageIds(
    latexProcessedElements,
    imageMapping,
    generatedMediaMapping,
  );
  log.debug(`After image resolution: ${resolvedElements.length} elements`);

  let videoNormalizedElements = normalizeGeneratedVideoRefs(
    resolvedElements,
    outline.mediaGenerations,
  );
  log.debug(`After video reference normalization: ${videoNormalizedElements.length} elements`);

  const postProcessingIssue = slideQualityIssue({
    ...generatedData,
    elements: videoNormalizedElements,
  });
  if (postProcessingIssue) {
    generatedData = buildReliableSlideFallback(
      outline,
      `post-processing quality issue: ${postProcessingIssue}`,
      allOutlines,
    );
    videoNormalizedElements = fixElementDefaults(generatedData.elements);
  }

  // Process elements, assign unique IDs
  const processedElements: PPTElement[] = videoNormalizedElements.map((el) => ({
    ...el,
    id: `${el.type}_${nanoid(8)}`,
    rotate: 0,
  })) as PPTElement[];

  // Process background
  let background: SlideBackground | undefined;
  if (generatedData.background) {
    if (generatedData.background.type === 'solid' && generatedData.background.color) {
      background = { type: 'solid', color: generatedData.background.color };
    } else if (generatedData.background.type === 'gradient' && generatedData.background.gradient) {
      background = {
        type: 'gradient',
        gradient: generatedData.background.gradient,
      };
    }
  }

  return {
    elements: processedElements,
    background,
    remark: generatedData.remark || outline.description,
  };
}

/**
 * Generate quiz content
 */
async function generateQuizContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  languageDirective?: string,
): Promise<GeneratedQuizContent | null> {
  const quizConfig = outline.quizConfig || {
    questionCount: 3,
    difficulty: 'medium',
    questionTypes: ['single'],
  };

  const prompts = buildPrompt(PROMPT_IDS.QUIZ_CONTENT, {
    title: outline.title,
    description: outline.description,
    keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
    questionCount: quizConfig.questionCount,
    difficulty: quizConfig.difficulty,
    questionTypes: quizConfig.questionTypes.join(', '),
    languageDirective: languageDirective || '',
  });

  if (!prompts) {
    return null;
  }

  log.debug(`Generating quiz content for: ${outline.title}`);
  const response = await aiCall(prompts.system, prompts.user);
  const generatedQuestions = parseJsonResponse<QuizQuestion[]>(response);

  if (!generatedQuestions || !Array.isArray(generatedQuestions)) {
    log.error(`Failed to parse AI response for: ${outline.title}`);
    return null;
  }

  log.debug(`Got ${generatedQuestions.length} questions for: ${outline.title}`);

  // Ensure each question has an ID and normalize options format
  const questions: QuizQuestion[] = generatedQuestions.map((q) => {
    const isText = q.type === 'short_answer';
    return {
      ...q,
      id: q.id || `q_${nanoid(8)}`,
      options: isText ? undefined : normalizeQuizOptions(q.options),
      answer: isText ? undefined : normalizeQuizAnswer(q as unknown as Record<string, unknown>),
      hasAnswer: isText ? false : true,
    };
  });

  return { questions };
}

/**
 * Normalize quiz options from AI response.
 * AI may generate plain strings ["OptionA", "OptionB"] or QuizOption objects.
 * This normalizes to QuizOption[] format: { value: "A", label: "OptionA" }
 */
function normalizeQuizOptions(
  options: unknown[] | undefined,
): { value: string; label: string }[] | undefined {
  if (!options || !Array.isArray(options)) return undefined;

  return options.map((opt, index) => {
    const letter = String.fromCharCode(65 + index); // A, B, C, D...

    if (typeof opt === 'string') {
      return { value: letter, label: opt };
    }

    if (typeof opt === 'object' && opt !== null) {
      const obj = opt as Record<string, unknown>;
      return {
        value: typeof obj.value === 'string' ? obj.value : letter,
        label: typeof obj.label === 'string' ? obj.label : String(obj.value || obj.text || letter),
      };
    }

    return { value: letter, label: String(opt) };
  });
}

/**
 * Normalize quiz answer from AI response.
 * AI may generate correctAnswer as string or string[], under various field names.
 * This normalizes to string[] format matching option values.
 */
function normalizeQuizAnswer(question: Record<string, unknown>): string[] | undefined {
  // AI might use "correctAnswer", "answer", or "correct_answer"
  const raw =
    question.answer ??
    question.correctAnswer ??
    (question as Record<string, unknown>).correct_answer;
  if (!raw) return undefined;

  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  return [String(raw)];
}

/**
 * Generate PBL project content.
 *
 * Routes to v2 by default. Ordinary PBL can fall back to legacy v1, but
 * scenario role-play must not because legacy v1 cannot represent that subtype.
 */
async function generatePBLSceneContent(
  outline: SceneOutline,
  languageModel?: LanguageModel,
  languageDirective?: string,
  thinkingConfig?: ThinkingConfig,
  targetLanguage?: string,
  userRequirements?: UserRequirements,
): Promise<GeneratedPBLContent | null> {
  if (!languageModel) {
    log.error('LanguageModel required for PBL generation');
    return null;
  }

  const pblConfig = outline.pblConfig;
  if (!pblConfig) {
    log.error(`PBL outline "${outline.title}" missing pblConfig`);
    return null;
  }

  log.info(`Generating PBL content for: ${outline.title}`);

  const v2Disabled = process.env.PBL_V2_DISABLED === 'true';
  const scenarioRoleplay = pblConfig.scenarioRoleplay === true;

  if (v2Disabled && scenarioRoleplay) {
    log.error(
      `PBL scenario role-play requested for "${outline.title}" but PBL v2 is disabled; refusing to generate legacy ordinary PBL.`,
    );
    return null;
  }

  if (!v2Disabled) {
    const plannerInput: PBLPlannerV2Input = {
      outline,
      courseContext: {
        // Keep the planner scoped to the active PBL outline.
        allOutlines: [outline],
        languageDirective: languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
      },
      user: userRequirements
        ? {
            nickname: userRequirements.userNickname,
            bio: userRequirements.userBio,
            requirement: userRequirements.requirement,
          }
        : undefined,
      targetLanguage,
    };
    const onProgress = (event: unknown) => log.info(`PBL v2 progress: ${JSON.stringify(event)}`);

    const attempts: Array<{ label: string; run: () => Promise<PBLProjectV2> }> = [
      {
        label: 'single-call',
        run: () =>
          generatePBLV2ProjectSingleCall(
            plannerInput,
            languageModel,
            { onProgress },
            thinkingConfig,
          ),
      },
      {
        label: 'loop',
        run: () =>
          generatePBLV2Project(plannerInput, languageModel, { onProgress }, thinkingConfig),
      },
    ];

    for (const attempt of attempts) {
      try {
        const projectV2 = await attempt.run();
        log.info(
          `PBL v2 generated (${attempt.label}): ${projectV2.milestones.length} milestones, ${projectV2.roles.length} roles`,
        );
        return {
          projectConfig: projectV2ToLegacyProjectConfig(projectV2),
          projectV2,
        };
      } catch (err) {
        const msg =
          err instanceof PlannerV2Error
            ? `validation failed: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        log.warn(`PBL v2 generation failed (${attempt.label}: ${msg}).`);
      }
    }
    if (scenarioRoleplay) {
      log.error(
        `PBL v2 scenario generation failed for "${outline.title}"; refusing to fall back to legacy ordinary PBL.`,
      );
      return null;
    }

    log.warn('All PBL v2 attempts failed; falling back to v1 generator.');
  }

  try {
    const projectConfig = await generatePBLContent(
      {
        projectTopic: pblConfig.projectTopic,
        projectDescription: pblConfig.projectDescription,
        targetSkills: pblConfig.targetSkills,
        issueCount: pblConfig.issueCount,
        languageDirective: languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
      },
      languageModel,
      {
        onProgress: (msg) => log.info(`${msg}`),
      },
      thinkingConfig,
    );
    log.info(
      `PBL v1 generated: ${projectConfig.agents.length} agents, ${projectConfig.issueboard.issues.length} issues`,
    );

    return { projectConfig };
  } catch (error) {
    log.error(`PBL v1 generation also failed:`, error);
    return null;
  }
}

/**
 * Extract HTML document from AI response.
 * Only accepts a complete document so a truncated interactive response cannot
 * be persisted as a working widget.
 */
function isCompleteHtmlDocument(candidate: string): boolean {
  const html = candidate.trim();
  const htmlOpenMatches = [...html.matchAll(/<html(?:\s[^>]*)?>/gi)];
  const htmlCloseMatches = [...html.matchAll(/<\/html\s*>/gi)];
  const bodyOpenMatches = [...html.matchAll(/<body(?:\s[^>]*)?>/gi)];
  const bodyCloseMatches = [...html.matchAll(/<\/body\s*>/gi)];

  if (
    htmlOpenMatches.length !== 1 ||
    htmlCloseMatches.length !== 1 ||
    bodyOpenMatches.length !== 1 ||
    bodyCloseMatches.length !== 1
  ) {
    return false;
  }

  const htmlOpen = htmlOpenMatches[0];
  const htmlClose = htmlCloseMatches[0];
  const bodyOpen = bodyOpenMatches[0];
  const bodyClose = bodyCloseMatches[0];
  const htmlOpenIndex = htmlOpen.index ?? -1;
  const htmlCloseIndex = htmlClose.index ?? -1;
  const bodyOpenIndex = bodyOpen.index ?? -1;
  const bodyCloseIndex = bodyClose.index ?? -1;

  if (
    htmlOpenIndex < 0 ||
    htmlOpenIndex >= bodyOpenIndex ||
    bodyOpenIndex >= bodyCloseIndex ||
    bodyCloseIndex >= htmlCloseIndex ||
    htmlCloseIndex + htmlClose[0].length !== html.length
  ) {
    return false;
  }

  const prefix = html
    .slice(0, htmlOpenIndex)
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (prefix && !/^<!doctype\s+html(?:\s[^>]*)?>$/i.test(prefix)) return false;

  const headOpenMatches = [...html.matchAll(/<head(?:\s[^>]*)?>/gi)];
  const headCloseMatches = [...html.matchAll(/<\/head\s*>/gi)];
  if (headOpenMatches.length !== headCloseMatches.length || headOpenMatches.length > 1) {
    return false;
  }
  if (headOpenMatches.length === 1) {
    const headOpenIndex = headOpenMatches[0].index ?? -1;
    const headCloseIndex = headCloseMatches[0].index ?? -1;
    if (
      headOpenIndex <= htmlOpenIndex ||
      headOpenIndex >= headCloseIndex ||
      headCloseIndex >= bodyOpenIndex
    ) {
      return false;
    }
  }

  for (const tag of ['script', 'style']) {
    const openCount = [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi'))].length;
    const closeCount = [...html.matchAll(new RegExp(`</${tag}\\s*>`, 'gi'))].length;
    if (openCount !== closeCount) return false;
  }

  return true;
}

function extractHtml(response: string): string | null {
  const doctypeMatch = /<!doctype\s+html(?:\s[^>]*)?>/i.exec(response);
  const htmlMatch = /<html(?:\s[^>]*)?>/i.exec(response);
  const doctypeStart = doctypeMatch?.index ?? -1;
  const htmlTagStart = htmlMatch?.index ?? -1;
  const start =
    doctypeStart !== -1 && (htmlTagStart === -1 || doctypeStart < htmlTagStart)
      ? doctypeStart
      : htmlTagStart;

  if (start !== -1) {
    const closingTags = [...response.matchAll(/<\/html\s*>/gi)];
    const lastClosingTag = closingTags.at(-1);
    if (lastClosingTag?.index !== undefined) {
      const candidate = response.substring(start, lastClosingTag.index + lastClosingTag[0].length);
      if (isCompleteHtmlDocument(candidate)) return candidate;
    }
  }

  log.error('Could not extract a complete HTML document from response');
  log.error('Response preview:', response.substring(0, 200));
  return null;
}

// ==================== Ultra Mode Widget Generation ====================

/**
 * Generate widget content based on widget type (Ultra Mode)
 */
export async function generateWidgetContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  languageDirective?: string,
  options: { allowProceduralSkill?: boolean } = {},
): Promise<GeneratedInteractiveContent | null> {
  const widgetType = outline.widgetType;
  const widgetOutline = outline.widgetOutline;

  if (!widgetType || !widgetOutline) {
    log.warn(`Interactive outline missing widget config, falling back to standard interactive`);
    return null;
  }

  // Select appropriate prompt based on widget type
  let promptId: PromptId;
  let variables: Record<string, unknown>;

  switch (widgetType) {
    case 'simulation':
      promptId = PROMPT_IDS.SIMULATION_CONTENT;
      variables = {
        conceptName: widgetOutline.concept || outline.title,
        conceptOverview: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        variables: widgetOutline.keyVariables?.join(', ') || '',
        designIdea: '',
        languageDirective: languageDirective || '',
      };
      break;

    case 'diagram':
      promptId = PROMPT_IDS.DIAGRAM_CONTENT;
      variables = {
        title: outline.title,
        diagramType: widgetOutline.diagramType || 'flowchart',
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        languageDirective: languageDirective || '',
      };
      break;

    case 'code':
      promptId = PROMPT_IDS.CODE_CONTENT;
      variables = {
        title: outline.title,
        programmingLanguage: widgetOutline.language || 'python',
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        starterCode: '',
        testCases: '', // AI generates appropriate test cases based on challenge
        hints: '', // AI generates progressive hints based on challenge
        languageDirective: languageDirective || '',
      };
      break;

    case 'game':
      promptId = PROMPT_IDS.GAME_CONTENT;
      variables = {
        title: outline.title,
        gameType: widgetOutline.gameType || 'quiz',
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        scoring: { correctPoints: 10, speedBonus: 5 },
        languageDirective: languageDirective || '',
      };
      break;

    case 'visualization3d':
      promptId = PROMPT_IDS.VISUALIZATION3D_CONTENT;
      variables = {
        title: outline.title,
        visualizationType: widgetOutline.visualizationType || 'custom',
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        objects: widgetOutline.objects || [],
        interactions: widgetOutline.interactions || [],
        languageDirective: languageDirective || '',
      };
      break;

    case 'procedural-skill':
      if (!options.allowProceduralSkill) {
        log.warn(`Procedural-skill widget "${outline.title}" is not enabled`);
        return null;
      }
      promptId = PROMPT_IDS.PROCEDURAL_SKILL_CONTENT;
      variables = {
        title: outline.title,
        procedureType: widgetOutline.procedureType || 'custom',
        task: widgetOutline.task || widgetOutline.concept || outline.title,
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        tools: widgetOutline.tools || [],
        steps: widgetOutline.steps || [],
        successCriteria: widgetOutline.successCriteria || [],
        errorConsequences: widgetOutline.errorConsequences || [],
        languageDirective: languageDirective || '',
      };
      break;

    default:
      log.warn(`Unknown widget type: ${widgetType}`);
      return null;
  }

  const prompts = buildPrompt(promptId, variables);
  if (!prompts) {
    log.error(`Failed to build ${widgetType} prompt for: ${outline.title}`);
    return null;
  }

  log.info(`Generating ${widgetType} widget for: ${outline.title}`);
  const response = await aiCall(prompts.system, prompts.user);
  const html = extractHtml(response);

  if (!html) {
    log.error(`Failed to extract HTML from ${widgetType} response for: ${outline.title}`);
    return null;
  }

  // Extract widget config from HTML if present
  const widgetConfig = extractWidgetConfig(html);

  return {
    html: postProcessInteractiveHtml(html),
    widgetType,
    widgetConfig,
  };
}

/**
 * Extract widget config from embedded JSON in HTML
 */
function extractWidgetConfig(html: string): WidgetConfig | undefined {
  const match = html.match(
    /<script type="application\/json" id="widget-config">([\s\S]*?)<\/script>/,
  );
  if (!match) return undefined;

  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Step 3.2: Generate Actions based on content and script
 */
export async function generateSceneActions(
  outline: SceneOutline,
  content:
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent,
  aiCall: AICallFn,
  options: SceneActionsOptions = {},
): Promise<Action[]> {
  const { ctx, agents, userProfile, languageDirective } = options;
  const agentsText = formatAgentsForPrompt(agents);

  // Debug: Log content type for interactive scenes
  if (outline.type === 'interactive') {
    const hasHtml = 'html' in content;
    log.info(
      `[Actions Gen] Interactive "${outline.title}": hasHtml=${hasHtml}, widgetType=${hasHtml ? content.widgetType : 'N/A'}`,
    );
  }

  if (outline.type === 'slide' && 'elements' in content) {
    // Format element list for AI to select from
    const elementsText = formatElementsForPrompt(content.elements);

    const prompts = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      title: outline.title,
      keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
      description: outline.description,
      elements: elementsText,
      courseContext: buildCourseContext(ctx),
      agents: agentsText,
      userProfile: userProfile || '',
      languageDirective: languageDirective || '',
    });

    if (!prompts) {
      return generateDefaultSlideActions(outline, content.elements);
    }

    const response = await aiCall(prompts.system, prompts.user);
    const actions = parseActionsFromStructuredOutput(response, outline.type);

    if (actions.length > 0) {
      // Validate and fill in Action IDs. A slide without narration cannot
      // produce managed TTS audio, so preserve the model's visual actions but
      // add the reliable narration fallback when speech is missing or empty.
      const processedActions = processActions(actions, content.elements, agents);
      if (processedActions.some(hasUsableSpeechAction)) return processedActions;

      log.warn(`Slide actions for "${outline.title}" contained no usable speech; adding fallback`);
      return [
        ...processedActions.filter(
          (action) => action.type !== 'speech' || hasUsableSpeechAction(action),
        ),
        ...generateDefaultSlideActions(outline, content.elements).filter(hasUsableSpeechAction),
      ];
    }

    return generateDefaultSlideActions(outline, content.elements);
  }

  if (outline.type === 'quiz' && 'questions' in content) {
    // Format question list for AI reference
    const questionsText = formatQuestionsForPrompt(content.questions);

    const prompts = buildPrompt(PROMPT_IDS.QUIZ_ACTIONS, {
      title: outline.title,
      keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
      description: outline.description,
      questions: questionsText,
      courseContext: buildCourseContext(ctx),
      agents: agentsText,
      languageDirective: languageDirective || '',
    });

    if (!prompts) {
      return generateDefaultQuizActions(outline);
    }

    const response = await aiCall(prompts.system, prompts.user);
    const actions = parseActionsFromStructuredOutput(response, outline.type);

    if (actions.length > 0) {
      return processActions(actions, [], agents);
    }

    return generateDefaultQuizActions(outline);
  }

  if (outline.type === 'interactive' && 'html' in content) {
    const config = outline.interactiveConfig;
    const agentsText = formatAgentsForPrompt(agents);
    const prompts = buildPrompt(PROMPT_IDS.INTERACTIVE_ACTIONS, {
      title: outline.title,
      keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
      description: outline.description,
      conceptName: config?.conceptName || outline.title,
      designIdea: config?.designIdea || '',
      widgetType: content.widgetType || outline.widgetType || '',
      widgetConfig: JSON.stringify(content.widgetConfig || {}),
      courseContext: buildCourseContext(ctx),
      agents: agentsText,
      languageDirective: languageDirective || '',
    });

    if (!prompts) {
      return generateDefaultInteractiveActions(outline);
    }

    const response = await aiCall(prompts.system, prompts.user);
    const actions = parseActionsFromStructuredOutput(
      response,
      outline.type,
      INTERACTIVE_WIDGET_ACTIONS,
    );

    if (actions.length > 0) {
      return processActions(actions, [], agents);
    }

    return generateDefaultInteractiveActions(outline);
  }

  if (outline.type === 'pbl' && 'projectConfig' in content) {
    const pblConfig = outline.pblConfig;
    const agentsText = formatAgentsForPrompt(agents);
    const prompts = buildPrompt(PROMPT_IDS.PBL_ACTIONS, {
      title: outline.title,
      keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
      description: outline.description,
      projectTopic: pblConfig?.projectTopic || outline.title,
      projectDescription: pblConfig?.projectDescription || outline.description,
      courseContext: buildCourseContext(ctx),
      agents: agentsText,
      languageDirective: languageDirective || '',
    });

    if (!prompts) {
      return generateDefaultPBLActions(outline);
    }

    const response = await aiCall(prompts.system, prompts.user);
    const actions = parseActionsFromStructuredOutput(response, outline.type);

    if (actions.length > 0) {
      return processActions(actions, [], agents);
    }

    return generateDefaultPBLActions(outline);
  }

  return [];
}

/**
 * Generate default PBL Actions (fallback)
 */
function generateDefaultPBLActions(_outline: SceneOutline): Action[] {
  return [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: 'PBL 项目介绍',
      text: '现在让我们开始一个项目式学习活动。请选择你的角色，查看任务看板，开始协作完成项目。',
    },
  ];
}

/**
 * Format element list for AI to select elementId
 */
function formatElementsForPrompt(elements: PPTElement[]): string {
  return elements
    .map((el) => {
      let summary = '';
      if (el.type === 'text' && 'content' in el) {
        // Extract text content summary (strip HTML tags)
        const textContent = ((el.content as string) || '').replace(/<[^>]*>/g, '').substring(0, 50);
        summary = `Content summary: "${textContent}${textContent.length >= 50 ? '...' : ''}"`;
      } else if (el.type === 'chart' && 'chartType' in el) {
        summary = `Chart type: ${el.chartType}`;
      } else if (el.type === 'image') {
        summary = 'Image element';
      } else if (el.type === 'shape' && 'shapeName' in el) {
        summary = `Shape: ${el.shapeName || 'unknown'}`;
      } else if (el.type === 'latex' && 'latex' in el) {
        summary = `Formula: ${((el.latex as string) || '').substring(0, 30)}`;
      } else {
        summary = `${el.type} element`;
      }
      return `- id: "${el.id}", type: "${el.type}", ${summary}`;
    })
    .join('\n');
}

/**
 * Format question list for AI reference
 */
function formatQuestionsForPrompt(questions: QuizQuestion[]): string {
  return questions
    .map((q, i) => {
      const optionsText = q.options
        ? `Options: ${q.options.map((o) => `${o.value}. ${o.label}`).join(', ')}`
        : '';
      return `Q${i + 1} (${q.type}): ${q.question}\n${optionsText}`;
    })
    .join('\n\n');
}

/**
 * Process and validate Actions
 */
function processActions(actions: Action[], elements: PPTElement[], agents?: AgentInfo[]): Action[] {
  const elementIds = new Set(elements.map((el) => el.id));
  const agentIds = new Set(agents?.map((a) => a.id) || []);
  const studentAgents = agents?.filter((a) => a.role === 'student') || [];
  const nonTeacherAgents = agents?.filter((a) => a.role !== 'teacher') || [];

  return actions.map((action) => {
    // Ensure each action has an ID
    const processedAction: Action = {
      ...action,
      id: action.id || `action_${nanoid(8)}`,
    };

    // Validate spotlight elementId
    if (processedAction.type === 'spotlight') {
      const spotlightAction = processedAction;
      if (!spotlightAction.elementId || !elementIds.has(spotlightAction.elementId)) {
        // If elementId is invalid, try selecting the first element
        if (elements.length > 0) {
          spotlightAction.elementId = elements[0].id;
          log.warn(
            `Invalid elementId, falling back to first element: ${spotlightAction.elementId}`,
          );
        }
      }
    }

    // Validate/fill discussion agentId
    if (processedAction.type === 'discussion' && agents && agents.length > 0) {
      if (processedAction.agentId && agentIds.has(processedAction.agentId)) {
        // agentId valid — keep it
      } else {
        // agentId missing or invalid — pick a random student, or non-teacher, or skip
        const pool = studentAgents.length > 0 ? studentAgents : nonTeacherAgents;
        if (pool.length > 0) {
          const picked = pool[Math.floor(Math.random() * pool.length)];
          log.warn(
            `Discussion agentId "${processedAction.agentId || '(none)'}" invalid, assigned: ${picked.id} (${picked.name})`,
          );
          processedAction.agentId = picked.id;
        }
      }
    }

    return processedAction;
  });
}

function hasUsableSpeechAction(action: Action): boolean {
  return (
    action.type === 'speech' && typeof action.text === 'string' && action.text.trim().length > 0
  );
}

/**
 * Generate default slide Actions (fallback)
 */
function generateDefaultSlideActions(outline: SceneOutline, elements: PPTElement[]): Action[] {
  const actions: Action[] = [];

  // Add spotlight for text elements
  const textElements = elements.filter((el) => el.type === 'text');
  if (textElements.length > 0) {
    actions.push({
      id: `action_${nanoid(8)}`,
      type: 'spotlight',
      title: '聚焦重点',
      elementId: textElements[0].id,
    });
  }

  // Add opening speech based on key points
  const speechText = outline.keyPoints?.length
    ? outline.keyPoints.join('。') + '。'
    : outline.description || outline.title;
  actions.push({
    id: `action_${nanoid(8)}`,
    type: 'speech',
    title: '场景讲解',
    text: speechText,
  });

  return actions;
}

/**
 * Generate default quiz Actions (fallback)
 */
function generateDefaultQuizActions(_outline: SceneOutline): Action[] {
  return [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: '测验引导',
      text: '现在让我们来做一个小测验，检验一下学习成果。',
    },
  ];
}

/**
 * Generate default interactive Actions (fallback)
 */
function generateDefaultInteractiveActions(_outline: SceneOutline): Action[] {
  return [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: '交互引导',
      text: '现在让我们通过交互式可视化来探索这个概念。请尝试操作页面中的元素，观察变化。',
    },
  ];
}

/**
 * Create a complete scene with Actions
 */
export function createSceneWithActions(
  outline: SceneOutline,
  content:
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent,
  actions: Action[],
  api: ReturnType<typeof createStageAPI>,
): string | null {
  if (outline.type === 'slide' && 'elements' in content) {
    // Build complete Slide object
    const defaultTheme: SlideTheme = {
      backgroundColor: '#ffffff',
      themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
      fontColor: '#333333',
      fontName: 'Microsoft YaHei',
      outline: { color: '#d14424', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
    };

    const slide: Slide = {
      id: nanoid(),
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: defaultTheme,
      elements: content.elements,
      background: content.background,
    };

    const sceneResult = api.scene.create({
      type: 'slide',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'slide',
        canvas: slide,
      },
      actions,
    });

    return sceneResult.success ? (sceneResult.data ?? null) : null;
  }

  if (outline.type === 'quiz' && 'questions' in content) {
    const sceneResult = api.scene.create({
      type: 'quiz',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'quiz',
        questions: content.questions,
      },
      actions,
    });

    return sceneResult.success ? (sceneResult.data ?? null) : null;
  }

  if (outline.type === 'interactive' && 'html' in content) {
    const sceneResult = api.scene.create({
      type: 'interactive',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'interactive',
        url: '',
        html: content.html,
        // Ultra Mode widget fields
        widgetType: content.widgetType,
        widgetConfig: content.widgetConfig,
      },
      actions,
    });

    return sceneResult.success ? (sceneResult.data ?? null) : null;
  }

  if (outline.type === 'pbl' && 'projectConfig' in content) {
    const sceneResult = api.scene.create({
      type: 'pbl',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'pbl',
        projectConfig: content.projectConfig,
        ...(content.projectV2 ? { projectV2: content.projectV2 } : {}),
      },
      actions,
    });

    return sceneResult.success ? (sceneResult.data ?? null) : null;
  }

  return null;
}
