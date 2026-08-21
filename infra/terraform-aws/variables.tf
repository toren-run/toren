variable "region" {
  description = "AWS region to deploy into"
  type        = string
}

variable "aws_profile" {
  description = "AWS shared-config profile to deploy with (empty = default credential chain)"
  type        = string
  default     = ""
}

variable "project" {
  description = "Name prefix for all resources"
  type        = string
  default     = "toren"
}

variable "image" {
  description = "Toren container image URI (ECR). Leave default to use the repo this module creates with tag :latest."
  type        = string
  default     = ""
}

variable "agent_dir" {
  description = "Agent directory (inside the image) the worker serves"
  type        = string
  default     = "examples/research-crew"
}

variable "worker_count" {
  description = "Number of Fargate worker tasks"
  type        = number
  default     = 2
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "anthropic_api_key" {
  description = "Anthropic API key for the workers (stored in Secrets Manager). Empty disables the secret."
  type        = string
  default     = ""
  sensitive   = true
}

variable "create_vpc" {
  description = "Create a dedicated VPC (true) or deploy into an existing one (false — set vpc_id and the subnet id lists)"
  type        = bool
  default     = true
}

variable "vpc_id" {
  description = "Existing VPC id (required when create_vpc = false)"
  type        = string
  default     = ""
}

variable "private_subnet_ids" {
  description = "Existing private subnet ids for workers and the DB (required when create_vpc = false)"
  type        = list(string)
  default     = []
}

variable "public_subnet_ids" {
  description = "Existing public subnet ids for the ALB (required when create_vpc = false and create_alb = true)"
  type        = list(string)
  default     = []
}

variable "create_db" {
  description = "Create a dedicated RDS Postgres (true) or use an existing Postgres (false — set database_url)"
  type        = bool
  default     = true
}

variable "database_url" {
  description = "Connection URL to an existing Postgres (required when create_db = false). Include sslmode as your server needs, e.g. ?sslmode=no-verify for RDS. Toren keeps to its own schemas — a dedicated database on a shared instance is recommended. Allow the worker security group (output worker_security_group_id) on :5432."
  type        = string
  default     = ""
  sensitive   = true
}

variable "create_alb" {
  description = "Create a public ALB for the HTTP API (false = front the workers with your own ingress, or keep the API VPC-internal)"
  type        = bool
  default     = true
}

variable "enable_autoscaling" {
  description = "Auto-scale the worker service on average CPU instead of a fixed worker_count"
  type        = bool
  default     = false
}

variable "autoscaling_min" {
  description = "Minimum worker tasks when autoscaling"
  type        = number
  default     = 1
}

variable "autoscaling_max" {
  description = "Maximum worker tasks when autoscaling"
  type        = number
  default     = 4
}

variable "autoscaling_cpu_target" {
  description = "Average CPU percent the scaler holds the worker service at"
  type        = number
  default     = 60
}

variable "openai_api_key" {
  description = "OpenAI API key for the workers (stored in Secrets Manager). Empty disables the secret."
  type        = string
  default     = ""
  sensitive   = true
}

variable "agent_env_secret_arns" {
  description = "Map of env-var name -> Secrets Manager secret ARN, injected into the workers. Pairs with the agent.yaml `env:` declaration — toren never stores these values."
  type        = map(string)
  default     = {}
}

variable "telegram_bot_token" {
  description = "Telegram bot token — enables the Telegram channel on the workers (stored in Secrets Manager). Empty disables it."
  type        = string
  default     = ""
  sensitive   = true
}

variable "telegram_allowed_users" {
  description = "Comma-separated numeric Telegram user IDs allowed without a pairing code (the bot is deny-by-default either way)"
  type        = string
  default     = ""
}
