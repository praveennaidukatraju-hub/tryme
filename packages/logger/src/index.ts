import { type Logger, type LoggerOptions, pino } from 'pino';

export type { Logger } from 'pino';

const isProd = process.env.NODE_ENV === 'production';

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  base: {
    env: process.env.NODE_ENV ?? 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'password',
      'passwordHash',
      'password_hash',
      'token',
      'accessToken',
      'refreshToken',
      'authorization',
      'cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.secret',
      'CF_ACCESS_CLIENT_SECRET',
      'JWT_SECRET',
      'R2_SECRET_ACCESS_KEY',
    ],
    censor: '[redacted]',
  },
};

const prettyTransport = !isProd
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,env',
        singleLine: false,
      },
    }
  : undefined;

export function createLogger(service: string, extra: Record<string, unknown> = {}): Logger {
  return pino({
    ...baseOptions,
    base: { ...baseOptions.base, service, ...extra },
    ...(prettyTransport ? { transport: prettyTransport } : {}),
  });
}

export const rootLogger = createLogger('root');
