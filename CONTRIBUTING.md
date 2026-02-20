# Contributing

Thanks for your interest in improving this project.

## Local setup

1. Install dependencies:
   - `npm install`
2. Create local env file:
   - `Copy-Item .env.example .env`
3. Validate before changes:
   - `npm run check`
   - `npm run verify-config`

## Rules for contributions

- Do not commit secrets, auth tokens, `.env`, or `.state/`.
- Keep changes focused and small.
- Update `README.md` if user-visible behavior changes.
- Add/adjust validation commands when adding features.

## Pull requests

- Describe what changed and why.
- Mention how you tested it.
- Keep unsafe defaults out of PRs.
