import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';

/** The approved Google Workspace relay (owner 2026-10-24): fixed, never taken from config. */
export const GOOGLE_SMTP_RELAY = { host: 'smtp-relay.gmail.com', port: 587 } as const;

/**
 * The connection every use of the relay shares: STARTTLS required with a verified certificate, an
 * IPv4 socket (the relay's allowlist is IPv4 only; without an IPv4 route it fails instead of trying
 * IPv6), no credentials, no access to local files or URLs from a message.
 */
export const googleRelayOptions = (ehloName: string): SMTPTransport.Options => ({
  name: ehloName,
  host: GOOGLE_SMTP_RELAY.host,
  port: GOOGLE_SMTP_RELAY.port,
  secure: false,
  localAddress: '0.0.0.0',
  requireTLS: true,
  tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 10_000,
  disableFileAccess: true,
  disableUrlAccess: true,
  logger: false,
  debug: false,
});
