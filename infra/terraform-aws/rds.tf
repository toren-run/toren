resource "aws_db_subnet_group" "main" {
  count      = var.create_db ? 1 : 0
  name       = "${var.project}-db"
  subnet_ids = local.private_subnet_ids
}

resource "aws_security_group" "db" {
  count  = var.create_db ? 1 : 0
  name   = "${var.project}-db"
  vpc_id = local.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.worker.id]
  }
}

resource "random_password" "db" {
  count   = var.create_db ? 1 : 0
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  count                  = var.create_db ? 1 : 0
  identifier             = "${var.project}-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  db_name                = "toren"
  username               = "toren"
  password               = random_password.db[0].result
  db_subnet_group_name   = aws_db_subnet_group.main[0].name
  vpc_security_group_ids = [aws_security_group.db[0].id]
  publicly_accessible    = false
  skip_final_snapshot    = true
}

resource "aws_secretsmanager_secret" "database_url" {
  name_prefix = "${var.project}-database-url-"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  # RDS Postgres 15+ defaults rds.force_ssl=1; node-postgres needs sslmode in
  # the URL or it connects plaintext and is rejected at auth. no-verify because
  # the RDS CA bundle isn't in the image trust store (verify-full is a TODO).
  # With create_db=false the caller supplies the full URL (sslmode included).
  secret_string = var.create_db ? "postgres://toren:${random_password.db[0].result}@${aws_db_instance.main[0].address}:5432/toren?sslmode=no-verify" : var.database_url
}

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  count       = var.anthropic_api_key == "" ? 0 : 1
  name_prefix = "${var.project}-anthropic-key-"
}

resource "aws_secretsmanager_secret_version" "anthropic_api_key" {
  count         = var.anthropic_api_key == "" ? 0 : 1
  secret_id     = aws_secretsmanager_secret.anthropic_api_key[0].id
  secret_string = var.anthropic_api_key
}

resource "aws_secretsmanager_secret" "openai_api_key" {
  count       = var.openai_api_key == "" ? 0 : 1
  name_prefix = "${var.project}-openai-key-"
}

resource "aws_secretsmanager_secret_version" "openai_api_key" {
  count         = var.openai_api_key == "" ? 0 : 1
  secret_id     = aws_secretsmanager_secret.openai_api_key[0].id
  secret_string = var.openai_api_key
}
