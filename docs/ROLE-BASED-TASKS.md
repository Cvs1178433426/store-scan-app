# Role-Based Work Tasks

## Goal

Build Continuixai Ops around a fast counting workflow without slowing down frontline work.

- On sign-in, show a brief time-of-day greeting and the employee's work for today.
- During the shift, let employees complete assigned work and add short notes.
- When a Store Count session is completed, show that session's accomplishments.
- On sign-out, show completed work, unfinished work, and a positive summary.
- Let managers and administrators maintain daily, weekly, and monthly work by job title.

## First job titles

1. Store Manager
2. Inventory Manager
3. Stock/Count Associate
4. Receiver
5. Cashier/Customer Service
6. Pharmacy Team

Users may have one primary job title in the first version. Multiple job titles can be added later without changing task history.

## Permissions

| Capability | Employee | Manager | Administrator |
| --- | ---: | ---: | ---: |
| View own assigned work | Yes | Yes | Yes |
| Complete own assigned work | Yes | Yes | Yes |
| Add a note to own work | Yes | Yes | Yes |
| Create a personal one-time task | No | Yes | Yes |
| Assign work to another employee | No | Yes | Yes |
| Create or change recurring templates | No | Yes | Yes |
| Reopen completed work | No | Yes | Yes |
| View team completion history | No | Yes | Yes |

Manager authority must be scoped to the manager's organization/site. It must not create a platform-wide administrator.

## Employee experience

### Sign-in welcome

Use the site's configured time zone, not the device clock alone.

- Before 12:00: `Good morning, {firstName}!`
- 12:00 through 16:59: `Good afternoon, {firstName}!`
- 17:00 and later: `Good evening, {firstName}!`

The welcome screen should remain brief and include:

- today's date and site;
- tasks due today;
- overdue tasks;
- high-priority tasks first;
- a `Start My Day` button;
- an immediate `Start Store Count` shortcut when counting work is assigned.

### During the shift

The `My Work` screen groups work into:

- Overdue
- Today
- This week
- Completed today

Each task includes title, instructions, priority, due time/date, recurrence, assignee, completion control, and optional employee note.

### Count completion

After a Store Count session is completed, show:

- locations counted;
- unique products/barcodes counted;
- total units counted;
- session duration;
- exceptions or unidentified products still needing attention.

### Sign-out summary

Before final sign-out, show:

`Here's what you accomplished today. Great job, {firstName}!`

Then show:

- tasks completed today;
- Store Count sessions completed;
- locations, products, and units counted;
- tasks still open;
- overdue tasks;
- the next upcoming task.

Signing out must not silently mark unfinished work complete. Managers decide whether a recurring task remains overdue, rolls forward, or is skipped.

## Starter task directory

These are editable templates, not hard-coded rules. Managers can deactivate, reorder, or replace them.

### Store Manager

**Daily**

- Opening store readiness and safety walk
- Review staffing/call-outs and shift coverage
- Review overdue and high-priority work
- Review receiving, inventory, and count exceptions
- Verify cash-office/register exception follow-up
- Closing recovery, security, and handoff review

**Weekly**

- Review department completion and overdue trends
- Review shrink, damage, returns, and inventory adjustments
- Review upcoming deliveries, promotions, and staffing
- Conduct employee coaching/follow-up
- Review facility and maintenance issues

**Monthly**

- Review inventory accuracy and shrink results
- Review recurring task templates and compliance
- Complete safety/compliance review
- Review employee access and job-title assignments
- Review site performance summary

### Inventory Manager

**Daily**

- Review open count assignments and exceptions
- Check unidentified UPCs and product/location errors
- Review negative, zero, and unusual on-hand exceptions
- Coordinate recounts and inventory adjustments
- Confirm completed counts are reviewed/exported

**Weekly**

- Cycle-count priority departments or locations
- Review high-variance products
- Review inactive/duplicate products and locations
- Review damage, returns, and adjustment activity
- Validate upcoming count schedule

**Monthly**

- Inventory accuracy and variance report
- Product-catalog quality review
- Location-directory audit
- Count completion/compliance review
- Prepare month-end inventory documentation

### Stock/Count Associate

**Daily**

- Review assigned aisles/locations
- Complete assigned counts or recounts
- Report unidentified products and damaged merchandise
- Correct obvious shelf/location organization problems
- Confirm assigned work before shift end

**Weekly**

- Deep count assigned rotating section
- Check shelf labels and location codes
- Review unresolved exceptions from prior counts
- Inspect overstock/reserve locations

**Monthly**

- Participate in scheduled full-category count
- Review scanner/device condition and supplies
- Confirm assigned location map remains accurate

### Receiver

**Daily**

- Review expected deliveries
- Inspect receiving area and equipment
- Verify shipment count and visible damage
- Record shortages, overages, and refused/damaged cases
- Confirm received merchandise is staged or transferred correctly
- Close receiving paperwork and unresolved exceptions

**Weekly**

- Review open receiving discrepancies
- Review return-to-vendor merchandise
- Inspect receiving-area organization and safety
- Reconcile delivery documents with recorded receipts

**Monthly**

- Receiving accuracy review
- Vendor/carrier discrepancy summary
- Receiving equipment and safety inspection
- Review receiving task templates and procedures

### Cashier/Customer Service

**Daily**

- Opening register/workstation readiness
- Verify supplies, bags, receipt paper, and customer-service materials
- Complete assigned front-end recovery and cleanliness checks
- Report pricing, product, or register exceptions
- Complete closing register/workstation handoff

**Weekly**

- Review recurring customer-service issues
- Inspect front-end supplies and reorder needs
- Complete assigned front-end product/location count
- Review return/damage handling reminders

**Monthly**

- Customer-service and front-end readiness review
- Register-area safety/compliance check
- Review recurring supply and inventory exceptions

### Pharmacy Team

Pharmacy templates must remain operational and must not request protected health information in task titles, notes, or attachments.

**Daily**

- Opening pharmacy workstation and supply readiness
- Review assigned non-patient inventory work
- Check designated expiration and return areas
- Review receiving and put-away exceptions
- Complete assigned pharmacy inventory count
- Closing organization and unresolved-work handoff

**Weekly**

- Cycle count assigned pharmacy inventory section
- Review quarantined, damaged, and return-to-vendor inventory
- Check packaging/shipping and general supplies
- Review unresolved product/location exceptions

**Monthly**

- Complete assigned expiration-date audit
- Review pharmacy inventory variance trends
- Validate pharmacy storage-location directory
- Review non-patient inventory task completion

## Proposed data model

### User additions

- `jobTitle`: one of the six first-version job titles, nullable during migration.
- `managerScope`: derived from organization/site membership, not trusted from the client.

### TaskTemplate

- organization/site scope
- job title
- title and instructions
- recurrence: one-time, daily, weekly, monthly
- recurrence configuration and due time
- priority
- active/inactive
- rollover policy: remain overdue, roll forward, or skip
- creator/updater and timestamps

### TaskAssignment

- immutable link to the template version used
- organization/site
- assigned user and job title
- scheduled date and due timestamp
- status: open, in progress, completed, skipped, cancelled
- priority
- completion timestamp/user
- employee note and manager note
- created/updated timestamps

Assignments are materialized ahead of their due date so history remains stable if a template changes later. A unique template/user/scheduled-date key prevents duplicate generation.

## Required invariants and tests

1. An employee cannot read or change another employee's tasks.
2. A manager cannot manage tasks outside authorized organization/site scope.
3. A client-supplied organization, site, assignee, or manager role is never trusted without server-side authorization.
4. Recurrence generation is idempotent and cannot create duplicate assignments.
5. Template changes do not rewrite completed history.
6. Completing a Store Count does not automatically complete unrelated tasks.
7. Sign-out never loses open work or completion history.
8. Site time zone determines greeting, scheduled date, and daily summary boundaries.
9. Pharmacy tasks and notes warn against entering protected health information.
10. Task completion and reopening are auditable.

## Delivery phases

### Phase 1 — foundation

- Add job titles, templates, assignments, permissions, migrations, and API tests.
- Seed the editable starter directory above for the pilot organization/site.

### Phase 2 — employee workflow

- Add welcome screen, My Work screen, task completion/notes, and count-completion achievements.

### Phase 3 — manager workflow

- Add task-template editor, assignments, team status, overdue review, and completion history.

### Phase 4 — sign-out summary and reporting

- Add sign-out summary, daily/weekly/monthly reporting, exports, and configurable recognition messages.

## Acceptance criteria for the first pilot

- A manager assigns a job title to an employee.
- The employee receives the correct recurring tasks without duplicates.
- The welcome screen uses the correct site-local greeting and lists today's/overdue work.
- The employee completes a task and the manager can see it.
- Completing a Store Count produces accurate accomplishments.
- Sign-out accurately separates completed and open work.
- Cross-user, cross-site, and cross-organization access tests pass.
