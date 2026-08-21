# Console

The deployment console has a Sessions page: start a conversation with any agent, watch it think, send the next turn when it yields, and close it when you are done. Open conversations live here rather than in the Runs table, because a conversation waiting for you is not a stuck job.

The console is served by the workers themselves at `/console/` behind the deployment's HTTPS URL, so there is nothing extra to run. Sign in with the admin token (the deploy prints a ready link with the token in the URL fragment; it never travels to the server). Sessions started from other channels appear on the same page, tagged `telegram`, `cli`, or `api`, and you can read their transcripts as they grow.

Everything else the console does: watch runs move through their waves live, approve or deny gated tool calls, issue and revoke API keys, manage cron schedules, and inspect each crew's agents, models, and tools (env variable names only, never values).
