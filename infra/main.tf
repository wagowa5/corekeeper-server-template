data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_availability_zones" "available" { state = "available" }
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}
locals {
  partition    = data.aws_partition.current.partition
  account      = data.aws_caller_identity.current.account_id
  az           = data.aws_availability_zones.available.names[0]
  instance_arn = "arn:${local.partition}:ec2:${var.region}:${local.account}:instance/${aws_instance.server.id}"
}
resource "aws_vpc" "main" {
  cidr_block           = "10.77.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
}
resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.77.1.0/24"
  availability_zone       = local.az
  map_public_ip_on_launch = true
}
resource "aws_internet_gateway" "main" { vpc_id = aws_vpc.main.id }
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}
resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
resource "aws_security_group" "server" {
  name_prefix = "${var.name}-"
  description = "Steam relay outbound only; administration via SSM"
  ingress     = []
  vpc_id      = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_s3_bucket" "backup" {
  bucket_prefix = "${var.name}-backups-"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_policy" "backup" {
  bucket = aws_s3_bucket.backup.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket     = aws_s3_bucket.backup.id
  depends_on = [aws_s3_bucket_versioning.backup]
  dynamic "rule" {
    for_each = toset(["corekeeper/backups/", "windows/backups/"])
    content {
      id     = replace(rule.value, "/", "-")
      status = "Enabled"
      filter { prefix = rule.value }
      expiration { days = 30 }
      noncurrent_version_expiration { noncurrent_days = 30 }
      abort_incomplete_multipart_upload { days_after_initiation = 1 }
    }
  }
  rule {
    id     = "expired-delete-markers"
    status = "Enabled"
    filter {}
    expiration { expired_object_delete_marker = true }
  }
}
resource "aws_iam_role" "server" {
  name_prefix = "${var.name}-ec2-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "backup" {
  role = aws_iam_role.server.id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([{
    Effect   = "Allow", Action = ["s3:PutObject", "s3:AbortMultipartUpload"],
    Resource = "${aws_s3_bucket.backup.arn}/corekeeper/backups/*"
    }], var.discord_parameter_arn == null ? [] : [{
    Effect = "Allow", Action = ["ssm:GetParameter"], Resource = var.discord_parameter_arn
  }]) })
}
resource "aws_iam_instance_profile" "server" { role = aws_iam_role.server.name }
resource "aws_ebs_volume" "world" {
  availability_zone = local.az
  size              = 30
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${var.name}-world" }
  lifecycle { prevent_destroy = true }
}
resource "aws_instance" "server" {
  ami                         = data.aws_ssm_parameter.ubuntu.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.server.id]
  iam_instance_profile        = aws_iam_instance_profile.server.name
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/templates/cloud-init.sh.tftpl", {
    volume_id = replace(aws_ebs_volume.world.id, "-", "")
    config_b64 = base64encode(jsonencode({
      region      = var.region, bucket = aws_s3_bucket.backup.id,
      image       = var.container_image, world_name = var.world_name,
      max_players = var.max_players, discord_parameter_arn = var.discord_parameter_arn
    }))
    backup_b64 = filebase64("${path.module}/templates/backup.sh")
    launch_b64 = filebase64("${path.module}/templates/launch.py")
  })
  root_block_device {
    volume_size = 16
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  tags       = { Name = var.name }
  depends_on = [aws_route_table_association.public, aws_iam_role_policy.backup, aws_iam_role_policy_attachment.ssm]
}
resource "aws_volume_attachment" "world" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.world.id
  instance_id                    = aws_instance.server.id
  stop_instance_before_detaching = true
}
