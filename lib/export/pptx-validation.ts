import JSZip from 'jszip';
import type { PPTElement, Slide } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';
import type { MediaTask } from '@/lib/store/media-generation';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import { toPoints } from '@/lib/export/svg-path-parser';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

export type ExportValidationCode =
  | 'DECK_NOT_COMPLETE'
  | 'EMPTY_DECK'
  | 'DUPLICATE_SCENE'
  | 'UNSUPPORTED_SCENE'
  | 'DEGRADED_SCENE'
  | 'INVALID_SLIDE'
  | 'INVALID_ELEMENT'
  | 'INVALID_LINK'
  | 'MISSING_MEDIA'
  | 'INTERACTIVE_RUNTIME_ERROR'
  | 'INTERACTIVE_NOT_READY'
  | 'SLIDE_RENDER_FAILED'
  | 'SLIDE_RENDER_BLANK'
  | 'INVALID_PPTX'
  | 'PPTX_PAGE_MISMATCH'
  | 'PPTX_RELATIONSHIP_MISSING'
  | 'PPTX_ROUNDTRIP_FAILED';

export interface ExportValidationIssue {
  code: ExportValidationCode;
  message: string;
  sceneId?: string;
  elementId?: string;
}

export interface ExportSnapshotValidationInput {
  scenes: readonly Scene[];
  generationComplete: boolean;
  hasOutlines: boolean;
  mediaTasks?: Readonly<Record<string, Pick<MediaTask, 'status' | 'objectUrl' | 'error'>>>;
  runtimeErrors?: Readonly<Record<string, readonly string[]>>;
}

interface SceneQualityLike {
  status?: string;
  issues?: readonly string[];
}

const SUPPORTED_ELEMENT_TYPES = new Set([
  'text',
  'image',
  'shape',
  'line',
  'chart',
  'table',
  'latex',
  'video',
  'audio',
  'code',
]);

function issue(
  code: ExportValidationCode,
  message: string,
  sceneId?: string,
  elementId?: string,
): ExportValidationIssue {
  return { code, message, ...(sceneId ? { sceneId } : {}), ...(elementId ? { elementId } : {}) };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateGradient(
  value: unknown,
  label: string,
  sceneId: string,
  elementId?: string,
): ExportValidationIssue[] {
  const gradient = value as
    | { type?: unknown; colors?: Array<{ pos?: unknown; color?: unknown }>; rotate?: unknown }
    | undefined;
  if (!gradient || (gradient.type !== 'linear' && gradient.type !== 'radial')) {
    return [issue('INVALID_ELEMENT', `${label} gradient type is invalid`, sceneId, elementId)];
  }
  if (!Array.isArray(gradient.colors) || gradient.colors.length < 2) {
    return [
      issue(
        'INVALID_ELEMENT',
        `${label} gradient requires at least two colors`,
        sceneId,
        elementId,
      ),
    ];
  }
  if (
    gradient.colors.some(
      (color) =>
        !isFiniteNumber(color.pos) ||
        color.pos < 0 ||
        color.pos > 100 ||
        typeof color.color !== 'string' ||
        !color.color.trim(),
    )
  ) {
    return [
      issue('INVALID_ELEMENT', `${label} gradient contains an invalid stop`, sceneId, elementId),
    ];
  }
  if (!isFiniteNumber(gradient.rotate)) {
    return [issue('INVALID_ELEMENT', `${label} gradient rotation is invalid`, sceneId, elementId)];
  }
  return [];
}

function validateElement(
  element: PPTElement,
  slide: Slide,
  sceneId: string,
  slideIds: ReadonlySet<string>,
  mediaTasks: ExportSnapshotValidationInput['mediaTasks'],
): ExportValidationIssue[] {
  const issues: ExportValidationIssue[] = [];
  const elementId = typeof element.id === 'string' ? element.id : undefined;
  const record = element as unknown as Record<string, unknown>;

  if (!elementId?.trim()) {
    issues.push(issue('INVALID_ELEMENT', 'Slide element is missing an id', sceneId));
  }
  if (!SUPPORTED_ELEMENT_TYPES.has(String(record.type))) {
    issues.push(
      issue(
        'INVALID_ELEMENT',
        `Unsupported element type: ${String(record.type)}`,
        sceneId,
        elementId,
      ),
    );
    return issues;
  }

  if (![record.left, record.top, record.width].every(isFiniteNumber)) {
    issues.push(issue('INVALID_ELEMENT', 'Element geometry is not finite', sceneId, elementId));
    return issues;
  }

  const canvasWidth = slide.viewportSize;
  const canvasHeight = slide.viewportSize * slide.viewportRatio;
  if (element.type === 'line') {
    const points = [...element.start, ...element.end];
    if (points.some((point) => !isFiniteNumber(point))) {
      issues.push(issue('INVALID_ELEMENT', 'Line endpoints are invalid', sceneId, elementId));
    } else {
      const absolute = [
        element.left + element.start[0],
        element.top + element.start[1],
        element.left + element.end[0],
        element.top + element.end[1],
      ];
      if (
        absolute[0] < 0 ||
        absolute[0] > canvasWidth ||
        absolute[1] < 0 ||
        absolute[1] > canvasHeight ||
        absolute[2] < 0 ||
        absolute[2] > canvasWidth ||
        absolute[3] < 0 ||
        absolute[3] > canvasHeight
      ) {
        issues.push(
          issue('INVALID_ELEMENT', 'Line is outside the slide canvas', sceneId, elementId),
        );
      }
    }
  } else {
    if (!isFiniteNumber(record.height) || element.width <= 0 || Number(record.height) <= 0) {
      issues.push(issue('INVALID_ELEMENT', 'Element dimensions are invalid', sceneId, elementId));
    } else if (
      element.left < 0 ||
      element.top < 0 ||
      element.left + element.width > canvasWidth + 1 ||
      element.top + Number(record.height) > canvasHeight + 1
    ) {
      issues.push(
        issue('INVALID_ELEMENT', 'Element is outside the slide canvas', sceneId, elementId),
      );
    }
  }

  if (element.link) {
    if (element.link.type === 'web' && !isValidHttpUrl(element.link.target)) {
      issues.push(
        issue('INVALID_LINK', 'Element contains an invalid web link', sceneId, elementId),
      );
    }
    if (element.link.type === 'slide' && !slideIds.has(element.link.target)) {
      issues.push(issue('INVALID_LINK', 'Element links to a missing slide', sceneId, elementId));
    }
  }

  switch (element.type) {
    case 'text': {
      const text = plainText(element.content);
      if (!text) {
        issues.push(issue('INVALID_ELEMENT', 'Text element is empty', sceneId, elementId));
        break;
      }
      const estimatedCapacity = Math.max(
        1,
        Math.floor(element.width / 8) * Math.floor(element.height / 18),
      );
      if (text.length > Math.max(120, estimatedCapacity * 3)) {
        issues.push(
          issue('INVALID_ELEMENT', 'Text is too dense for its bounding box', sceneId, elementId),
        );
      }
      break;
    }
    case 'image': {
      if (!element.src?.trim()) {
        issues.push(issue('MISSING_MEDIA', 'Image source is missing', sceneId, elementId));
      } else if (isMediaPlaceholder(element.src)) {
        const task = mediaTasks?.[element.src];
        if (task?.status !== 'done' || !task.objectUrl) {
          issues.push(issue('MISSING_MEDIA', 'Generated image is not ready', sceneId, elementId));
        }
      }
      break;
    }
    case 'shape': {
      if (
        !Array.isArray(element.viewBox) ||
        element.viewBox.length !== 2 ||
        element.viewBox.some((value) => !isFiniteNumber(value) || value <= 0)
      ) {
        issues.push(issue('INVALID_ELEMENT', 'Shape viewBox is invalid', sceneId, elementId));
      }
      if (typeof element.path !== 'string' || toPoints(element.path).length === 0) {
        issues.push(issue('INVALID_ELEMENT', 'Shape path is invalid', sceneId, elementId));
      }
      if (element.gradient) {
        issues.push(...validateGradient(element.gradient, 'Shape', sceneId, elementId));
      }
      break;
    }
    case 'chart': {
      const labels = element.data?.labels;
      const legends = element.data?.legends;
      const series = element.data?.series;
      if (
        !Array.isArray(labels) ||
        labels.length === 0 ||
        !Array.isArray(legends) ||
        legends.length === 0 ||
        !Array.isArray(series) ||
        series.length !== legends.length ||
        series.some(
          (row) =>
            !Array.isArray(row) ||
            row.length !== labels.length ||
            row.some((value) => !isFiniteNumber(value)),
        )
      ) {
        issues.push(issue('INVALID_ELEMENT', 'Chart data is inconsistent', sceneId, elementId));
      }
      break;
    }
    case 'table': {
      const columnCount = element.data?.[0]?.length ?? 0;
      if (
        !Array.isArray(element.data) ||
        element.data.length === 0 ||
        columnCount === 0 ||
        element.data.some((row) => !Array.isArray(row) || row.length !== columnCount) ||
        !Array.isArray(element.colWidths) ||
        element.colWidths.length !== columnCount
      ) {
        issues.push(
          issue('INVALID_ELEMENT', 'Table dimensions are inconsistent', sceneId, elementId),
        );
      }
      break;
    }
    case 'latex':
      if (!element.latex?.trim()) {
        issues.push(issue('INVALID_ELEMENT', 'Formula is empty', sceneId, elementId));
      }
      break;
    case 'video': {
      const source = element.src || element.mediaRef;
      if (!source?.trim()) {
        issues.push(issue('MISSING_MEDIA', 'Video source is missing', sceneId, elementId));
      } else if (isMediaPlaceholder(source)) {
        const task = mediaTasks?.[source];
        if (task?.status !== 'done' || !task.objectUrl) {
          issues.push(issue('MISSING_MEDIA', 'Generated video is not ready', sceneId, elementId));
        }
      }
      break;
    }
    case 'audio':
      if (!element.src?.trim()) {
        issues.push(issue('MISSING_MEDIA', 'Audio source is missing', sceneId, elementId));
      }
      break;
    case 'code':
      if (
        !element.language?.trim() ||
        !Array.isArray(element.lines) ||
        element.lines.length === 0 ||
        element.lines.some((line) => !line.id?.trim() || typeof line.content !== 'string')
      ) {
        issues.push(issue('INVALID_ELEMENT', 'Code block is invalid', sceneId, elementId));
      }
      break;
  }

  return issues;
}

function validateSlide(
  scene: Scene,
  slide: Slide,
  slideIds: ReadonlySet<string>,
  mediaTasks: ExportSnapshotValidationInput['mediaTasks'],
): ExportValidationIssue[] {
  const issues: ExportValidationIssue[] = [];
  if (
    !slide?.id?.trim() ||
    !isFiniteNumber(slide.viewportSize) ||
    slide.viewportSize <= 0 ||
    !isFiniteNumber(slide.viewportRatio) ||
    slide.viewportRatio <= 0
  ) {
    issues.push(issue('INVALID_SLIDE', 'Slide viewport is invalid', scene.id));
    return issues;
  }
  if (!Array.isArray(slide.elements) || slide.elements.length === 0) {
    issues.push(issue('INVALID_SLIDE', 'Slide has no elements', scene.id));
    return issues;
  }

  const elementIds = new Set<string>();
  for (const element of slide.elements) {
    if (elementIds.has(element.id)) {
      issues.push(
        issue('INVALID_ELEMENT', 'Slide contains duplicate element ids', scene.id, element.id),
      );
    }
    elementIds.add(element.id);
    issues.push(...validateElement(element, slide, scene.id, slideIds, mediaTasks));
  }

  const textElements = slide.elements.filter((element) => element.type === 'text');
  for (let index = 0; index < textElements.length; index++) {
    const first = textElements[index];
    for (let otherIndex = index + 1; otherIndex < textElements.length; otherIndex++) {
      const second = textElements[otherIndex];
      const overlapWidth = Math.max(
        0,
        Math.min(first.left + first.width, second.left + second.width) -
          Math.max(first.left, second.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(first.top + first.height, second.top + second.height) -
          Math.max(first.top, second.top),
      );
      const smallerArea = Math.min(first.width * first.height, second.width * second.height);
      if (smallerArea > 0 && (overlapWidth * overlapHeight) / smallerArea > 0.15) {
        issues.push(
          issue(
            'INVALID_ELEMENT',
            `Text elements ${first.id} and ${second.id} overlap`,
            scene.id,
            second.id,
          ),
        );
      }
    }
  }

  const background = slide.background;
  if (background?.type === 'solid' && !background.color?.trim()) {
    issues.push(issue('INVALID_SLIDE', 'Solid slide background is missing a color', scene.id));
  }
  if (background?.type === 'image' && !background.image?.src?.trim()) {
    issues.push(issue('MISSING_MEDIA', 'Slide background image is missing', scene.id));
  }
  if (background?.type === 'gradient') {
    issues.push(...validateGradient(background.gradient, 'Slide background', scene.id));
  }
  return issues;
}

export function validateExportSnapshot({
  scenes,
  generationComplete,
  hasOutlines,
  mediaTasks,
  runtimeErrors = {},
}: ExportSnapshotValidationInput): ExportValidationIssue[] {
  const issues: ExportValidationIssue[] = [];
  if (hasOutlines && !generationComplete) {
    issues.push(issue('DECK_NOT_COMPLETE', 'Course generation has not completed'));
  }
  if (scenes.length === 0) {
    issues.push(issue('EMPTY_DECK', 'The presentation has no scenes'));
    return issues;
  }

  const sceneIds = new Set<string>();
  const sceneOrders = new Set<number>();
  const slideIds = new Set(
    scenes.flatMap((scene) => (scene.content.type === 'slide' ? [scene.content.canvas.id] : [])),
  );

  for (const scene of scenes) {
    if (sceneIds.has(scene.id) || sceneOrders.has(scene.order)) {
      issues.push(
        issue('DUPLICATE_SCENE', 'Presentation contains duplicate scene ids or orders', scene.id),
      );
    }
    sceneIds.add(scene.id);
    sceneOrders.add(scene.order);

    const quality = (scene as unknown as { quality?: SceneQualityLike }).quality;
    if (quality?.status === 'degraded' || quality?.status === 'failed') {
      issues.push(
        issue(
          'DEGRADED_SCENE',
          quality.issues?.[0] || 'Scene was produced by a degraded fallback',
          scene.id,
        ),
      );
    }

    if (scene.content.type === 'slide') {
      issues.push(...validateSlide(scene, scene.content.canvas, slideIds, mediaTasks));
      continue;
    }
    if (scene.content.type === 'interactive') {
      if (!scene.content.html?.trim() && !isValidHttpUrl(scene.content.url)) {
        issues.push(
          issue('INTERACTIVE_NOT_READY', 'Interactive scene has no usable content', scene.id),
        );
      }
      const errors = runtimeErrors[scene.id] ?? [];
      if (errors.length > 0) {
        issues.push(issue('INTERACTIVE_RUNTIME_ERROR', errors[0], scene.id));
      }
      continue;
    }

    issues.push(
      issue(
        'UNSUPPORTED_SCENE',
        `Scene type ${scene.content.type} cannot be represented completely in PPTX`,
        scene.id,
      ),
    );
  }

  return issues;
}

interface InteractiveProbePayload {
  token?: string;
  textLength?: number;
  elementCount?: number;
  visualCount?: number;
  width?: number;
  height?: number;
}

function injectInteractiveProbe(html: string, token: string): string {
  const script = `<script data-maic-export-probe>(function(){setTimeout(function(){try{var b=document.body;var q='img,svg,canvas,video,audio,button,input,select,textarea,[role="button"]';window.parent.postMessage({__maicExportProbe:true,token:${JSON.stringify(token)},textLength:(b&&b.innerText||'').trim().length,elementCount:b?b.querySelectorAll('*').length:0,visualCount:b?b.querySelectorAll(q).length:0,width:b?b.scrollWidth:0,height:b?b.scrollHeight:0},'*');}catch(e){}},600);})();</script>`;
  const bodyClose = html.toLowerCase().lastIndexOf('</body>');
  return bodyClose >= 0
    ? `${html.slice(0, bodyClose)}${script}${html.slice(bodyClose)}`
    : `${html}${script}`;
}

export async function validateInteractiveRuntime(
  scene: Scene,
  timeoutMs = 3_000,
): Promise<ExportValidationIssue[]> {
  if (scene.content.type !== 'interactive' || !scene.content.html?.trim()) return [];
  const html = scene.content.html;
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return [issue('INTERACTIVE_NOT_READY', 'Interactive validation requires a browser', scene.id)];
  }

  const token = `${scene.id}:${Date.now()}:${Math.random()}`;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:absolute;left:-100000px;top:0;width:1000px;height:563px;border:0;visibility:hidden;';
  const runtimeErrors: string[] = [];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (issues: ExportValidationIssue[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
      resolve(issues);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as
        | (InteractiveProbePayload & { __maicExportProbe?: boolean })
        | { __maicInteractive?: boolean; kind?: string; message?: unknown };
      if (
        data &&
        '__maicInteractive' in data &&
        data.__maicInteractive &&
        data.kind === 'runtime-error'
      ) {
        runtimeErrors.push(String(data.message ?? 'Interactive runtime error'));
        return;
      }
      if (
        !data ||
        !('__maicExportProbe' in data) ||
        !data.__maicExportProbe ||
        data.token !== token
      ) {
        return;
      }
      if (runtimeErrors.length > 0) {
        finish([issue('INTERACTIVE_RUNTIME_ERROR', runtimeErrors[0], scene.id)]);
        return;
      }
      const hasContent =
        Number(data.textLength || 0) >= 2 ||
        Number(data.visualCount || 0) > 0 ||
        Number(data.elementCount || 0) >= 3;
      const hasLayout = Number(data.width || 0) > 0 && Number(data.height || 0) > 0;
      finish(
        hasContent && hasLayout
          ? []
          : [issue('INTERACTIVE_NOT_READY', 'Interactive scene rendered blank', scene.id)],
      );
    };
    const timer = setTimeout(
      () =>
        finish([
          issue(
            runtimeErrors.length > 0 ? 'INTERACTIVE_RUNTIME_ERROR' : 'INTERACTIVE_NOT_READY',
            runtimeErrors[0] || 'Interactive scene did not become ready',
            scene.id,
          ),
        ]),
      timeoutMs,
    );
    window.addEventListener('message', onMessage);
    document.body.appendChild(iframe);
    iframe.srcdoc = patchHtmlForIframe(injectInteractiveProbe(html, token));
  });
}

async function imageHasVisibleContent(blob: Blob): Promise<boolean> {
  if (blob.size < 512) return false;
  if (typeof document === 'undefined') return true;

  const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(blob) : null;
  if (!bitmap) return true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return true;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const reference = [pixels[0], pixels[1], pixels[2], pixels[3]];
    let different = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const delta =
        Math.abs(pixels[index] - reference[0]) +
        Math.abs(pixels[index + 1] - reference[1]) +
        Math.abs(pixels[index + 2] - reference[2]) +
        Math.abs(pixels[index + 3] - reference[3]);
      if (delta > 24) different++;
    }
    return different / (pixels.length / 4) >= 0.002;
  } finally {
    bitmap.close();
  }
}

export async function validateSlideRenders(
  slides: readonly Slide[],
): Promise<ExportValidationIssue[]> {
  if (typeof document === 'undefined') return [];
  const issues: ExportValidationIssue[] = [];
  const { slideToPng } = await import('@openmaic/renderer/snapshot');
  for (const slide of slides) {
    try {
      const rendered = await slideToPng(slide, { width: 960, pixelRatio: 1, timeoutMs: 8_000 });
      const blob = rendered instanceof Blob ? rendered : await (await fetch(rendered)).blob();
      if (!(await imageHasVisibleContent(blob))) {
        issues.push(issue('SLIDE_RENDER_BLANK', `Slide ${slide.id} rendered blank`));
      }
    } catch (error) {
      issues.push(
        issue(
          'SLIDE_RENDER_FAILED',
          `Slide ${slide.id} failed to render: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  return issues;
}

function resolveZipTarget(baseDir: string, target: string): string {
  const parts = `${baseDir}/${target}`.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}

function relationshipSourcePath(relPath: string): string {
  if (relPath === '_rels/.rels') return '';
  const marker = '/_rels/';
  const markerIndex = relPath.lastIndexOf(marker);
  if (markerIndex < 0) return relPath.replace(/\.rels$/, '');
  const prefix = relPath.slice(0, markerIndex);
  const name = relPath.slice(markerIndex + marker.length).replace(/\.rels$/, '');
  return `${prefix}/${name}`;
}

export async function validatePptxBlob(
  blob: Blob,
  expectedPageCount: number,
): Promise<ExportValidationIssue[]> {
  const issues: ExportValidationIssue[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
  } catch (error) {
    return [
      issue(
        'INVALID_PPTX',
        `PPTX archive is invalid: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ];
  }

  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
  ];
  for (const path of required) {
    if (!zip.file(path)) issues.push(issue('INVALID_PPTX', `PPTX is missing ${path}`));
  }

  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  if (slidePaths.length !== expectedPageCount) {
    issues.push(
      issue(
        'PPTX_PAGE_MISMATCH',
        `PPTX contains ${slidePaths.length} pages; expected ${expectedPageCount}`,
      ),
    );
  }
  for (const path of slidePaths) {
    const xml = await zip.file(path)?.async('string');
    if (!xml || !/<p:sld\b/.test(xml)) {
      issues.push(issue('INVALID_PPTX', `PPTX slide entry is invalid: ${path}`));
    }
  }

  const relationshipPaths = Object.keys(zip.files).filter((path) => path.endsWith('.rels'));
  for (const relPath of relationshipPaths) {
    const xml = await zip.file(relPath)?.async('string');
    if (!xml) continue;
    const sourcePath = relationshipSourcePath(relPath);
    const baseDir = sourcePath.includes('/')
      ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
      : '';
    for (const tag of xml.match(/<Relationship\b[^>]*\/?>(?:<\/Relationship>)?/g) ?? []) {
      if (/TargetMode=["']External["']/i.test(tag)) continue;
      const target = /Target=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!target) continue;
      const resolved = resolveZipTarget(baseDir, target.replace(/^\//, ''));
      if (!zip.file(resolved)) {
        issues.push(
          issue(
            'PPTX_RELATIONSHIP_MISSING',
            `PPTX relationship points to a missing entry: ${relPath} -> ${resolved}`,
          ),
        );
      }
    }
  }
  return issues;
}

export class ExportValidationError extends Error {
  readonly issues: ExportValidationIssue[];

  constructor(issues: ExportValidationIssue[]) {
    const summary = issues
      .slice(0, 3)
      .map((item) => item.message)
      .join('; ');
    super(summary || 'Presentation validation failed');
    this.name = 'ExportValidationError';
    this.issues = issues;
  }
}

export function assertExportValid(issues: ExportValidationIssue[]): void {
  if (issues.length > 0) throw new ExportValidationError(issues);
}
