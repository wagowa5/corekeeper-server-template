import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Construct } from 'constructs';
import {
  Stack, StackProps, CfnOutput, CfnParameter, Fn, RemovalPolicy, Duration, Tags,
  aws_ec2 as ec2, aws_iam as iam, aws_s3 as s3, aws_ssm as ssm,
  aws_scheduler as scheduler, aws_sqs as sqs, aws_rolesanywhere as rolesanywhere,
} from 'aws-cdk-lib';
import { ServerConfig } from './config';

export interface CoreKeeperStackProps extends StackProps { config: ServerConfig }

export class CoreKeeperStack extends Stack {
  constructor(scope: Construct, id: string, props: CoreKeeperStackProps) {
    super(scope, id, props);
    const c = props.config;
    Tags.of(this).add('Project', c.name);
    Tags.of(this).add('ManagedBy', 'CDK');
    const arn = (service: string, resource: string, account = this.account) =>
      `arn:${this.partition}:${service}:${this.region}:${account}:${resource}`;

    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.77.0.0/16', enableDnsSupport: true, enableDnsHostnames: true,
    });
    const az = Fn.select(0, Fn.getAzs());
    const subnet = new ec2.CfnSubnet(this, 'Subnet', {
      vpcId: vpc.ref, cidrBlock: '10.77.1.0/24', availabilityZone: az, mapPublicIpOnLaunch: true,
    });
    const gateway = new ec2.CfnInternetGateway(this, 'InternetGateway');
    const gatewayAttachment = new ec2.CfnVPCGatewayAttachment(this, 'GatewayAttachment', {
      vpcId: vpc.ref, internetGatewayId: gateway.ref,
    });
    const routeTable = new ec2.CfnRouteTable(this, 'RouteTable', { vpcId: vpc.ref });
    const route = new ec2.CfnRoute(this, 'InternetRoute', {
      routeTableId: routeTable.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: gateway.ref,
    });
    route.addResourceDependency(gatewayAttachment);
    const association = new ec2.CfnSubnetRouteTableAssociation(this, 'RouteAssociation', {
      routeTableId: routeTable.ref, subnetId: subnet.ref,
    });
    const securityGroup = new ec2.CfnSecurityGroup(this, 'ServerSecurityGroup', {
      vpcId: vpc.ref, groupDescription: 'Steam relay outbound only; administration via SSM',
      securityGroupIngress: [],
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
    });
    const bucket = new s3.Bucket(this, 'Backups', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, versioned: true, enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN, autoDeleteObjects: false,
      lifecycleRules: [
        ...['corekeeper/backups/', 'windows/backups/'].map(prefix => ({
          id: prefix.replaceAll('/', '-'), prefix, expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        })),
        { id: 'expired-delete-markers', expiredObjectDeleteMarker: true },
      ],
    });
    const serverRole = new iam.Role(this, 'ServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    serverRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: [bucket.arnForObjects('corekeeper/backups/*')],
    }));
    if (c.discordParameterArn) serverRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [c.discordParameterArn],
    }));
    const profile = new iam.CfnInstanceProfile(this, 'InstanceProfile', { roles: [serverRole.roleName] });
    const world = new ec2.CfnVolume(this, 'WorldVolume', {
      availabilityZone: az, size: 30, volumeType: 'gp3', encrypted: true,
      tags: [{ key: 'Name', value: `${c.name}-world` }],
    });
    world.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const ami = new CfnParameter(this, 'UbuntuAmi', {
      type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
      default: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
    });
    // Use explicit replacements: Fn::Sub would also interpret shell ${...} syntax.
    const templateDir = resolve(__dirname, '../../infra/templates');
    const substitutions: Record<string, string> = {
      volume_id: Fn.join('', Fn.split('-', world.ref)),
      config_b64: Fn.base64(this.toJsonString({
        region: this.region, bucket: bucket.bucketName, image: c.containerImage,
        world_name: c.worldName, max_players: c.maxPlayers,
        discord_parameter_arn: c.discordParameterArn ?? null,
      })),
      backup_b64: readFileSync(resolve(templateDir, 'backup.sh')).toString('base64'),
      launch_b64: readFileSync(resolve(templateDir, 'launch.py')).toString('base64'),
    };
    let userData = readFileSync(resolve(templateDir, 'cloud-init.sh.tpl'), 'utf8');
    for (const [key, value] of Object.entries(substitutions)) {
      userData = userData.split('${' + key + '}').join(value);
    }
    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateData: {
        imageId: ami.valueAsString, instanceType: c.instanceType,
        iamInstanceProfile: { arn: profile.attrArn },
        metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1 },
        blockDeviceMappings: [{ deviceName: '/dev/sda1', ebs: {
          volumeSize: 16, volumeType: 'gp3', encrypted: true, deleteOnTermination: true,
        } }],
        userData: Fn.base64(userData),
      },
    });
    const server = new ec2.CfnInstance(this, 'Server', {
      launchTemplate: { launchTemplateId: launchTemplate.ref, version: launchTemplate.attrLatestVersionNumber },
      subnetId: subnet.ref, securityGroupIds: [securityGroup.attrGroupId],
      tags: [{ key: 'Name', value: c.name }],
    });
    server.addResourceDependency(route);
    server.addResourceDependency(association);
    server.node.addDependency(serverRole);
    new ec2.CfnVolumeAttachment(this, 'WorldAttachment', {
      device: '/dev/sdf', instanceId: server.ref, volumeId: world.ref,
    });
    const instanceArn = arn('ec2', `instance/${server.ref}`);
    const stopDocument = new ssm.CfnDocument(this, 'BackupAndStop', {
      name: `${c.name}-backup-and-stop`, documentType: 'Automation', updateMethod: 'NewVersion',
      content: {
        schemaVersion: '0.3', description: 'Stop EC2 only after a successful consistent S3 backup',
        assumeRole: '{{ AutomationAssumeRole }}',
        parameters: { InstanceId: { type: 'String' }, AutomationAssumeRole: { type: 'String' } },
        mainSteps: [
          { name: 'Backup', action: 'aws:runCommand', timeoutSeconds: 1800, onFailure: 'Abort',
            inputs: { DocumentName: 'AWS-RunShellScript', InstanceIds: ['{{ InstanceId }}'],
              Parameters: { commands: ['/usr/local/sbin/corekeeper-backup --leave-stopped'], executionTimeout: ['1500'] } } },
          { name: 'Stop', action: 'aws:executeAwsApi', onFailure: 'Abort', isEnd: true,
            inputs: { Service: 'ec2', Api: 'StopInstances', InstanceIds: ['{{ InstanceId }}'] } },
        ],
      },
    });
    const automationRole = new iam.Role(this, 'AutomationRole', {
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com', { conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': arn('ssm', 'automation-execution/*') },
      } }),
    });
    automationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [instanceArn, arn('ssm', 'document/AWS-RunShellScript', '')],
    }));
    automationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations', 'ssm:ListCommands', 'ec2:DescribeInstanceStatus'],
      resources: ['*'],
    }));
    automationRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:StopInstances'], resources: [instanceArn] }));
    const group = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: c.name });
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', { conditions: {
        StringEquals: { 'aws:SourceAccount': this.account }, ArnEquals: { 'aws:SourceArn': group.attrArn },
      } }),
    });
    schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:StartInstances'], resources: [instanceArn] }));
    schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:StartAutomationExecution'],
      resources: [arn('ssm', `automation-definition/${stopDocument.ref}:*`)] }));
    schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [automationRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ssm.amazonaws.com' } } }));
    const dlq = new sqs.Queue(this, 'SchedulerFailures', {
      retentionPeriod: Duration.days(14), encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    dlq.grantSendMessages(schedulerRole);
    for (const operation of ['start', 'stop'] as const) {
      const schedule = new scheduler.CfnSchedule(this, `${operation}Schedule`, {
        name: operation, groupName: group.ref,
        state: c.schedulesEnabled ? 'ENABLED' : 'DISABLED',
        scheduleExpression: operation === 'start' ? c.startSchedule : c.stopSchedule,
        scheduleExpressionTimezone: 'Asia/Tokyo', flexibleTimeWindow: { mode: 'OFF' },
        target: {
          arn: `arn:${this.partition}:scheduler:::aws-sdk:${operation === 'start' ? 'ec2:startInstances' : 'ssm:startAutomationExecution'}`,
          roleArn: schedulerRole.roleArn,
          input: this.toJsonString(operation === 'start' ? { InstanceIds: [server.ref] } : {
            DocumentName: stopDocument.ref,
            Parameters: { InstanceId: [server.ref], AutomationAssumeRole: [automationRole.roleArn] },
          }),
          retryPolicy: { maximumRetryAttempts: 0 }, deadLetterConfig: { arn: dlq.queueArn },
        },
      });
      schedule.node.addDependency(schedulerRole, automationRole);
    }
    if (c.windowsCaCertificate) {
      const anchor = new rolesanywhere.CfnTrustAnchor(this, 'WindowsTrustAnchor', {
        name: `${c.name}-windows`, enabled: true,
        source: { sourceType: 'CERTIFICATE_BUNDLE', sourceData: { x509CertificateData: c.windowsCaCertificate } },
      });
      const principal = new iam.ServicePrincipal('rolesanywhere.amazonaws.com', { conditions: {
        ArnEquals: { 'aws:SourceArn': anchor.attrTrustAnchorArn },
        StringEquals: { 'aws:SourceAccount': this.account, 'aws:PrincipalTag/x509Subject/CN': c.windowsCertificateCn },
      } });
      const windowsRole = new iam.Role(this, 'WindowsRole', { assumedBy: principal });
      windowsRole.assumeRolePolicy!.addStatements(new iam.PolicyStatement({
        actions: ['sts:SetSourceIdentity', 'sts:TagSession'], principals: [principal],
      }));
      windowsRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
        resources: [bucket.arnForObjects('windows/backups/*')] }));
      const windowsProfile = new rolesanywhere.CfnProfile(this, 'WindowsProfile', {
        name: `${c.name}-windows`, enabled: true, durationSeconds: 3600, roleArns: [windowsRole.roleArn],
      });
      new CfnOutput(this, 'WindowsRoleArn', { value: windowsRole.roleArn });
      new CfnOutput(this, 'WindowsTrustAnchorArn', { value: anchor.attrTrustAnchorArn });
      new CfnOutput(this, 'WindowsProfileArn', { value: windowsProfile.attrProfileArn });
    }
    new CfnOutput(this, 'InstanceId', { value: server.ref });
    new CfnOutput(this, 'BackupBucket', { value: bucket.bucketName });
    new CfnOutput(this, 'WorldVolumeId', { value: world.ref });
    new CfnOutput(this, 'StopAutomationDocument', { value: stopDocument.ref });
    new CfnOutput(this, 'AutomationRoleArn', { value: automationRole.roleArn });
    new CfnOutput(this, 'SchedulerFailureQueue', { value: dlq.queueUrl });
  }
}
