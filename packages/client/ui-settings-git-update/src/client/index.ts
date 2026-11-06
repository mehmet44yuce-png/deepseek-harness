/** Upstream-update Settings section over the gitUpdate Remote. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.remote merge and the gitUpdate namespace into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { GitUpdateSection, type GitUpdateSectionInjected } from './GitUpdateSection.tsx'
import { GitUpdateStore } from './store.ts'
import { en, zh, type GitUpdateLocaleKey } from './locales.ts'

export type { GitUpdateSectionInjected, GitUpdateSectionProps } from './GitUpdateSection.tsx'
export type { GitUpdateLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Upstream-update section copy. */
    'settings.gitUpdate': GitUpdateLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.gitUpdate'

/** Services required by the Settings registration and the gitUpdate Remote. */
export const inject = ['slots', 'locale', 'remote', 'remote.gitUpdate']

/**
 * Register the upstream-update section once the settings.section declaration is
 * on the ledger, and bind the two gitUpdate calls where ctx is in scope.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-git-update: dictionaries')

  const t = ctx.locale.bind(NS)
  const controller = new GitUpdateStore({
    status: () => ctx.remote.gitUpdate.status(),
    update: options => ctx.remote.gitUpdate.update(options),
  })
  const injected = (): GitUpdateSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'git-update',
    order: 50,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, GitUpdateSection))
}
