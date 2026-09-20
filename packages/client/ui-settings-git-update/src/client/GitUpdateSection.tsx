/**
 * Git update Settings section: the checkout's upstream relation plus one
 * primary update action. The finished attempt renders its reported steps,
 * backup tags, and message; the section never derives status from the result.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GitUpdateOutcome, GitUpdateResult, GitUpdateStatus, GitUpdateStep,
} from '@deepseek-ai/dsh-host-git-update/types'
import type { GitUpdateLocaleKey } from './locales.ts'
import type { GitUpdateStore } from './store.ts'
import css from './GitUpdateSection.module.css'

/** Injected dependencies of {@link GitUpdateSection} (slot inject face). */
export interface GitUpdateSectionInjected {
  /** Section store, read on mount and refreshed after every attempt. */
  controller: GitUpdateStore
  hooks: {
    /** Section snapshot bound by the UI renderer as useSnapshot. */
    snapshot: GitUpdateStore['store']
  }
}

/** Full component props assembled by the Settings slot renderer. */
export type GitUpdateSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.gitUpdate'>
  & InjectFace<GitUpdateSectionInjected>

type Translate = GitUpdateSectionProps['t']

const OUTCOME_KEYS = {
  'up-to-date': 'outcomeUpToDate',
  updated: 'outcomeUpdated',
  conflict: 'outcomeConflict',
  refused: 'outcomeRefused',
  failed: 'outcomeFailed',
} satisfies Record<GitUpdateOutcome, GitUpdateLocaleKey>

const STEP_KEYS = {
  'working-tree-backup': 'stepWorkingTreeBackup',
  stash: 'stepStash',
  fetch: 'stepFetch',
  'head-backup': 'stepHeadBackup',
  rebase: 'stepRebase',
  'stash-restore': 'stepStashRestore',
  push: 'stepPush',
} satisfies Record<GitUpdateStep['name'], GitUpdateLocaleKey>

const STEP_STATUS_KEYS = {
  ok: 'statusOk',
  skipped: 'statusSkipped',
  failed: 'statusFailed',
} satisfies Record<GitUpdateStep['status'], GitUpdateLocaleKey>

/** One labeled fact row inside a facts list. */
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** The observed checkout relation: branch, upstream, divergence, and cleanliness. */
function StatusFacts({ status, t }: { readonly status: GitUpdateStatus; readonly t: Translate }): ReactNode {
  return (
    <dl className={css.facts}>
      <Fact label={t('branch')}><code>{status.branch}</code></Fact>
      <Fact label={t('upstream')}><code>{status.upstream}</code></Fact>
      <Fact label={t('ahead')}>{String(status.ahead)}</Fact>
      <Fact label={t('behind')}>{String(status.behind)}</Fact>
      <Fact label={t('workTree')}>{status.dirty ? t('workTreeDirty') : t('workTreeClean')}</Fact>
      <Fact label={t('untracked')}>{status.untracked.length === 0 ? t('none') : status.untracked.join(', ')}</Fact>
      <Fact label={t('head')}><code>{status.head}</code></Fact>
      <Fact label={t('upstreamHead')}><code>{status.upstreamHead === '' ? t('none') : status.upstreamHead}</code></Fact>
    </dl>
  )
}

/** The finished attempt: outcome, message, backup tags, and every reported step. */
function ResultPanel({ result, t }: { readonly result: GitUpdateResult; readonly t: Translate }): ReactNode {
  const noTags = result.headBackupTag === undefined && result.workTreeBackupTag === undefined
  return (
    <section className={css.result} data-outcome={result.outcome}>
      <p className={css.outcome}>{t('outcome') + ': ' + t(OUTCOME_KEYS[result.outcome])}</p>
      <p className={css.message}>{t('message') + ': ' + result.message}</p>
      {noTags ? null : (
        <dl className={css.facts}>
          {result.headBackupTag === undefined ? null : (
            <Fact label={t('headBackupTag')}><code>{result.headBackupTag}</code></Fact>
          )}
          {result.workTreeBackupTag === undefined ? null : (
            <Fact label={t('workTreeBackupTag')}><code>{result.workTreeBackupTag}</code></Fact>
          )}
        </dl>
      )}
      <h3 className={css.stepsTitle}>{t('steps')}</h3>
      <ol className={css.steps}>
        {result.steps.map((step, index) => (
          <li className={css.step} key={step.name + ':' + String(index)} data-status={step.status}>
            <span className={css.stepName}>{t(STEP_KEYS[step.name])}</span>
            <span className={css.stepStatus}>{t(STEP_STATUS_KEYS[step.status])}</span>
            <code className={css.stepDetail}>{step.detail}</code>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * Render the upstream-update section: current status, one update action, then
 * the reported steps and backup tags of the finished attempt.
 * @param props - slot-delivered runtime, locale, and inject shares.
 * @returns the section.
 */
export function GitUpdateSection({ controller, useSnapshot, t }: GitUpdateSectionProps): ReactNode {
  const state = useSnapshot(current => current)
  useEffect(() => { void controller.refresh() }, [controller])
  const run = (): void => { void controller.runUpdate() }
  return (
    <div className={css.section} aria-busy={state.running}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {state.status === 'loading' ? <p className={css.status} role="status">{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('loadFailed')}</p>
          {state.error === null ? null : <p className={css.detail}>{state.error}</p>}
          <Button variant="outline" size="sm" onClick={() => { void controller.refresh() }}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {state.current === null ? null : <StatusFacts status={state.current} t={t} />}
      <div className={css.actionRow}>
        <Button variant="primary" disabled={state.running || state.status !== 'ready'} onClick={run}>
          {t('update')}
        </Button>
        {state.running ? <p className={css.status} role="status">{t('running')}</p> : null}
      </div>
      {state.updateError === null ? null : (
        <p className={css.error} role="alert">{t('updateFailed') + ' ' + state.updateError}</p>
      )}
      {state.result === null ? null : <ResultPanel result={state.result} t={t} />}
    </div>
  )
}
