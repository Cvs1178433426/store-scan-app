# Continuixai Ops

Continuixai Ops is a mobile-first operational work platform for frontline teams and managers. It combines recurring role-based work, manager oversight, daily accomplishment summaries, operational reporting, and a fast store counting workflow in one tenant-scoped application.

## Product structure

- **My Work** — employee home for overdue, today, this-week, and completed work.
- **Team Work** — manager workspace for job titles, recurring templates, one-time assignments, team status, history, and reports.
- **Count** — camera and handheld-scanner-friendly inventory counting workflow.
- **Reports & History** — daily, weekly, and monthly task/count activity with CSV export.
- **Store Scan** — retained only as the name of an assignable frontline task when a site wants that wording; it is not the application identity.

## Operational design

Continuixai Ops is designed for organizations with one or more sites. Operational data is scoped from authenticated organization/site membership rather than tenant identifiers supplied by the client. Task assignments snapshot the title, job title, recurrence, priority, rollover policy, instructions, scheduled date, and due time so later template changes do not rewrite history. Task status changes and reassignments create append-only event records.

Recurring work supports daily, weekly, and monthly templates. Generation is idempotent, site-time-zone aware, and based on the employee's assigned job title. The starter library covers Store Manager, Inventory Manager, Stock/Count Associate, Receiver, Cashier/Customer Service, and Pharmacy Team. Pharmacy task notes include a warning not to enter protected health information.

## Frontline workflow

After sign-in, employees land on **My Work**. The page uses the site's local time for the greeting and daily boundary, surfaces priority and overdue work, lets employees start or complete their own tasks, and supports employee notes. Completed tasks cannot be reopened by employees.

The end-of-day **Daily Summary** shows completed work, open/overdue work, the next upcoming task, and count accomplishments. Signing out does not alter task state.

## Manager workflow

Authorized managers can:

- assign or clear employee job titles;
- install the editable starter task library;
- create/edit/deactivate recurring templates;
- create one-time assignments;
- complete, reopen, skip, cancel, or reassign work;
- add manager notes and inspect recent assignment events;
- view daily/weekly/monthly reports and export CSV.

Manager and employee task endpoints derive organization/site scope from the authenticated user. Cross-tenant access is not accepted through request body/query tenant IDs.

## Count workflow

The count subsystem remains deliberately independent from the work-planning layer. It supports phone camera scanning and keyboard-wedge handheld scanners, product/location workflows, completed-count locking, and count activity reporting. Existing legacy route paths such as `/store-count` may remain for backward compatibility; user-facing navigation calls the capability **Count**.

## Local development

Requirements:

- Node.js 20+
- npm
- PostgreSQL

Install and generate Prisma client:

```bash
npm ci
npm run prisma:generate
```

Run API and web apps in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

Run verification:

```bash
npm test
npm run lint
npm run build
```

Additional source-level gates used for the Continuixai Ops completion work live under `scripts/` and can be run with Node.

## Security notes

Production deployments require strong, independent `JWT_SECRET` and `MFA_ENCRYPTION_KEY` values. MFA uses the issuer **Continuixai Ops**. Do not commit credentials, database passwords, JWT secrets, MFA keys, or third-party API tokens.

Historical database migration directory names are retained because renaming applied migrations is unsafe. Runtime identifiers, deployment configuration, storage keys, and user-facing branding use Continuixai Ops naming.

## Review status

The repository includes a Claude adversarial review brief under `docs/CLAUDE-COMPLETE-REVIEW-BRIEF.md`. A release candidate is not considered verified until dependency-backed API/web tests, lint, production build, migration validation, tenant-integrity checks, and device/scanner pilot checks pass in a network-enabled environment.

## License

See `LICENSE` for the inherited/open-source licensing terms that apply to this codebase.
