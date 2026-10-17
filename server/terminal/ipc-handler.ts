import {
  TERMINAL_COMMANDS,
  type TerminalOpenArgs,
  type TerminalWriteArgs,
  type TerminalResizeArgs,
  type TerminalCloseArgs,
  type TerminalPollArgs,
  type TerminalGetArgs,
} from '../../src/core/terminal';
import { getTerminalManager, type TerminalManager } from './terminal-manager';

const TERMINAL_COMMAND_SET = new Set<string>(Object.values(TERMINAL_COMMANDS));

export function isTerminalCommand(cmd: string): boolean {
  return TERMINAL_COMMAND_SET.has(cmd) || cmd.startsWith('terminal_');
}

export interface TerminalIpcContext {
  owner?: string;
  manager?: TerminalManager;
  signal?: AbortSignal;
}

export async function handleTerminalIpcCommand(
  cmd: string,
  args: any = {},
  context: TerminalIpcContext = {}
): Promise<any> {
  const manager = context.manager || getTerminalManager();
  const payload = args?.payload || args || {};

  switch (cmd) {
    case TERMINAL_COMMANDS.OPEN:
      return await manager.openSession(payload as TerminalOpenArgs, context.owner);

    case TERMINAL_COMMANDS.WRITE:
      manager.writeSession(payload as TerminalWriteArgs, context.owner);
      return { ok: true };

    case TERMINAL_COMMANDS.RESIZE:
      manager.resizeSession(payload as TerminalResizeArgs, context.owner);
      return { ok: true };

    case TERMINAL_COMMANDS.CLOSE:
      await manager.closeSession(payload as TerminalCloseArgs, context.owner);
      return { ok: true };

    case TERMINAL_COMMANDS.POLL:
      return await manager.pollSession(payload as TerminalPollArgs, context.owner, context.signal);

    case TERMINAL_COMMANDS.GET: {
      const getArgs = payload as TerminalGetArgs;
      if (getArgs.id) return manager.getSession(getArgs.id, context.owner);
      if (getArgs.cwd) return manager.getSessionByCwd(getArgs.cwd, context.owner);
      return null;
    }

    case TERMINAL_COMMANDS.LIST:
      return manager.listSessions(context.owner);

    default:
      throw new Error(`Unknown terminal command: ${cmd}`);
  }
}
