---
name: add-silverbullet
description: Set up SilverBullet notes integration — stores deploy key, clones the notes repo, and configures the mount allowlist so groups can use the note-keeper role.
---

# Add SilverBullet

Connect NanoClaw to a SilverBullet notes space stored in a git repository. This sets up the host-side infrastructure (deploy key, repo clone, mount allowlist). After this, configure individual groups to use the `note-keeper` role.

## Step 1: Gather inputs

Use `AskUserQuestion` to collect:

1. **Git repo URL** — SSH format (e.g. `git@github.com:user/silverbullet-space.git`)
2. **Local path** for the notes repo clone (e.g. `~/spaces/silverbullet`)
3. **Deploy key** — the private key content (paste directly), or the path to an existing key file on disk

## Step 2: Store the deploy key

```bash
mkdir -p ~/.config/nanoclaw/deploy-keys
```

Write the private key content to `~/.config/nanoclaw/deploy-keys/silverbullet-space` using the Write tool, then set permissions:

```bash
chmod 600 ~/.config/nanoclaw/deploy-keys/silverbullet-space
```

If the user provided a path to an existing key instead of pasting content, copy it:

```bash
cp "<existing-key-path>" ~/.config/nanoclaw/deploy-keys/silverbullet-space
chmod 600 ~/.config/nanoclaw/deploy-keys/silverbullet-space
```

## Step 3: Update mount allowlist

Read `~/.config/nanoclaw/mount-allowlist.json`. If it does not exist, start from this base:

```json
{
  "allowedRoots": [],
  "blockedPatterns": [".ssh", ".gnupg", ".aws", ".azure", "id_rsa", "id_ed25519", "private_key", ".docker", "credentials"],
  "nonMainReadOnly": false
}
```

Add the following two entries to `allowedRoots` (skip any that are already present):

```json
{
  "path": "~/.config/nanoclaw/deploy-keys",
  "allowReadWrite": false,
  "description": "SSH deploy keys for container git access"
},
{
  "path": "<expanded local notes repo parent directory>",
  "allowReadWrite": true,
  "description": "SilverBullet notes space"
}
```

For the notes repo path: use the **parent directory** as the allowed root (e.g. if notes repo is `~/spaces/silverbullet`, add `~/spaces` as the root). Write the updated file back.

## Step 4: Clone or update the repo

Test if the repo is already cloned:

```bash
test -d "<local-path>/.git" && echo "exists" || echo "missing"
```

If missing, clone it:

```bash
GIT_SSH_COMMAND="ssh -i ~/.config/nanoclaw/deploy-keys/silverbullet-space -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
  git clone "<repo-url>" "<local-path>"
```

If it already exists, pull latest:

```bash
GIT_SSH_COMMAND="ssh -i ~/.config/nanoclaw/deploy-keys/silverbullet-space -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
  git -C "<local-path>" pull --ff-only
```

## Step 5: Confirm

Verify the setup:

```bash
echo "=== Deploy key ===" && ls -la ~/.config/nanoclaw/deploy-keys/silverbullet-space
echo "=== Mount allowlist ===" && cat ~/.config/nanoclaw/mount-allowlist.json
echo "=== Notes repo ===" && ls "<local-path>" | head -10
```

## Step 6: Print next steps

Tell the user:

---

**SilverBullet integration is ready.** The `note-keeper` role and `silverbullet` container skill are already in `container/skills/` and will be loaded into all containers automatically.

To give a group access to notes, do both of the following:

**1. Add container mounts to the group**

In your main group chat, ask Andy to register the group with these additional mounts:

```
Register group <group-name> with additionalMounts:
- hostPath: ~/.config/nanoclaw/deploy-keys/silverbullet-space
  containerPath: silverbullet-deploy-key
  readonly: true
- hostPath: <local-notes-path>
  containerPath: silverbullet-space
  readonly: false
```

**2. Add note-keeper to the group's Available Roles**

Edit `groups/<group-folder>/CLAUDE.md` and add under `## Available Roles`:

```
- **note-keeper** — Read, write, and search notes in the SilverBullet space
```

Then restart NanoClaw:
- Linux: `systemctl --user restart nanoclaw`
- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Note on SSH:** The container needs `openssh-client` for git push/pull. It is typically installed as a dependency of `git`. If you get SSH errors, add `openssh-client` to `container/Dockerfile` and rebuild with `./container/build.sh`.

---
