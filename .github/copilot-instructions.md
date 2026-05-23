# Copilot Instructions

## Architecture & Tech Stack

This project is a hybrid Flask + React application for uploading MCAP files to AWS S3.

- **Backend (`app/`)**: Python 3.11+ Flask API.
  - Serves the built React frontend from `frontend/dist`.
  - Uses `boto3` for AWS S3 operations.
  - Uses `modaq_toolkit` for MCAP file parsing.
  - Handles file uploads, duplicate detection, and progress tracking via SSE.
- **Frontend (`frontend/`)**: React 19 SPA built with Vite.
  - TypeScript, TailwindCSS, Zustand (state), TanStack Table.
  - Communicates with backend via `/api/*` endpoints.
  - Proxies to backend port 5000 during development.

## Development Workflow

- **Backend**: Run `python app.py` (serves on :5000).
- **Frontend**: Run `cd frontend && npm run dev` (serves on :3000, proxies `/api` to :5000).
- **Production**: Frontend is built to `frontend/dist`, which Flask serves statically.

## Build, Test, and Lint Commands

### Python (Backend)
- **Test**: `pytest tests/ -v` (Single file: `pytest tests/test_mcap_service.py -v`)
- **Lint**: `ruff check app/ tests/`
- **Format**: `ruff format app/ tests/`
- **Type Check**: `mypy app/`

### JavaScript/TypeScript (Frontend)
- **Build**: `cd frontend && npm run build` (outputs to `frontend/dist`)
- **Test**: `cd frontend && npm run test` (Vitest)
- **Lint**: `cd frontend && npm run lint` (Biome)
- **Type Check**: `cd frontend && npm run typecheck`

## Key Conventions

### Branding & UI
- **Organization Name**: National Laboratory of the Rockies (**NLR**). **NEVER** use "NREL".
- **CSS Classes**: Use `nlr-` prefix for custom classes (e.g., `nlr-blue-500` in Tailwind).
- **Icons**: Import icons ONLY from `frontend/src/utils/icons.tsx` (abstraction over lucide-react). Do not import directly from icon libraries.

### Data & S3
- **S3 Paths**: Use Hive partitioning: `year=YYYY/month=MM/day=DD/hour=HH/minute=M0/filename.mcap`.
  - Minutes are bucketed to 10-minute intervals (00, 10, 20...).
- **Timestamps**: Extracted from MCAP files using `MCAPParser` from `modaq_toolkit`.

### Project Structure
- `app/routes/main.py`: Serves the React app (`frontend/dist/index.html`).
- `app/routes/upload.py`: Handles upload logic and SSE progress streams.
- `app/static`: **Legacy/Unused**. Do not use for new frontend code; work in `frontend/`.
