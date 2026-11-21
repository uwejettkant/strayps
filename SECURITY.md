# Security Policy

strayps terminates and pauses processes on the machine it runs on, and it shows their command lines in a terminal and in a local web dashboard. A flaw in it can cost someone their work or leak a secret from a command line, so reports about security problems are welcome.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting instead: on the repository page, go to **Security** and choose **Report a vulnerability**.

Helpful to include:

- the version (`strayps --version`), the operating system and the Node.js version,
- what you ran and what happened,
- what you expected instead.

Please give the maintainer the chance to publish a fix before you disclose the problem.

## Scope

In scope, for example:

- the local dashboard server and its API: anything that changes state, or that is reachable from a web page or from another machine,
- termination of a process that is not in the monitored list or was not in the confirmation, and pause holding a process outside the agents of the watched repository or leaving one stopped,
- secrets in command lines that are shown instead of `[redacted]`,
- strayps reading or writing a file other than `.strayps.json` in a repository, or following a link there,
- command lines, paths or log messages that end up rendered as markup or as terminal control sequences.

Known limit, documented in the README: another user account on the same machine, or the watched agent itself, can reach the local dashboard.
