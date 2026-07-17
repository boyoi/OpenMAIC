import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveClassroomMediaFilePath } from '@/app/api/classroom-media/[classroomId]/[...path]/route';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

async function makeSymlinkedClassroom() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openmaic-media-route-'));
  temporaryRoots.push(root);

  const runtimeRoot = path.join(root, 'runtime');
  const dataRoot = path.join(root, 'persistent-data');
  const classroomsDir = path.join(runtimeRoot, 'data', 'classrooms');
  const realClassroomDir = path.join(dataRoot, 'classrooms', 'classroom_1');
  await fs.mkdir(path.dirname(classroomsDir), { recursive: true });
  await fs.mkdir(path.join(realClassroomDir, 'audio'), { recursive: true });
  await fs.symlink(path.join(dataRoot, 'classrooms'), classroomsDir);

  return { root, classroomsDir, realClassroomDir };
}

describe('classroom media path resolution', () => {
  it('serves files when the classroom data root is symlinked', async () => {
    const { classroomsDir, realClassroomDir } = await makeSymlinkedClassroom();
    const audioPath = path.join(realClassroomDir, 'audio', 'narration.mp3');
    await fs.writeFile(audioPath, Buffer.from('audio'));

    await expect(
      resolveClassroomMediaFilePath(classroomsDir, 'classroom_1', ['audio', 'narration.mp3']),
    ).resolves.toBe(audioPath);
  });

  it('rejects a media symlink that escapes the real classroom directory', async () => {
    const { root, classroomsDir, realClassroomDir } = await makeSymlinkedClassroom();
    const outsidePath = path.join(root, 'outside.mp3');
    await fs.writeFile(outsidePath, Buffer.from('outside'));
    await fs.symlink(outsidePath, path.join(realClassroomDir, 'audio', 'escape.mp3'));

    await expect(
      resolveClassroomMediaFilePath(classroomsDir, 'classroom_1', ['audio', 'escape.mp3']),
    ).resolves.toBeNull();
  });
});
