@../AGENTS.md

<!--
  All project rules live in AGENTS.md at the repository root, so that every coding agent reads the
  same source. This file only imports it and applies to Claude Code alone.

  It sits in .claude/ rather than at the root because other tools would otherwise load a root
  CLAUDE.md, resolve the import and end up with AGENTS.md in their context twice. Imports are
  resolved relative to the importing file. Add here only what applies to Claude Code and nothing else.
-->
