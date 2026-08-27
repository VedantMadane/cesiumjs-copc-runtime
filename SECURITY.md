# Security Policy

## Supported versions

Until the first stable release, security fixes target the latest `0.x` release and
the `main` branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Email `ysm287@gmail.com`
with the affected version, reproduction steps, impact, and any suggested mitigation.
Remove credentials, private URLs, and restricted point-cloud data from the report.

You should receive an acknowledgement within seven days. After validation, the
maintainers will coordinate a fix and disclosure timeline. Please allow reasonable
time for a release before publishing details.

Security-relevant areas include URL and range-request handling, worker messages,
untrusted COPC metadata, persistent cache keys, and demo deployment configuration.
