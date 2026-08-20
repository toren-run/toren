output "queue_urls" {
  value = { for k, q in aws_sqs_queue.main : k => q.url }
}

output "ecr_repository_url" {
  value = aws_ecr_repository.toren.repository_url
}

output "rds_endpoint" {
  value = var.create_db ? aws_db_instance.main[0].address : "(external database — create_db = false)"
}

output "worker_security_group_id" {
  description = "With create_db = false, allow this SG on :5432 in your Postgres security group"
  value       = aws_security_group.worker.id
}

output "database_url_secret_arn" {
  value = aws_secretsmanager_secret.database_url.arn
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service" {
  value = aws_ecs_service.worker.name
}

output "worker_env" {
  description = "Env lines for pointing a local toren CLI at this deployment (DATABASE_URL comes from the secret)"
  value = join("\n", [
    "TOREN_QUEUE=sqs",
    "AWS_REGION=${var.region}",
    "TOREN_SQS_URL_ORCHESTRATOR=${aws_sqs_queue.main["orchestrator"].url}",
    "TOREN_SQS_URL_TASKS_SHORT=${aws_sqs_queue.main["tasks-short"].url}",
    "TOREN_SQS_URL_TASKS_LONG=${aws_sqs_queue.main["tasks-long"].url}",
  ])
}
