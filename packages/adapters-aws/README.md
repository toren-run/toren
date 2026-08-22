# @toren-run/adapters-aws

AWS bindings for [Toren](https://toren.run): the SQS queue adapter the Fargate workers use in the reference architecture. Locally the queue is plain Postgres; set `TOREN_QUEUE=sqs` with the three queue URLs and the same runtime rides SQS instead. AWS is a binding here, never a requirement.

Installed automatically with the `toren-run` CLI; the matching Terraform module ships inside that package. **Docs:** [toren.run/docs/guides/deploy-aws](https://toren.run/docs/guides/deploy-aws). Apache-2.0.
