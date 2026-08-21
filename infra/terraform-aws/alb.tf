variable "acm_certificate_arn" {
  description = "Optional ACM certificate ARN — when set, the API is also served on HTTPS :443"
  type        = string
  default     = ""
}

resource "aws_security_group" "alb" {
  count  = var.create_alb ? 1 : 0
  name   = "${var.project}-alb"
  vpc_id = local.vpc_id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  dynamic "ingress" {
    for_each = var.acm_certificate_arn == "" ? [] : [1]
    content {
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group_rule" "worker_from_alb" {
  count                    = var.create_alb ? 1 : 0
  type                     = "ingress"
  from_port                = 7433
  to_port                  = 7433
  protocol                 = "tcp"
  security_group_id        = aws_security_group.worker.id
  source_security_group_id = aws_security_group.alb[0].id
}

resource "aws_lb" "api" {
  count              = var.create_alb ? 1 : 0
  name               = "${var.project}-api"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = local.public_subnet_ids
}

resource "aws_lb_target_group" "api" {
  count       = var.create_alb ? 1 : 0
  name        = "${var.project}-api"
  port        = 7433
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"
  health_check {
    path                = "/healthz"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  count             = var.create_alb ? 1 : 0
  load_balancer_arn = aws_lb.api[0].arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }
}

resource "aws_lb_listener" "https" {
  count             = var.create_alb && var.acm_certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.api[0].arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.acm_certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }
}

resource "random_password" "api_token" {
  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "api_token" {
  name_prefix = "${var.project}-api-token-"
}

resource "aws_secretsmanager_secret_version" "api_token" {
  secret_id     = aws_secretsmanager_secret.api_token.id
  secret_string = random_password.api_token.result
}

output "api_url" {
  value = !var.create_alb ? "(no ALB — reach the workers on :7433 inside the VPC, or front them with your own load balancer)" : (
    var.create_cdn ? "https://${aws_cloudfront_distribution.api[0].domain_name}" : "http://${aws_lb.api[0].dns_name}"
  )
}

output "alb_dns" {
  description = "The load balancer's own DNS name — the target for custom-domain CNAMEs when fronting the ALB directly"
  value       = var.create_alb ? aws_lb.api[0].dns_name : "(no ALB)"
}

output "api_token_secret_arn" {
  value = aws_secretsmanager_secret.api_token.arn
}
