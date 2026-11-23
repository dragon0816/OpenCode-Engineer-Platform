---
name: oep-skill-creator
description: Draft and review an Agent Skill for OEP from a description, SOP or example. Use when the owner wants reusable assistant instructions.
license: MIT
---

# Create an OEP Skill

Determine the task, the trigger, the inputs and the expected result. Ask about missing details that would change the instructions.

Draft a directory with a `SKILL.md` in UTF-8. Start with YAML frontmatter containing `name` (1–64 lowercase letters, digits or hyphens) and `description` (1–1024 characters). Describe when to use the Skill. Put the steps, checks and examples in the Markdown body. Put optional reference material in neighboring files and refer to it with relative paths.

Check that the instructions are coherent, that the examples contain synthetic inputs, and that each requested operation corresponds to an OEP tool the intended assistant can actually use. Identify which checks still require the owner or a controlled executor. Then show the owner the draft and test cases for approval. The owner can install the folder or ZIP in Capabilities and enable it for a selected assistant.

This OEP guide follows the authoring and review flow in AEP's `aep-skill-creator`.
