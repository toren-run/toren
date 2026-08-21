FROM node:22-slim

WORKDIR /app
RUN corepack enable pnpm

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.typecheck.json ./
COPY packages ./packages
COPY examples ./examples
RUN pnpm install --frozen-lockfile
RUN pnpm --dir packages/console build

ENTRYPOINT ["node", "packages/cli/bin/toren.js"]
CMD ["dev", "--dir", "examples/research-crew"]
