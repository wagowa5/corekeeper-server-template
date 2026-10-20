mock_provider "aws" {
  override_during = plan
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/mock-role" } }
  mock_resource "aws_sqs_queue" { defaults = { arn = "arn:aws:sqs:ap-northeast-1:123456789012:mock-queue" } }
  mock_resource "aws_s3_bucket" { defaults = { arn = "arn:aws:s3:::mock-backups", id = "mock-backups" } }
  mock_resource "aws_rolesanywhere_trust_anchor" { defaults = { arn = "arn:aws:rolesanywhere:ap-northeast-1:123456789012:trust-anchor/00000000-0000-0000-0000-000000000000" } }

  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_availability_zones" { defaults = { names = ["ap-northeast-1a"] } }
  mock_data "aws_ssm_parameter" { defaults = { value = "ami-0123456789abcdef0" } }
}
run "safe_defaults" {
  command = plan
  assert {
    condition     = length(aws_security_group.server.ingress) == 0
    error_message = "No inbound ports should be opened."
  }
  assert {
    condition     = aws_instance.server.metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 must be required."
  }
  assert {
    condition     = aws_scheduler_schedule.power["stop"].state == "DISABLED"
    error_message = "Schedules must be opt-in."
  }
  assert {
    condition     = length(aws_rolesanywhere_profile.windows) == 0
    error_message = "Windows authentication requires an explicit CA certificate."
  }
  assert {
    condition     = jsondecode(aws_ssm_document.stop.content).mainSteps[0].onFailure == "Abort"
    error_message = "A failed backup must abort the stop workflow."
  }
}
run "windows_and_schedules" {
  command = plan
  variables {
    windows_ca_certificate = "PUBLIC-CA-TEST-FIXTURE"
    schedules_enabled      = true
  }
  assert {
    condition     = length(aws_rolesanywhere_profile.windows) == 1 && aws_scheduler_schedule.power["start"].state == "ENABLED"
    error_message = "Optional Windows and scheduler resources should be enabled."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.windows[0].policy).Statement[0].Action == ["s3:PutObject", "s3:AbortMultipartUpload"]
    error_message = "Windows upload role must not allow reads or deletes."
  }
}
