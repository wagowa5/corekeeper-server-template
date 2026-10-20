import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CoreKeeperStack } from '../lib/corekeeper-stack';
import { loadConfig, ServerConfig } from '../lib/config';

function synth(overrides: Partial<ServerConfig> = {}) {
  return Template.fromStack(new CoreKeeperStack(new App(), 'Test', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    config: { ...loadConfig(), ...overrides },
  }));
}

test('outbound-only network, IMDSv2 and retained encrypted data', () => {
  const t = synth();
  t.resourceCountIs('AWS::EC2::Instance', 1);
  t.resourceCountIs('AWS::EC2::NatGateway', 0);
  const groups = Object.values(t.findResources('AWS::EC2::SecurityGroup'));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].Properties.SecurityGroupIngress ?? [], []);
  t.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({ MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1 } }),
  });
  t.hasResource('AWS::EC2::Volume', {
    DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
    Properties: Match.objectLike({ Encrypted: true, Size: 30, VolumeType: 'gp3' }),
  });
  t.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
    Properties: Match.objectLike({ VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true,
        IgnorePublicAcls: true, RestrictPublicBuckets: true } }),
  });
  t.hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: 'corekeeper/backups/', ExpirationInDays: 30 })]) },
  });
  t.resourceCountIs('AWS::RolesAnywhere::Profile', 0);
});

test('stop runs backup first and aborts on failure; schedules are opt-in', () => {
  const t = synth();
  t.hasResourceProperties('AWS::SSM::Document', { Content: Match.objectLike({ mainSteps: [
    Match.objectLike({ name: 'Backup', action: 'aws:runCommand', onFailure: 'Abort',
      inputs: Match.objectLike({ Parameters: Match.objectLike({ commands: ['/usr/local/sbin/corekeeper-backup --leave-stopped'] }) }) }),
    Match.objectLike({ name: 'Stop', action: 'aws:executeAwsApi', inputs: Match.objectLike({ Api: 'StopInstances' }) }),
  ] }) });
  const schedules = Object.values(t.findResources('AWS::Scheduler::Schedule'));
  assert.equal(schedules.length, 2);
  for (const s of schedules) {
    assert.equal(s.Properties.State, 'DISABLED');
    assert.equal(s.Properties.ScheduleExpressionTimezone, 'Asia/Tokyo');
    assert.equal(s.Properties.Target.RetryPolicy.MaximumRetryAttempts, 0);
    assert.ok(s.Properties.Target.DeadLetterConfig);
  }
});

test('Windows authentication is restricted by anchor and certificate CN, upload only', () => {
  const t = synth({ windowsCaCertificate: '-----BEGIN CERTIFICATE-----\nPUBLIC-TEST-FIXTURE\n-----END CERTIFICATE-----', schedulesEnabled: true });
  t.resourceCountIs('AWS::RolesAnywhere::TrustAnchor', 1);
  t.hasResourceProperties('AWS::RolesAnywhere::Profile', { Enabled: true, DurationSeconds: 3600 });
  const roles = t.findResources('AWS::IAM::Role');
  const windows = Object.entries(roles).find(([id]) => id.startsWith('WindowsRole'))!;
  for (const statement of windows[1].Properties.AssumeRolePolicyDocument.Statement) {
    assert.ok(statement.Condition.ArnEquals['aws:SourceArn']);
    assert.equal(statement.Condition.StringEquals['aws:PrincipalTag/x509Subject/CN'], 'corekeeper-friend-pc');
  }
  const policy = Object.entries(t.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('WindowsRole'))![1];
  const statements = policy.Properties.PolicyDocument.Statement;
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Action, ['s3:PutObject', 's3:AbortMultipartUpload']);
  assert.match(JSON.stringify(statements[0].Resource), /windows\/backups\/\*/);
  for (const s of Object.values(t.findResources('AWS::Scheduler::Schedule'))) assert.equal(s.Properties.State, 'ENABLED');
});

// Resolve only intrinsics present in user data, using fake deployment IDs.
function evaluate(value: any): any {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(evaluate);
  if (value.Ref) return value.Ref === 'AWS::Region' ? 'ap-northeast-1' :
    value.Ref === 'WorldVolume' ? 'vol-0123456789abcdef0' : 'test-backups';
  if (value['Fn::Join']) return evaluate(value['Fn::Join'][1]).join(value['Fn::Join'][0]);
  if (value['Fn::Split']) return evaluate(value['Fn::Split'][1]).split(value['Fn::Split'][0]);
  if (value['Fn::Base64']) return Buffer.from(evaluate(value['Fn::Base64'])).toString('base64');
  throw new Error(`Unhandled intrinsic: ${JSON.stringify(value)}`);
}

test('rendered bootstrap preserves scripts and JSON, passes bash syntax and fits EC2 user-data limit', () => {
  const t = synth({ worldName: "Friends' world", discordParameterArn: 'arn:aws:ssm:ap-northeast-1:123456789012:parameter/corekeeper/discord' });
  const launch = Object.values(t.findResources('AWS::EC2::LaunchTemplate'))[0];
  const script = Buffer.from(evaluate(launch.Properties.LaunchTemplateData.UserData), 'base64').toString();
  assert.ok(Buffer.byteLength(script) <= 16384);
  assert.ok(!script.includes('${config_b64}'));
  const configMatch = script.match(/printf '%s' '([^']+)' \| base64 -d > \/etc\/corekeeper\/config.json/)!;
  const config = JSON.parse(Buffer.from(configMatch[1], 'base64').toString());
  assert.equal(config.world_name, "Friends' world");
  assert.match(config.discord_parameter_arn, /parameter\/corekeeper\/discord$/);
  assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
  for (const name of ['backup.sh', 'launch.py']) {
    assert.ok(script.includes(readFileSync(resolve('infra/templates', name)).toString('base64')));
  }
});

test('config rejects type errors, unknown fields, ARM and private keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corekeeper-config-'));
  try {
    const file = join(dir, 'config.json');
    for (const input of [{ schedulesEnabled: 'false' }, { maxPlayers: 0 },
      { instanceType: 't4g.large' }, { webhook: 'secret' }, { worldName: 'bad\nvalue' }]) {
      writeFileSync(file, JSON.stringify(input));
      assert.throws(() => loadConfig(file));
    }
    writeFileSync(join(dir, 'ca.pem'), '-----BEGIN PRIVATE KEY-----');
    writeFileSync(file, JSON.stringify({ windowsCaCertificateFile: 'ca.pem' }));
    assert.throws(() => loadConfig(file), /public CA/);
  } finally { rmSync(dir, { recursive: true }); }
});
