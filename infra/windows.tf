resource "aws_rolesanywhere_trust_anchor" "windows" {
  count   = var.windows_ca_certificate == null ? 0 : 1
  name    = "${var.name}-windows"
  enabled = true
  source {
    source_type = "CERTIFICATE_BUNDLE"
    source_data { x509_certificate_data = var.windows_ca_certificate }
  }
}
resource "aws_iam_role" "windows" {
  count       = var.windows_ca_certificate == null ? 0 : 1
  name_prefix = "${var.name}-windows-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "rolesanywhere.amazonaws.com" },
    Action = ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"],
    Condition = {
      ArnEquals    = { "aws:SourceArn" = aws_rolesanywhere_trust_anchor.windows[0].arn },
      StringEquals = { "aws:SourceAccount" = local.account, "aws:PrincipalTag/x509Subject/CN" = var.windows_certificate_cn }
    }
  }] })
}
resource "aws_iam_role_policy" "windows" {
  count = var.windows_ca_certificate == null ? 0 : 1
  role  = aws_iam_role.windows[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = ["s3:PutObject", "s3:AbortMultipartUpload"], Resource = "${aws_s3_bucket.backup.arn}/windows/backups/*"
  }] })
}
resource "aws_rolesanywhere_profile" "windows" {
  count            = var.windows_ca_certificate == null ? 0 : 1
  name             = "${var.name}-windows"
  enabled          = true
  duration_seconds = 3600
  role_arns        = [aws_iam_role.windows[0].arn]
}
