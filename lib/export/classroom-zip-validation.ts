import JSZip from 'jszip';
import type { Scene } from '@/lib/types/stage';
import {
  CLASSROOM_ZIP_FORMAT_VERSION,
  type ClassroomManifest,
  type ManifestScene,
  type MediaIndexEntry,
} from './classroom-zip-types';

export type ClassroomExportValidationCode =
  | 'EMPTY_CLASSROOM'
  | 'DUPLICATE_SCENE'
  | 'DEGRADED_SCENE'
  | 'INLINE_ASSET_FAILED'
  | 'INVALID_MANIFEST'
  | 'SCENE_COUNT_MISMATCH'
  | 'MISSING_AUDIO'
  | 'MISSING_MEDIA'
  | 'INVALID_RESOURCE_PATH'
  | 'INVALID_CLASSROOM_ZIP';

export interface ClassroomExportValidationIssue {
  code: ClassroomExportValidationCode;
  message: string;
  sceneId?: string;
  resourcePath?: string;
}

export interface ClassroomInlineFailure {
  url: string;
  sceneId?: string;
  reason?: string;
}

interface ManifestValidationOptions {
  expectedSceneCount?: number;
}

function issue(
  code: ClassroomExportValidationCode,
  message: string,
  options: Pick<ClassroomExportValidationIssue, 'sceneId' | 'resourcePath'> = {},
): ClassroomExportValidationIssue {
  return { code, message, ...options };
}

function isSafeResourcePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function generatedMediaRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (/^gen_(?:img|vid)_[\w-]+$/i.test(value)) refs.add(value);
    return refs;
  }
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    for (const item of value) generatedMediaRefs(item, refs);
    return refs;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    generatedMediaRefs(item, refs);
  }
  return refs;
}

function mediaEntryMatchesRef(path: string, entry: MediaIndexEntry, ref: string): boolean {
  if (!entry || entry.missing || (entry.type !== 'generated' && entry.type !== 'image')) {
    return false;
  }
  const fileName = path.split('/').pop() ?? '';
  return fileName.replace(/\.[^.]+$/, '') === ref;
}

function validateManifestScene(
  scene: ManifestScene,
  mediaIndex: Record<string, MediaIndexEntry>,
): ClassroomExportValidationIssue[] {
  const issues: ClassroomExportValidationIssue[] = [];
  const actions = Array.isArray(scene.actions) ? scene.actions : [];
  for (const action of actions) {
    if (!action || action.type !== 'speech') continue;
    const audioRef = action.audioRef?.trim();
    if (!audioRef) {
      issues.push(issue('MISSING_AUDIO', `Speech action ${action.id} has no packaged TTS audio`));
      continue;
    }
    const entry = mediaIndex[audioRef];
    if (!entry || entry.type !== 'audio' || entry.missing) {
      issues.push(
        issue('MISSING_AUDIO', `Speech action ${action.id} references missing audio: ${audioRef}`, {
          resourcePath: audioRef,
        }),
      );
    }
  }

  for (const ref of generatedMediaRefs(scene.content)) {
    const matched = Object.entries(mediaIndex).some(([path, entry]) =>
      mediaEntryMatchesRef(path, entry, ref),
    );
    if (!matched) {
      issues.push(
        issue('MISSING_MEDIA', `Scene references generated media that is not packaged: ${ref}`, {
          resourcePath: ref,
        }),
      );
    }
  }
  return issues;
}

export function validateClassroomScenes(
  scenes: readonly Scene[],
): ClassroomExportValidationIssue[] {
  const issues: ClassroomExportValidationIssue[] = [];
  if (scenes.length === 0) {
    issues.push(issue('EMPTY_CLASSROOM', 'Classroom has no scenes to export'));
    return issues;
  }

  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const scene of scenes) {
    if (ids.has(scene.id) || orders.has(scene.order)) {
      issues.push(
        issue('DUPLICATE_SCENE', `Scene ${scene.title || scene.id} has a duplicate id or order`, {
          sceneId: scene.id,
        }),
      );
    }
    ids.add(scene.id);
    orders.add(scene.order);
    const quality = scene.quality as { status?: string; issues?: readonly string[] } | undefined;
    if (quality?.status === 'degraded' || quality?.status === 'failed') {
      issues.push(
        issue(
          'DEGRADED_SCENE',
          quality.issues?.[0] || `Scene ${scene.title || scene.id} used fallback content`,
          { sceneId: scene.id },
        ),
      );
    }
  }
  return issues;
}

export function validateClassroomInlineFailures(
  failures: readonly ClassroomInlineFailure[],
): ClassroomExportValidationIssue[] {
  return failures.map((failure) =>
    issue(
      'INLINE_ASSET_FAILED',
      `Interactive asset could not be packaged: ${failure.url}${failure.reason ? ` (${failure.reason})` : ''}`,
      { sceneId: failure.sceneId, resourcePath: failure.url },
    ),
  );
}

export function validateClassroomManifest(
  manifest: ClassroomManifest,
  options: ManifestValidationOptions = {},
): ClassroomExportValidationIssue[] {
  const issues: ClassroomExportValidationIssue[] = [];
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.formatVersion !== CLASSROOM_ZIP_FORMAT_VERSION ||
    !manifest.stage ||
    typeof manifest.stage.name !== 'string' ||
    !manifest.stage.name.trim() ||
    !Array.isArray(manifest.agents) ||
    !Array.isArray(manifest.scenes) ||
    typeof manifest.mediaIndex !== 'object' ||
    manifest.mediaIndex === null ||
    Array.isArray(manifest.mediaIndex)
  ) {
    issues.push(issue('INVALID_MANIFEST', 'Classroom manifest is missing required data'));
    return issues;
  }
  if (manifest.scenes.length === 0) {
    issues.push(issue('EMPTY_CLASSROOM', 'Classroom manifest has no scenes'));
  }
  if (
    options.expectedSceneCount !== undefined &&
    manifest.scenes.length !== options.expectedSceneCount
  ) {
    issues.push(
      issue(
        'SCENE_COUNT_MISMATCH',
        `Classroom manifest contains ${manifest.scenes.length} scenes; expected ${options.expectedSceneCount}`,
      ),
    );
  }

  const orders = new Set<number>();
  for (const scene of manifest.scenes) {
    if (
      !scene ||
      typeof scene !== 'object' ||
      !['slide', 'quiz', 'interactive', 'pbl'].includes(scene.type) ||
      typeof scene.title !== 'string' ||
      typeof scene.order !== 'number' ||
      !scene.content ||
      typeof scene.content !== 'object' ||
      scene.content.type !== scene.type
    ) {
      issues.push(issue('INVALID_MANIFEST', 'Classroom manifest contains an invalid scene'));
      continue;
    }
    if (orders.has(scene.order)) {
      issues.push(issue('DUPLICATE_SCENE', 'Classroom manifest has a duplicate scene order'));
    }
    orders.add(scene.order);
    if (scene.actions !== undefined && !Array.isArray(scene.actions)) {
      issues.push(issue('INVALID_MANIFEST', `Scene ${scene.title} has invalid actions`));
      continue;
    }
    issues.push(...validateManifestScene(scene, manifest.mediaIndex));
  }

  for (const [path, entry] of Object.entries(manifest.mediaIndex)) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !['audio', 'image', 'generated'].includes(entry.type)
    ) {
      issues.push(
        issue('INVALID_MANIFEST', `Manifest contains invalid resource metadata: ${path}`, {
          resourcePath: path,
        }),
      );
      continue;
    }
    if (
      !isSafeResourcePath(path) ||
      (entry.type === 'audio' ? !path.startsWith('audio/') : !path.startsWith('media/'))
    ) {
      issues.push(
        issue('INVALID_RESOURCE_PATH', `Manifest contains an invalid resource path: ${path}`, {
          resourcePath: path,
        }),
      );
    }
    if (entry.missing) {
      issues.push(
        issue(
          entry.type === 'audio' ? 'MISSING_AUDIO' : 'MISSING_MEDIA',
          `Manifest marks a required resource as missing: ${path}`,
          { resourcePath: path },
        ),
      );
    }
  }
  return issues;
}

function isPosterForIndexedMedia(
  path: string,
  mediaIndex: Record<string, MediaIndexEntry>,
): boolean {
  if (!path.endsWith('.poster.jpg')) return false;
  const base = path.slice(0, -'.poster.jpg'.length);
  return Object.entries(mediaIndex).some(
    ([indexedPath, entry]) =>
      !!entry &&
      typeof entry === 'object' &&
      entry.type === 'generated' &&
      indexedPath.startsWith(`${base}.`) &&
      !entry.missing,
  );
}

export async function validateClassroomZipBlob(
  blob: Blob,
  options: ManifestValidationOptions = {},
): Promise<ClassroomExportValidationIssue[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
  } catch (error) {
    return [
      issue(
        'INVALID_CLASSROOM_ZIP',
        `Classroom archive is invalid: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ];
  }

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    return [issue('INVALID_CLASSROOM_ZIP', 'Classroom archive is missing manifest.json')];
  }

  let manifest: ClassroomManifest;
  try {
    manifest = JSON.parse(await manifestFile.async('string')) as ClassroomManifest;
  } catch {
    return [issue('INVALID_MANIFEST', 'Classroom manifest is not valid JSON')];
  }

  const issues = validateClassroomManifest(manifest, options);
  const mediaIndex =
    manifest &&
    typeof manifest === 'object' &&
    manifest.mediaIndex &&
    typeof manifest.mediaIndex === 'object' &&
    !Array.isArray(manifest.mediaIndex)
      ? manifest.mediaIndex
      : {};
  for (const [path, entry] of Object.entries(mediaIndex)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.missing || !isSafeResourcePath(path)) continue;
    const resource = zip.file(path);
    if (!resource) {
      issues.push(
        issue(
          entry.type === 'audio' ? 'MISSING_AUDIO' : 'MISSING_MEDIA',
          `Classroom archive is missing a manifest resource: ${path}`,
          { resourcePath: path },
        ),
      );
      continue;
    }
    const bytes = await resource.async('uint8array');
    if (bytes.byteLength === 0) {
      issues.push(
        issue(
          entry.type === 'audio' ? 'MISSING_AUDIO' : 'MISSING_MEDIA',
          `Classroom archive contains an empty resource: ${path}`,
          { resourcePath: path },
        ),
      );
    }
  }

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || (!path.startsWith('audio/') && !path.startsWith('media/'))) continue;
    if (!isSafeResourcePath(path)) {
      issues.push(
        issue('INVALID_RESOURCE_PATH', `Archive contains an invalid resource path: ${path}`, {
          resourcePath: path,
        }),
      );
      continue;
    }
    if (!mediaIndex[path] && !isPosterForIndexedMedia(path, mediaIndex)) {
      issues.push(
        issue('INVALID_MANIFEST', `Archive resource is not listed in the manifest: ${path}`, {
          resourcePath: path,
        }),
      );
    }
  }
  return issues;
}

export class ClassroomExportValidationError extends Error {
  readonly issues: ClassroomExportValidationIssue[];

  constructor(issues: ClassroomExportValidationIssue[]) {
    super(
      issues
        .slice(0, 3)
        .map((item) => item.message)
        .join('; ') || 'Classroom validation failed',
    );
    this.name = 'ClassroomExportValidationError';
    this.issues = issues;
  }
}

export function assertClassroomExportValid(issues: ClassroomExportValidationIssue[]): void {
  if (issues.length > 0) throw new ClassroomExportValidationError(issues);
}
