#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { CoreKeeperStack } from '../lib/corekeeper-stack';

const app = new App();
const config = loadConfig(process.env.COREKEEPER_CONFIG);
new CoreKeeperStack(app, `${config.name}-stack`, {
  env: { region: config.region, account: process.env.CDK_DEFAULT_ACCOUNT }, config,
});
