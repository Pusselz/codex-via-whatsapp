# Open Source Release Checklist

Run this before publishing to GitHub.

## 1) Stop local gateway processes

`taskkill /IM node.exe /F`

## 2) Remove local sensitive runtime data

- delete local env with private values (if present): `.env`
- delete session/runtime data: `.state/`
- ensure no personal number remains in tracked files

## 3) Validate repo content

`npm run check`

`npm run verify-config`

## 4) Quick secret scan (local)

Search for obvious sensitive values:

- phone numbers
- API keys
- auth/session dumps

## 5) Publish

1. Create a GitHub repo (private first recommended).
2. Push and review files online.
3. Switch public when verified.
