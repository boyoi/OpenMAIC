'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, MessageSquareWarning, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';
import type { Scene } from '@/lib/types/stage';
import {
  getSceneFeedbackKind,
  MAX_SCENE_FEEDBACK_LENGTH,
  sanitizeSceneFeedbackReport,
} from '@/lib/agent/client/scene-feedback';

export interface SceneFeedbackSubmission {
  readonly sceneId: string;
  readonly prompt: string;
}

interface SceneFeedbackButtonProps {
  readonly scene: Scene;
  readonly onSubmit: (submission: SceneFeedbackSubmission) => Promise<boolean>;
}

export function SceneFeedbackButton({ scene, onSubmit }: SceneFeedbackButtonProps) {
  const { t } = useI18n();
  const kind = getSceneFeedbackKind(scene);
  const runtimeErrorCount = useSceneRuntimeErrors((s) => s.errors[scene.id]?.length ?? 0);
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!kind || !isMaicEditorEnabled()) return null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const cleanReport = sanitizeSceneFeedbackReport(report);
    if (!cleanReport) {
      setError(t('stage.feedback.empty'));
      return;
    }

    setSubmitting(true);
    setError('');
    const prompt = t(
      kind === 'interactive'
        ? 'stage.feedback.agentPromptInteractive'
        : 'stage.feedback.agentPromptSlide',
      { report: cleanReport },
    );

    let started = false;
    try {
      started = await onSubmit({ sceneId: scene.id, prompt });
    } catch {
      started = false;
    }
    if (!started) {
      setSubmitting(false);
      setError(t('stage.feedback.error'));
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title={t('stage.feedback.buttonTitle')}
        aria-label={t('stage.feedback.button')}
        className="h-9 rounded-full border-amber-200/80 bg-white/70 px-3 text-amber-700 shadow-sm hover:bg-amber-50 hover:text-amber-800 dark:border-amber-700/50 dark:bg-gray-800/70 dark:text-amber-300 dark:hover:bg-amber-900/20"
      >
        <MessageSquareWarning className="size-4" />
        <span className="hidden xl:inline">{t('stage.feedback.button')}</span>
      </Button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!submitting) setOpen(nextOpen);
        }}
      >
        <DialogContent className="max-w-md rounded-lg p-5 sm:p-6">
          <form onSubmit={handleSubmit} className="grid gap-5">
            <DialogHeader>
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-md bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                  <Sparkles className="size-4" />
                </span>
                <DialogTitle>{t('stage.feedback.title')}</DialogTitle>
              </div>
              <DialogDescription className="leading-relaxed">
                {t(
                  kind === 'interactive'
                    ? 'stage.feedback.descriptionInteractive'
                    : 'stage.feedback.descriptionSlide',
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
              <label htmlFor="scene-feedback-report" className="text-sm font-medium">
                {t('stage.feedback.fieldLabel')}
              </label>
              <Textarea
                id="scene-feedback-report"
                value={report}
                onChange={(event) => {
                  setReport(event.target.value);
                  if (error) setError('');
                }}
                maxLength={MAX_SCENE_FEEDBACK_LENGTH}
                disabled={submitting}
                autoFocus
                placeholder={t('stage.feedback.placeholder')}
                className="min-h-28 resize-y"
              />
              {kind === 'interactive' && runtimeErrorCount > 0 ? (
                <p className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {t('stage.feedback.runtimeErrors', { count: runtimeErrorCount })}
                </p>
              ) : null}
              {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => setOpen(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={submitting || report.trim().length === 0}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles />}
                {t(submitting ? 'stage.feedback.entering' : 'stage.feedback.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
