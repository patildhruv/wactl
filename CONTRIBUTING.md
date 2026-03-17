# Contributing to wactl

Thanks for your interest in contributing to wactl!

## Development Setup

### Prerequisites

- Go 1.22+
- Node.js 20+
- SQLite3

### Building

```bash
# Build the Go bridge
cd bridge && go build -o wactl-bridge . && cd ..

# Build the TypeScript server
cd server && npm ci && npm run build && cd ..
```

### Running Locally

1. Copy `.env.example` to `.env` and fill in credentials
2. Start the bridge: `cd bridge && ./wactl-bridge`
3. Start the server: `cd server && npm start`
4. Open the admin panel: `http://localhost:8080`

## Git Workflow

- Create feature branches from `main`
- Use descriptive commit messages: `feat:`, `fix:`, `docs:`, `refactor:`
- Open PRs for review before merging to `main`
- Keep PRs focused on a single feature or fix

## Project Structure

- `bridge/` — Go binary (WhatsApp bridge via whatsmeow)
- `server/` — TypeScript server (MCP, admin panel, CLI, updater)
- `docker/` — Docker deployment files
- `scripts/` — Installation and utility scripts

## Code Style

### Go
- Standard `gofmt` formatting
- Error handling: always check and handle errors
- Keep files focused: one responsibility per file

### TypeScript
- Strict mode enabled
- Avoid `any` types where possible
- Use async/await over raw promises

## Testing

Before submitting a PR, verify:
- Go bridge compiles: `cd bridge && go build -o wactl-bridge .`
- TS server compiles: `cd server && npm run build`
- No type errors

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
