variable "region" {
  type    = string
  default = "ap-northeast-1"
}
variable "name" {
  type    = string
  default = "corekeeper"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name))
    error_message = "Use 3–30 lowercase letters, digits or hyphens, starting with a letter."
  }
}
variable "instance_type" {
  type    = string
  default = "t3.large"
}
variable "container_image" {
  type        = string
  default     = "escaping/core-keeper-dedicated:latest"
  description = "Prefer an audited immutable sha256 digest. Image must support amd64."
}
variable "world_name" {
  type    = string
  default = "Core Keeper Server"
}
variable "max_players" {
  type    = number
  default = 4
  validation {
    condition     = var.max_players >= 1 && var.max_players <= 16 && floor(var.max_players) == var.max_players
    error_message = "Choose an integer from 1 to 16."
  }
}
variable "schedules_enabled" {
  type        = bool
  default     = false
  description = "Enable only after initial world restore and connection checks."
}
variable "start_schedule" {
  type    = string
  default = "cron(0 18 * * ? *)"
}
variable "stop_schedule" {
  type    = string
  default = "cron(0 1 * * ? *)"
}
variable "discord_parameter_arn" {
  type        = string
  default     = null
  nullable    = true
  description = "Existing SSM SecureString ARN for the Discord webhook; value never enters Terraform. Use the AWS-managed SSM KMS key."
}
variable "windows_ca_certificate" {
  type        = string
  default     = null
  nullable    = true
  description = "Optional public PEM CA certificate. Never supply its private key."
}
variable "windows_certificate_cn" {
  type    = string
  default = "corekeeper-friend-pc"
}
