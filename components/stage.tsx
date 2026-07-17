'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { nanoid } from 'nanoid';
import { useStageStore } from '@/lib/store';
import { isCurrentSceneEditable } from '@/lib/edit/stage-mode';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { EditChromeRoot } from '@/components/edit/EditChromeRoot';
import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';
import { useEditModeLock } from '@/components/edit/use-edit-mode-lock';
import { MultiTabEditConflictPrompt } from '@/components/edit/MultiTabEditConflictPrompt';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';
import { CHROME_EASE } from '@/lib/edit/transitions';
import { preloadEditor } from '@/lib/edit/preload-editor';
import { getSceneFeedbackKind, type SceneFeedbackIntent } from '@/lib/agent/client/scene-feedback';
import type { SceneFeedbackSubmission } from '@/components/stage/scene-feedback-button';

/**
 * Stage — top-level classroom container. Dispatches between the two
 * chrome roots based on `useStageStore.mode`:
 *
 *   mode === 'edit'                → EditChromeRoot
 *   mode === 'playback' / 'autonomous' → PlaybackChromeRoot
 *
 * The two roots are wholly independent. Stage's only responsibilities
 * are: mode dispatch, edit-lock coordination (cross-tab), Pro Switch
 * toggle wiring (calls into PlaybackChromeRoot.teardown via ref before
 * flipping mode), and rendering the cross-tab conflict prompt (which
 * needs to be mountable from playback mode too, since the lock-conflict
 * dialog can surface when Pro Switch is clicked but acquire fails).
 */
export function Stage({
  onRetryOutline,
  onPauseGeneration,
}: {
  onRetryOutline?: (outlineId: string) => Promise<void>;
  onPauseGeneration?: () => void;
}) {
  const { mode, setMode, scenes, currentSceneId, generatingOutlines, generationStatus, stage } =
    useStageStore();
  const currentScene = useStageStore((s) => s.getCurrentScene());
  const [pendingSceneFeedback, setPendingSceneFeedback] = useState<SceneFeedbackIntent | null>(
    null,
  );

  // Predicate for "can the user enter Pro mode for the current scene?".
  // Single source of truth feeds the Header's Pro Switch state and the
  // auto-exit effect below; keeping them in lock-step prevents an
  // edit-mode entry that would immediately auto-exit.
  const isEditable = isCurrentSceneEditable({
    currentSceneId,
    sceneCount: scenes.length,
    generatingOutlineCount: generatingOutlines.length,
    generationStatus,
    canPauseGeneration: !!onPauseGeneration,
    hasCurrentScene: !!currentScene,
  });

  // Cross-tab edit lock (#571). Lives at this layer because entry must
  // be refused BEFORE the live session is torn down; PlaybackChromeRoot
  // can't own this since it can't refuse its own unmount path.
  const editLock = useEditModeLock(stage?.id);

  const playbackRef = useRef<PlaybackChromeRootHandle>(null);
  const sceneFeedbackSubmissionInFlightRef = useRef(false);

  // Shared playback→edit entry used by both the Pro Switch and current-page
  // feedback. Keeping lock acquisition, generation pause and playback teardown
  // in one path prevents the feedback shortcut from bypassing editor safety.
  const enterEditMode = useCallback(
    async (expectedSceneId?: string): Promise<boolean> => {
      if (mode === 'edit') return true;
      if (!isEditable) return false;
      if (!editLock.acquire()) return false;
      if (generatingOutlines.length > 0) {
        onPauseGeneration?.();
      }
      // Load the editor chunk (fonts + slide surface) BEFORE flipping mode,
      // so the edit chrome animates in with its content already present and
      // the slide surface registered — no mid-animation pop-in / NOOP flash.
      // Runs concurrently with teardown; the import is promise-cached so it's
      // a no-op on subsequent toggles.
      const editorLoad = preloadEditor();
      try {
        await Promise.all([playbackRef.current?.teardown(), editorLoad]);
      } catch (err) {
        // Teardown failed after the cross-tab lock was acquired but before we
        // flipped into edit mode. Release the lock we just took: otherwise it
        // stays HELD while mode stays 'playback', and the release effect (keyed
        // on `mode`) never re-fires, stranding the lock until tab close and
        // blocking this and every other tab from Pro mode. Stay in playback so
        // the failure surfaces rather than half-entering edit mode.
        editLock.release();
        console.error('[Stage] Pro mode entry failed during teardown', err);
        return false;
      }
      // Freeze the page the feedback was created for. If navigation somehow won
      // the race while playback was tearing down, do not send the repair to a
      // different scene.
      if (expectedSceneId && useStageStore.getState().currentSceneId !== expectedSceneId) {
        editLock.release();
        return false;
      }
      setMode('edit');
      return true;
    },
    [editLock, generatingOutlines.length, isEditable, mode, onPauseGeneration, setMode],
  );

  const handleToggleEditMode = useCallback(async () => {
    if (mode === 'edit') {
      setMode('playback');
      return;
    }
    await enterEditMode();
  }, [enterEditMode, mode, setMode]);

  const handleSceneFeedback = useCallback(
    async ({ sceneId, prompt }: SceneFeedbackSubmission): Promise<boolean> => {
      if (sceneFeedbackSubmissionInFlightRef.current) return false;
      sceneFeedbackSubmissionInFlightRef.current = true;

      const state = useStageStore.getState();
      const targetScene = state.getSceneById(sceneId);
      if (
        state.currentSceneId !== sceneId ||
        !targetScene ||
        !getSceneFeedbackKind(targetScene) ||
        !prompt.trim()
      ) {
        sceneFeedbackSubmissionInFlightRef.current = false;
        return false;
      }

      const intent: SceneFeedbackIntent = { id: nanoid(), sceneId, prompt };
      setPendingSceneFeedback(intent);
      try {
        const entered = await enterEditMode(sceneId);
        if (!entered) {
          setPendingSceneFeedback((current) => (current?.id === intent.id ? null : current));
        }
        return entered;
      } finally {
        sceneFeedbackSubmissionInFlightRef.current = false;
      }
    },
    [enterEditMode],
  );

  const handleSceneFeedbackConsumed = useCallback((intentId: string) => {
    setPendingSceneFeedback((current) => (current?.id === intentId ? null : current));
  }, []);

  // Auto-exit edit mode when the current scene becomes uneditable. Entering edit
  // mode pauses later-scene generation first, so a materialized current scene
  // remains repairable even when other outlines are pending.
  useEffect(() => {
    if (mode === 'edit' && !isEditable) {
      setMode('playback');
    }
  }, [mode, isEditable, setMode]);

  // Release the lock whenever we're not in edit mode (covers manual
  // exit, auto-exit, scene becomes uneditable). The hook also self-
  // releases on unmount / tab close.
  const releaseEditLock = editLock.release;
  useEffect(() => {
    if (mode !== 'edit') releaseEditLock();
  }, [mode, releaseEditLock]);

  const toggleHandler = isMaicEditorEnabled() ? handleToggleEditMode : undefined;

  // Mode swap choreography — a clean opacity cross-fade. Both roots layer
  // via `absolute inset-0` so they coexist for the ~280ms window without
  // one popping out before the other arrives. The outgoing root keeps
  // rendering its canvas during exit so `canvasStore` (the shared scale
  // writer) doesn't briefly read zero.
  //
  // Deliberately NO transform (translateY) on these layers: the edit
  // chrome hosts the Pro Switch / settings pill, which morph across the
  // swap via `layoutId`. A transform on this ancestor distorts motion's
  // layout measurement (the pill visibly drifts) and the blurred chrome
  // would repaint its backdrop-filter every frame while translating. A
  // pure fade keeps layout static so the shared elements land precisely.
  return (
    <div className="relative flex flex-1 overflow-hidden">
      <AnimatePresence initial={false}>
        {mode === 'edit' && currentScene ? (
          <motion.div
            key="edit"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: CHROME_EASE }}
            className="absolute inset-0 flex"
          >
            <EditChromeRoot
              scene={currentScene}
              isEditable={isEditable}
              onToggleEditMode={toggleHandler}
              pendingSceneFeedback={pendingSceneFeedback}
              onSceneFeedbackConsumed={handleSceneFeedbackConsumed}
            />
          </motion.div>
        ) : (
          <motion.div
            key="playback"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: CHROME_EASE }}
            className="absolute inset-0 flex"
          >
            <PlaybackChromeRoot
              ref={playbackRef}
              onRetryOutline={onRetryOutline}
              canEnterProMode={isEditable}
              onEnterProMode={toggleHandler}
              onSceneFeedback={handleSceneFeedback}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <MultiTabEditConflictPrompt
        open={editLock.conflictOpen}
        onDismiss={editLock.dismissConflict}
      />
      {/* Keep-alive host for interactive scene iframes (#619). Lives here, above
          the mode-swap subtree, so its iframes survive Pro mode toggles and
          scene switches instead of reloading on every remount. */}
      <InteractiveIframeHost />
    </div>
  );
}
