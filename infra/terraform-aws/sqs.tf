locals {
  queues = ["orchestrator", "tasks-short", "tasks-long"]
}

resource "aws_sqs_queue" "dlq" {
  for_each = toset(local.queues)
  name     = "${var.project}-${each.key}-dlq"
}

resource "aws_sqs_queue" "main" {
  for_each                   = toset(local.queues)
  name                       = "${var.project}-${each.key}"
  visibility_timeout_seconds = 120
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 5
  })
}
