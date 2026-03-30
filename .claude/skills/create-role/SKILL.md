---
name: create-role
description: Create a new role — a subagent configuration for handling specific types of tasks in isolation. Writes container/skills/roles/<name>/SKILL.md.
---

# Create Role

Create a new role that groups can use to handle tasks in isolation via subagents.

## Step 1: Understand what the role does

Use `AskUserQuestion` to ask:
- What kind of tasks will this role handle?
- What tools does it need? (Bash, Read, Write, WebSearch, WebFetch, Glob, Grep, mcp__nanoclaw__* tools, etc.)
- Should it require user confirmation before running? (for roles with broad access or sensitive actions)

## Step 2: Recommend a model

Based on the role's purpose, recommend a model and explain why:

| Use case | Model | Reasoning |
|---|---|---|
| Simple capture, formatting, reminders | `haiku` | Fast and cheap for lightweight tasks |
| Structured work, coding, analysis | `sonnet` | Better reasoning without the cost of opus |
| Deep research, complex planning | `opus` with `thinking: adaptive` | Extended reasoning for tasks that need it |

Present the recommendation and ask the user to confirm or adjust.

## Step 3: Derive the role name

Suggest a short lowercase name with hyphens (e.g. `researcher`, `note-taker`, `code-reviewer`). Confirm with the user.

## Step 4: Write the role file

Write `container/skills/roles/<name>/SKILL.md`:

```
---
name: <name>
description: <one-line description of what this role does and when to use it>
type: role
allowedTools: [<tool1>, <tool2>, ...]
model: <haiku|sonnet|opus>
thinking: adaptive    # only if opus is chosen
always_confirm: <true|false>
---

You are a <role description>. You have been given a specific task to complete in isolation — you do not have access to the group's conversation history.

## Tools

You may only use: <comma-separated tool list>. Do not use any other tools.

## Instructions

<role-specific instructions: what to do, how to do it, what to produce>

## Output

When finished, produce a clear result that the group agent can summarize for the user. Do not send messages to the user directly.
```

Omit `thinking:` unless using `opus`. Omit `effort:` unless the user specifically wants `low` (high-frequency lightweight tasks) or `max` (maximum reasoning depth for opus).

## Step 5: Confirm

Show the user the written file path and a summary of what was created. Remind them that:
- The role is now available to all groups via `container/skills/roles/<name>/`
- To make a group use it, add it under `## Available Roles` in that group's CLAUDE.md
- Groups that already have the dispatch workflow (from `groups/global/CLAUDE.md`) will automatically pick it up once listed
