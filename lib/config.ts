import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface ServerConfig {
  name: string;
  region: string;
  instanceType: string;
  containerImage: string;
  worldName: string;
  maxPlayers: number;
  schedulesEnabled: boolean;
  startSchedule: string;
  stopSchedule: string;
  discordParameterArn?: string;
  windowsCaCertificate?: string;
  windowsCertificateCn: string;
}

export function loadConfig(file?: string): ServerConfig {
  const input: Record<string, unknown> = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const keys = new Set(['name', 'region', 'instanceType', 'containerImage', 'worldName',
    'maxPlayers', 'schedulesEnabled', 'startSchedule', 'stopSchedule',
    'discordParameterArn', 'windowsCaCertificateFile', 'windowsCertificateCn']);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) throw new Error(`Unknown config field: ${key}`);
  }
  const config: ServerConfig = {
    name: 'corekeeper', region: 'ap-northeast-1', instanceType: 't3.large',
    containerImage: 'escaping/core-keeper-dedicated:latest', worldName: 'Core Keeper Server',
    maxPlayers: 4, schedulesEnabled: false, startSchedule: 'cron(0 18 * * ? *)',
    stopSchedule: 'cron(0 1 * * ? *)', windowsCertificateCn: 'corekeeper-friend-pc',
    ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'windowsCaCertificateFile')),
  };
  for (const key of ['name', 'region', 'instanceType', 'containerImage', 'worldName',
    'startSchedule', 'stopSchedule', 'windowsCertificateCn'] as const) {
    if (typeof config[key] !== 'string' || !config[key] || /[\r\n]/.test(config[key])) {
      throw new Error(`${key} must be a nonempty single-line string`);
    }
  }
  if (!/^[a-z][a-z0-9-]{2,29}$/.test(config.name)) throw new Error('Invalid name');
  // Bootstrap discovers an EBS device via Nitro NVMe and installs an amd64 AMI.
  if (!/^t3a?\.(small|medium|large|xlarge|2xlarge)$/.test(config.instanceType)) {
    throw new Error('instanceType must be an amd64 Nitro t3/t3a type (small or larger)');
  }
  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < 1 || config.maxPlayers > 16) {
    throw new Error('maxPlayers must be an integer from 1 to 16');
  }
  if (typeof config.schedulesEnabled !== 'boolean') throw new Error('schedulesEnabled must be boolean');
  if (config.discordParameterArn !== undefined &&
      (typeof config.discordParameterArn !== 'string' || !/^arn:[^:]+:ssm:[^:]+:\d{12}:parameter\/.+/.test(config.discordParameterArn))) {
    throw new Error('discordParameterArn must be an SSM parameter ARN, not its value');
  }
  if (input.windowsCaCertificateFile !== undefined) {
    if (typeof input.windowsCaCertificateFile !== 'string') throw new Error('Invalid CA certificate path');
    config.windowsCaCertificate = readFileSync(resolve(dirname(file!), input.windowsCaCertificateFile), 'utf8');
    if (!config.windowsCaCertificate.includes('-----BEGIN CERTIFICATE-----') ||
        config.windowsCaCertificate.includes('PRIVATE KEY')) throw new Error('Supply a public CA certificate only');
  }
  return config;
}
