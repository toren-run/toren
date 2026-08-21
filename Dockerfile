FROM node:22-slim

WORKDIR /app
RUN corepack enable pnpm

# Manifests first: the install layer caches until dependencies actually change.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.typecheck.json ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/adapters-aws/package.json packages/adapters-aws/
COPY packages/client/package.json packages/client/
COPY packages/console/package.json packages/console/
COPY packages/cli/package.json packages/cli/
COPY examples/research-crew/package.json examples/research-crew/
RUN pnpm install --frozen-lockfile

# Source second: code changes rebuild only from here.
COPY packages ./packages
COPY examples ./examples
RUN pnpm --dir packages/console build

ENTRYPOINT ["node", "packages/cli/bin/toren.js"]
CMD ["dev", "--dir", "examples/research-crew"]
