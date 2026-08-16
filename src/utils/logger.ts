import * as vscode from 'vscode';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Simple output channel logger with a configurable minimum level. */
export class Logger {
  private static channel: vscode.OutputChannel | undefined;

  static init(): void {
    if (!Logger.channel) {
      Logger.channel = vscode.window.createOutputChannel('OpenRouter Maestro');
    }
  }

  static info(message: string, ...args: unknown[]): void {
    Logger.log('info', message, ...args);
  }

  static warn(message: string, ...args: unknown[]): void {
    Logger.log('warn', message, ...args);
  }

  static error(message: string, ...args: unknown[]): void {
    Logger.log('error', message, ...args);
  }

  static debug(message: string, ...args: unknown[]): void {
    Logger.log('debug', message, ...args);
  }

  private static minLevel(): number {
    const configured = vscode.workspace
      .getConfiguration('openrouterMaestro')
      .get<LogLevel>('logLevel', 'info');
    return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
  }

  private static log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[level] < Logger.minLevel()) {
      return;
    }
    if (!Logger.channel) {
      Logger.init();
    }
    const timestamp = new Date().toISOString();
    const extra = args.length > 0 ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
    Logger.channel!.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${message}${extra}`);
  }

  static show(): void {
    Logger.channel?.show();
  }

  static dispose(): void {
    Logger.channel?.dispose();
  }
}
