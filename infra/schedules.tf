resource "aws_ssm_document" "stop" {
  name          = "${var.name}-backup-and-stop"
  document_type = "Automation"
  content = jsonencode({
    schemaVersion = "0.3"
    description   = "Stop EC2 only after a successful consistent S3 backup"
    assumeRole    = "{{ AutomationAssumeRole }}"
    parameters = {
      InstanceId           = { type = "String" }
      AutomationAssumeRole = { type = "String" }
    }
    mainSteps = [
      {
        name = "Backup", action = "aws:runCommand", timeoutSeconds = 1800, onFailure = "Abort"
        inputs = {
          DocumentName = "AWS-RunShellScript", InstanceIds = ["{{ InstanceId }}"]
          Parameters   = { commands = ["/usr/local/sbin/corekeeper-backup --leave-stopped"], executionTimeout = ["1500"] }
        }
      },
      {
        name   = "Stop", action = "aws:executeAwsApi", onFailure = "Abort", isEnd = true
        inputs = { Service = "ec2", Api = "StopInstances", InstanceIds = ["{{ InstanceId }}"] }
      }
    ]
  })
}
resource "aws_iam_role" "automation" {
  name_prefix = "${var.name}-automation-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Principal = { Service = "ssm.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnLike = { "aws:SourceArn" = "arn:${local.partition}:ssm:${var.region}:${local.account}:automation-execution/*" } }
  }] })
}
resource "aws_iam_role_policy" "automation" {
  role = aws_iam_role.automation.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "ssm:SendCommand", Resource = [local.instance_arn, "arn:${local.partition}:ssm:${var.region}::document/AWS-RunShellScript"] },
    { Effect = "Allow", Action = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:ListCommands", "ec2:DescribeInstanceStatus"], Resource = "*" },
    { Effect = "Allow", Action = "ec2:StopInstances", Resource = local.instance_arn }
  ] })
}
resource "aws_scheduler_schedule_group" "main" { name = var.name }
resource "aws_iam_role" "scheduler" {
  name_prefix = "${var.name}-scheduler-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnEquals = { "aws:SourceArn" = aws_scheduler_schedule_group.main.arn } }
  }] })
}
resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "ec2:StartInstances", Resource = local.instance_arn },
    { Effect = "Allow", Action = "ssm:StartAutomationExecution", Resource = "arn:${local.partition}:ssm:${var.region}:${local.account}:automation-definition/${aws_ssm_document.stop.name}:*" },
    { Effect = "Allow", Action = "iam:PassRole", Resource = aws_iam_role.automation.arn, Condition = { StringEquals = { "iam:PassedToService" = "ssm.amazonaws.com" } } }
  ] })
}
resource "aws_sqs_queue" "scheduler_failures" {
  name                      = "${var.name}-scheduler-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_iam_role_policy" "scheduler_dlq" {
  role   = aws_iam_role.scheduler.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.scheduler_failures.arn }] })
}
resource "aws_scheduler_schedule" "power" {
  for_each                     = { start = var.start_schedule, stop = var.stop_schedule }
  name                         = each.key
  group_name                   = aws_scheduler_schedule_group.main.name
  state                        = var.schedules_enabled ? "ENABLED" : "DISABLED"
  schedule_expression          = each.value
  schedule_expression_timezone = "Asia/Tokyo"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = each.key == "start" ? "arn:${local.partition}:scheduler:::aws-sdk:ec2:startInstances" : "arn:${local.partition}:scheduler:::aws-sdk:ssm:startAutomationExecution"
    role_arn = aws_iam_role.scheduler.arn
    input = each.key == "start" ? jsonencode({ InstanceIds = [aws_instance.server.id] }) : jsonencode({
      DocumentName = aws_ssm_document.stop.name,
      Parameters   = { InstanceId = [aws_instance.server.id], AutomationAssumeRole = [aws_iam_role.automation.arn] }
    })
    retry_policy { maximum_retry_attempts = 0 }
    dead_letter_config { arn = aws_sqs_queue.scheduler_failures.arn }
  }
  depends_on = [aws_iam_role_policy.scheduler, aws_iam_role_policy.scheduler_dlq, aws_iam_role_policy.automation]
}
