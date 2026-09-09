export type ProcessRole = 'api' | 'ingress' | 'scheduler' | 'email-worker' | 'probe';

export interface RuntimeConfig {
  role: ProcessRole;
  port: number;
  trustedOrigin?: string;
  publicBaseUrl?: string;
  database?: { user: string; password: string; connectString: string };
  gmail?: { user: string; appPassword: string };
  probeExecutionEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const role = env.PROCESS_ROLE as ProcessRole;
  if (!['api', 'ingress', 'scheduler', 'email-worker', 'probe'].includes(role)) {
    throw new Error('PROCESS_ROLE must be api, ingress, scheduler, email-worker, or probe');
  }
  const config: RuntimeConfig = {
    role,
    port: Number(env.PORT ?? 3000),
    probeExecutionEnabled: env.PROBE_EXECUTION_ENABLED === 'true'
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT is invalid');

  if (role === 'api') {
    if (!env.TRUSTED_ORIGIN?.startsWith('https://') || !env.PUBLIC_BASE_URL?.startsWith('https://')) {
      throw new Error('API requires HTTPS TRUSTED_ORIGIN and PUBLIC_BASE_URL');
    }
    config.trustedOrigin = env.TRUSTED_ORIGIN;
    config.publicBaseUrl = env.PUBLIC_BASE_URL;
  }
  if (role !== 'probe') {
    if (!env.ORACLE_USER || !env.ORACLE_PASSWORD || !env.ORACLE_CONNECT_STRING) {
      throw new Error(`${role} requires Oracle credentials`);
    }
    config.database = {
      user: env.ORACLE_USER,
      password: env.ORACLE_PASSWORD,
      connectString: env.ORACLE_CONNECT_STRING
    };
  }
  if (role === 'email-worker') {
    if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) throw new Error('email-worker requires Gmail app-password credentials');
    config.gmail = { user: env.GMAIL_USER, appPassword: env.GMAIL_APP_PASSWORD };
  }
  if (
    role === 'probe' &&
    [env.ORACLE_USER, env.ORACLE_PASSWORD, env.ORACLE_CONNECT_STRING, env.GMAIL_USER, env.GMAIL_APP_PASSWORD].some(Boolean)
  ) {
    throw new Error('probe role must not receive database or email credentials');
  }
  if (role === 'probe' && config.probeExecutionEnabled) {
    throw new Error('Outbound probing is fail-closed in this MVP until pinned-connect containment is independently validated');
  }
  return config;
}
