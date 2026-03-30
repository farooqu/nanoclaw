# Roles

Each subdirectory here is a role — a subagent configuration that groups can use to handle specific types of tasks in isolation.

## Format

`<name>/SKILL.md` with frontmatter:

```yaml
---
name: <name>
description: <one line — what this role does and when to use it>
type: role
allowedTools: [Bash, Read, Write, WebSearch, ...]
model: haiku | sonnet | opus
effort: low | medium | high | max        # optional
thinking: adaptive | enabled | disabled  # optional
always_confirm: false                    # set true for broad or high-privilege roles
---

<subagent instructions here>
```

## Conventions

- `model` is required. Default to `haiku`; use `sonnet` for structured reasoning; use `opus` with `thinking: adaptive` for deep research or planning.
- `allowedTools` lists what the subagent may use. It is enforced via instructions — the subagent is told it may only use these tools.
- `always_confirm: true` roles ask the user for approval before running.
- The role body is passed verbatim as the subagent's system prompt, followed by the task brief from the group.

## Adding roles

Run `/create-role` from the host to create a new role interactively.
