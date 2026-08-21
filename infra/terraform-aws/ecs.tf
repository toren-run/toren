resource "aws_ecr_repository" "toren" {
  name         = var.project
  force_delete = true
}

locals {
  image = var.image != "" ? var.image : "${aws_ecr_repository.toren.repository_url}:latest"
}

resource "aws_security_group" "worker" {
  name   = "${var.project}-worker"
  vpc_id = local.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.project}-worker"
  retention_in_days = 30
}

data "aws_iam_policy_document" "assume_ecs" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [aws_secretsmanager_secret.database_url.arn, aws_secretsmanager_secret.api_token.arn],
      var.anthropic_api_key == "" ? [] : [aws_secretsmanager_secret.anthropic_api_key[0].arn],
      var.openai_api_key == "" ? [] : [aws_secretsmanager_secret.openai_api_key[0].arn],
      var.telegram_bot_token == "" ? [] : [aws_secretsmanager_secret.telegram_bot_token[0].arn],
      values(var.agent_env_secret_arns),
    )
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs.json
}

data "aws_iam_policy_document" "task_sqs" {
  statement {
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = concat(
      [for q in aws_sqs_queue.main : q.arn],
      [for q in aws_sqs_queue.dlq : q.arn],
    )
  }
}

resource "aws_iam_role_policy" "task_sqs" {
  name   = "sqs"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_sqs.json
}

resource "aws_ecs_cluster" "main" {
  name = var.project
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  # Images are built on Apple Silicon (arm64); Fargate defaults to x86_64
  # without this and the task dies with "exec format error".
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name         = "toren"
      image        = local.image
      command      = ["dev", "--dir", var.agent_dir]
      essential    = true
      portMappings = [{ containerPort = 7433, protocol = "tcp" }]
      environment = concat(
        [
          { name = "TOREN_QUEUE", value = "sqs" },
          { name = "AWS_REGION", value = var.region },
          { name = "TOREN_SQS_URL_ORCHESTRATOR", value = aws_sqs_queue.main["orchestrator"].url },
          { name = "TOREN_SQS_URL_TASKS_SHORT", value = aws_sqs_queue.main["tasks-short"].url },
          { name = "TOREN_SQS_URL_TASKS_LONG", value = aws_sqs_queue.main["tasks-long"].url },
        ],
        var.telegram_allowed_users == "" ? [] : [{ name = "TELEGRAM_ALLOWED_USERS", value = var.telegram_allowed_users }],
      )
      secrets = concat(
        [
          { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
          { name = "TOREN_API_TOKEN", valueFrom = aws_secretsmanager_secret.api_token.arn },
        ],
        var.anthropic_api_key == "" ? [] : [{ name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.anthropic_api_key[0].arn }],
        var.openai_api_key == "" ? [] : [{ name = "OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.openai_api_key[0].arn }],
        var.telegram_bot_token == "" ? [] : [{ name = "TELEGRAM_BOT_TOKEN", valueFrom = aws_secretsmanager_secret.telegram_bot_token[0].arn }],
        [for name, arn in var.agent_env_secret_arns : { name = name, valueFrom = arn }],
      )
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "toren"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.project}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = local.private_subnet_ids
    security_groups = [aws_security_group.worker.id]
  }

  dynamic "load_balancer" {
    for_each = var.create_alb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api[0].arn
      container_name   = "toren"
      container_port   = 7433
    }
  }

  depends_on = [aws_lb_listener.http]
}
