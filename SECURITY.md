# Security Policy

agent-leash terminates processes and rewrites files on the machine it runs on. A flaw in it can cost someone their work, so reports about security problems are welcome.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting instead: on the repository page, go to **Security** and choose **Report a vulnerability**.

Helpful to include:

- the version (`agent-leash --version`), the operating system and the Node.js version,
- what you ran and what happened,
- what you expected instead.

Please give the maintainer the chance to publish a fix before you disclose the problem.

## Scope

In scope, for example:

- the local dashboard server and its API: anything reachable from a web page or from another machine,
- a rollback that writes, deletes or reads files outside the watched repository, or reads `.env*` files,
- termination of processes that are not in the monitored list,
- file names, command lines or paths that end up rendered as markup or as terminal control sequences.

Known limit, documented in the README: another user account on the same machine, or the watched agent itself, can reach the local dashboard.
