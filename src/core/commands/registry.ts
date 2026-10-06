import type { CommandSpec } from './types';

/**
 * Slash command catalog (Issue #9), trimmed to the commands the GUI exposes: Gentle AI's
 * `/judgment-day` first, then Pi's own built-ins. Any other "/xxx" the user types is still
 * forwarded verbatim to Pi (see `decideCommandDispatch`), it just is not listed here.
 */
export const COMMANDS: CommandSpec[] = [
  // --- Gentle AI -------------------------------------------------------------------
  {
    id: 'judgment-day',
    name: '/judgment-day',
    aliases: ['/juzgar'],
    description: {
      es: 'Ejecuta una revisión adversarial ciega con dos jueces.',
      en: 'Runs a blind dual-judge adversarial review.',
    },
    origin: 'gentle-ai',
    execution: 'agent',
  },

  // --- Pi Core -------------------------------------------------------------------
  {
    id: 'help',
    name: '/help',
    description: {
      es: 'Muestra la guía de comandos disponibles.',
      en: 'Shows the guide of available commands.',
    },
    origin: 'pi-core',
    execution: 'client',
  },
  {
    id: 'new',
    name: '/new',
    aliases: ['/reset'],
    description: {
      es: 'Inicia una nueva conversación.',
      en: 'Starts a new conversation.',
    },
    origin: 'pi-core',
    execution: 'client',
  },
  {
    id: 'clear',
    name: '/clear',
    description: {
      es: 'Limpia los mensajes de la conversación actual.',
      en: 'Clears the current conversation messages.',
    },
    origin: 'pi-core',
    execution: 'client',
  },
  {
    id: 'export',
    name: '/export',
    argumentHint: '[md|json]',
    description: {
      es: 'Exporta la conversación actual a Markdown o JSON.',
      en: 'Exports the current conversation to Markdown or JSON.',
    },
    origin: 'pi-core',
    execution: 'client',
  },
  {
    id: 'compact',
    name: '/compact',
    description: {
      es: 'Compacta el historial de la sesión.',
      en: 'Compacts the session history.',
    },
    origin: 'pi-core',
    // Deviation (Issue #9 T4): the GUI has no client-side compact-process-view toggle to
    // flip (process grouping in src/core/process-grouping.ts is always-on, not a user
    // setting), so /compact is forwarded to Pi as an agent command instead of being
    // handled client-side.
    execution: 'agent',
  },
  {
    id: 'reload',
    name: '/reload',
    description: {
      es: 'Reconecta la sesión actual con Pi.',
      en: 'Reconnects the current session to Pi.',
    },
    origin: 'pi-core',
    execution: 'client',
  },
  {
    id: 'zen',
    name: '/zen',
    aliases: ['/focus'],
    description: {
      es: 'Activa o desactiva el modo de concentración Zen sin distracciones.',
      en: 'Toggles distraction-free Zen Focus Mode.',
    },
    origin: 'pi-core',
    execution: 'client',
  },
];
