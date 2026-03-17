# Stage 1: Build Go bridge
FROM golang:1.22-alpine AS go-builder
RUN apk add --no-cache gcc musl-dev sqlite-dev
WORKDIR /build
COPY bridge/ .
RUN CGO_ENABLED=1 go build -o wactl-bridge .

# Stage 2: Build TS server
FROM node:20-alpine AS ts-builder
WORKDIR /build
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ .
RUN npm run build

# Stage 3: Runtime
FROM node:20-alpine
RUN apk add --no-cache sqlite-libs
WORKDIR /app

COPY --from=go-builder /build/wactl-bridge ./
COPY --from=ts-builder /build/dist ./server/dist/
COPY --from=ts-builder /build/node_modules ./server/node_modules/
COPY --from=ts-builder /build/package.json ./server/

# Copy HTML views into the dist output (they're referenced at runtime)
COPY server/src/admin/views ./server/dist/admin/views/

COPY docker/entrypoint.sh ./
RUN chmod +x wactl-bridge entrypoint.sh

RUN mkdir -p /app/data

EXPOSE 8080 3000
VOLUME ["/app/data"]

CMD ["./entrypoint.sh"]
