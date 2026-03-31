---
name: silverbullet
description: SilverBullet notes space — read, write, and sync markdown notes via git. Available when /workspace/extra/silverbullet-space is mounted.
---

# SilverBullet Notes

SilverBullet stores notes as plain markdown files in a git repository.

## Paths (inside container)

| Path | Purpose |
|------|---------|
| `/workspace/extra/silverbullet-space/` | Notes repository root |
| `/workspace/extra/silverbullet-deploy-key` | SSH deploy key for git push/pull |

These paths are only present in groups that have been configured for SilverBullet. Before using them, verify they exist:

```bash
test -d /workspace/extra/silverbullet-space && echo "mounted" || echo "not configured"
```

## Note format

- Each note is a `.md` file. The filename (minus extension) is the note title.
- Filenames use spaces, not hyphens: `Meeting Notes 2026-03-31.md`
- SilverBullet conventions:
  - `#tag` for tags (inline hashtags, not YAML frontmatter)
  - `[[Note Title]]` for wikilinks between notes
  - No required frontmatter — plain markdown is fine

## Git sync

Always pull before reading or writing to get the latest state. After writing, commit and push.

### Auth setup

```bash
export GIT_SSH_COMMAND="ssh -i /workspace/extra/silverbullet-deploy-key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
```

### Pull (before reading/writing)

```bash
export GIT_SSH_COMMAND="ssh -i /workspace/extra/silverbullet-deploy-key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
git -C /workspace/extra/silverbullet-space pull --ff-only
```

### Commit and push (after writing)

```bash
export GIT_SSH_COMMAND="ssh -i /workspace/extra/silverbullet-deploy-key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
git -C /workspace/extra/silverbullet-space add -A
git -C /workspace/extra/silverbullet-space commit -m "notes: <brief description>"
git -C /workspace/extra/silverbullet-space push
```

## Git identity

If git commit fails due to missing identity, set it first:

```bash
git -C /workspace/extra/silverbullet-space config user.email "nanoclaw@local"
git -C /workspace/extra/silverbullet-space config user.name "NanoClaw"
```

## Listing notes

```bash
find /workspace/extra/silverbullet-space -name "*.md" | sort
```

## Searching notes

```bash
grep -rl "search term" /workspace/extra/silverbullet-space --include="*.md"
```
