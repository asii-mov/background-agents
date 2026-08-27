FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mcp-artifact-builder/package.json packages/mcp-artifact-builder/package.json
RUN npm ci --workspace @open-inspect/mcp-artifact-builder
COPY packages/mcp-artifact-builder packages/mcp-artifact-builder
RUN npm run build --workspace @open-inspect/mcp-artifact-builder

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/packages/mcp-artifact-builder/dist ./dist
ENV PORT=8080
USER node
CMD ["node", "dist/server.js"]
