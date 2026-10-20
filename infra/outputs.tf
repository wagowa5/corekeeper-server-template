output "instance_id" { value = aws_instance.server.id }
output "backup_bucket" { value = aws_s3_bucket.backup.id }
output "world_volume_id" { value = aws_ebs_volume.world.id }
output "stop_automation_document" { value = aws_ssm_document.stop.name }
output "automation_role_arn" { value = aws_iam_role.automation.arn }
output "scheduler_failure_queue" { value = aws_sqs_queue.scheduler_failures.url }
output "windows_auth" {
  value = var.windows_ca_certificate == null ? null : {
    role_arn         = aws_iam_role.windows[0].arn
    trust_anchor_arn = aws_rolesanywhere_trust_anchor.windows[0].arn
    profile_arn      = aws_rolesanywhere_profile.windows[0].arn
  }
}
