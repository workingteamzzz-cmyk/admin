// All configuration comes from environment variables (see .env.example).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency); real environment variables win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: +(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 8080}`).replace(/\/+$/, ''),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  apiKey: env.ANTHROPIC_API_KEY || '',
  // Only for tests or a corporate gateway. Deliberately NOT the SDK's own ANTHROPIC_BASE_URL variable,
  // so an unrelated environment setting can never redirect traffic.
  anthropicBaseUrl: env.CANOPUS_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  outboundProxy: env.CANOPUS_OUTBOUND_PROXY || '', // e.g. http://proxy.kantor.go.id:8080
  adminEmail: env.CANOPUS_ADMIN_EMAIL || '',
  sessionHours: +(env.SESSION_HOURS || 12),
  cookieSecure: bool(env.COOKIE_SECURE, !/^http:\/\/(localhost|127\.0\.0\.1)/.test(env.PUBLIC_URL || 'http://localhost')),
  trustProxy: bool(env.TRUST_PROXY, false),
  maxUploadMb: +(env.MAX_UPLOAD_MB || 25),
};

export const MODELS = {
  prime: { id: 'prime', label: 'Canopus Prime', api: 'claude-opus-5-5', d: 'Most capable, for complex work', fallback: true, search: 'web_search_20260209' },
  core: { id: 'core', label: 'Canopus Core', api: 'claude-sonnet-5-5', d: 'Fast and smart for everyday work', fallback: true, search: 'web_search_20260209' },
  swift: { id: 'swift', label: 'Canopus Swift', api: 'claude-haiku-5-5', d: 'Fastest and most economical', fallback: false, search: 'web_search_20250305' },
};
export const HELPER_MODEL = 'claude-haiku-5-5';
export const EFFORT = { auto: 'medium', fast: 'low', think: 'high' };

// USD per million tokens (Anthropic list prices; used for estimates and budgets only).
export const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
};

export const CLASSIFICATIONS = {
  biasa: { label: 'General (Biasa)', allowed: true },
  terbatas: { label: 'Restricted (Terbatas)', allowed: true },
  rahasia: { label: 'Confidential (Rahasia)', allowed: false },
  sangat_rahasia: { label: 'Top secret (Sangat Rahasia)', allowed: false },
};

export const DEFAULT_SETTINGS = {
  models: ['core', 'swift', 'prime'],
  defaultModel: 'core',
  webSearch: false,
  imageUploads: true,
  redaction: { enabled: true, terms: [] },
  monthlyBudgetUsd: 10,
  orgSkills: [],
  orgPrompts: [],
  retentionDays: 0, // 0 = keep audit/usage forever
};
